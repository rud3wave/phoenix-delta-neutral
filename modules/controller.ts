// ============================================================
//  CONTROLLER — Delta-neutral strategy execution
// ============================================================
// Leader-follower: leader side places LIMIT (maker) → poll fills
// every 1s (re-place after 2min) → follower side hits MARKET (taker)
// with the exact leader lots.
// Close: leader LIMIT (maker) → follower MARKET (taker).
// Two TG messages: #1 after open, #2 after close with PnL.
// ============================================================

import {
  GROUP_CONFIGS,
  LEVERAGE,
  MIN_LIQ_DISTANCE_PERCENT,
  MAX_SPREAD,
  HOLD_MINUTES,
  TRADES_COUNT,
  DELAY_BETWEEN_TRADES,
  POLL_INTERVAL_SEC,
  TOKENS_TO_TRADE,
  RETRY,
  EXECUTION_MODE,
} from '../settings.js';
import { distributeWithCaps, sideNotionalBounds } from './allocation.js';
import { PhoenixService } from './phoenix-service.js';
import { closeLeaderFollower } from './close-strategy.js';
import { isTradingHalted } from './runtime-control.js';
import { sendTg } from './telegram.js';
import {
  sleep,
  sleepByRange,
  getRandomNumber,
  isRangeEmpty,
  shuffleArray,
  shortAddr,
  isNetworkError,
} from './utils.js';

// Max proxy rotations per wallet before failures start counting
const MAX_PROXY_ROTATIONS = 2;

// ==================== TYPES ====================

interface GroupAccount {
  service: PhoenixService;
  address: string;
  balance: number;
  balanceBefore: number;
  balanceAfter: number;
  side?: 'long' | 'short';
  orderAmount?: number;
  leverage?: number;
  failures: number;
  proxyRotations: number;
  tradesCompleted: number;
  targetTrades: number;
}

interface ActiveGroup {
  id: string;
  accounts: GroupAccount[];
  srcToken: string;
  groupConfig: readonly number[];
}

// ==================== CONTROLLER ====================

export class DeltaNeutralController {
  private pool: GroupAccount[] = [];
  private proxyPool: string[] = [];
  private isRunning = false;
  private nextGroupId = 1;

  /** Provide the full proxy pool for runtime rotation on network errors */
  public setProxyPool(proxies: string[]): void {
    this.proxyPool = [...new Set(proxies)];
  }

  /** Register a wallet into the pool */
  public register(service: PhoenixService, balance: number): void {
    const account: GroupAccount = {
      service,
      address: service.getAddress(),
      balance,
      balanceBefore: balance,
      balanceAfter: 0,
      failures: 0,
      proxyRotations: 0,
      tradesCompleted: 0,
      targetTrades: TRADES_COUNT,
    };
    this.pool.push(account);
    console.log(`  📥 Registered ${shortAddr(account.address)} | Balance: $${balance.toFixed(2)} | Target trades: ${account.targetTrades}`);
  }

  /**
   * Handle an account failure.
   * Network-level errors rotate the proxy (up to MAX_PROXY_ROTATIONS) instead
   * of counting a failure; anything else increments the failure counter.
   */
  private async handleFailure(acc: GroupAccount, e: any): Promise<void> {
    if (
      isNetworkError(e) &&
      acc.proxyRotations < MAX_PROXY_ROTATIONS &&
      this.proxyPool.length > 1
    ) {
      const current = acc.service.getProxyUrl();
      const candidates = this.proxyPool.filter((p) => p !== current);
      if (candidates.length > 0) {
        const next = candidates[Math.floor(Math.random() * candidates.length)]!;
        acc.proxyRotations++;
        try {
          await acc.service.rotateProxy(next);
          return; // rotated successfully — don't count the failure
        } catch (rotateErr: any) {
          console.log(`  ⚠️ Proxy rotation failed for ${shortAddr(acc.address)}: ${rotateErr.message}`);
        }
      }
    }
    acc.failures++;
  }

  /** Main loop — form groups and execute strategy */
  public async run(): Promise<void> {
    this.isRunning = true;
    console.log(`\n🚀 Delta-neutral controller started | ${this.pool.length} wallet(s) in pool`);

    while (this.isRunning) {
      try {
        if (isTradingHalted()) {
          console.log('\n🛑 Force Close halt received. Controller stopping.');
          this.isRunning = false;
          break;
        }
        // Filter out accounts that finished their trades
        this.pool = this.pool.filter((acc) => {
          if (acc.tradesCompleted >= acc.targetTrades) {
            console.log(`  🏁 ${shortAddr(acc.address)} finished all trades (${acc.tradesCompleted}/${acc.targetTrades})`);
            return false;
          }
          if (acc.failures >= RETRY) {
            console.log(`  ❌ ${shortAddr(acc.address)} exceeded failure limit (${acc.failures})`);
            return false;
          }
          return true;
        });

        if (this.pool.length === 0) {
          console.log('\n✅ All wallets finished. Controller stopping.');
          break;
        }

        // Pick a random group config
        const groupConfig = GROUP_CONFIGS[Math.floor(Math.random() * GROUP_CONFIGS.length)]!;
        const [sideACount, sideBCount] = groupConfig;
        const groupSize = sideACount + sideBCount;

        if (this.pool.length < groupSize) {
          // Check if ANY config can be satisfied
          const canFormGroup = GROUP_CONFIGS.some(([a, b]) => this.pool.length >= a + b);
          if (!canFormGroup) {
            console.log(`\n⚠️ Not enough wallets for any group config (have ${this.pool.length}). Stopping.`);
            break;
          }
          console.log(`  ⏳ Not enough wallets for group [${sideACount},${sideBCount}] (need ${groupSize}, have ${this.pool.length}). Waiting...`);
          await sleep(10);
          continue;
        }

        // Smart group formation: sort by balance, give larger wallets to smaller side
        const sortedPool = [...this.pool].sort((a, b) => b.balance - a.balance);
        const smallerSideCount = Math.min(sideACount, sideBCount);
        const largerSideCount = Math.max(sideACount, sideBCount);

        // Top balances → smaller side (they carry more notional per wallet)
        const smallerSideAccounts = sortedPool.slice(0, smallerSideCount);
        // Remaining → shuffle and pick for larger side
        const restPool = sortedPool.slice(smallerSideCount);
        const shuffledRest = shuffleArray(restPool);
        const largerSideAccounts = shuffledRest.slice(0, largerSideCount);
        const remaining = shuffledRest.slice(largerSideCount);

        // Порядок не важен: стороны назначает calculateAllocation по балансам
        const selected = [...smallerSideAccounts, ...largerSideAccounts];

        // Refresh balances
        console.log('\n  🔄 Refreshing balances...');
        for (const acc of selected) {
          try {
            acc.balance = await acc.service.getUsdcBalance();
            acc.balanceBefore = acc.balance;
          } catch {
            try {
              await acc.service.loginHandler();
              acc.balance = await acc.service.getUsdcBalance();
              acc.balanceBefore = acc.balance;
            } catch {
              acc.balance = 0;
            }
          }
        }

        // Validate balances are sufficient (need at least $1 to trade)
        const canCover = selected.every((acc) => acc.balance >= 1);
        if (!canCover) {
          console.log('  ⚠️ Some wallets have insufficient balance. Returning to pool.');
          this.pool = [...remaining, ...selected];
          await sleep(10);
          continue;
        }

        // Pick token
        const srcToken = TOKENS_TO_TRADE[Math.floor(Math.random() * TOKENS_TO_TRADE.length)]!;

        const groupId = String(this.nextGroupId++);
        const group: ActiveGroup = {
          id: groupId,
          accounts: selected,
          srcToken,
          groupConfig,
        };

        console.log(`\n${'='.repeat(60)}`);
        console.log(`📦 Group ${groupId} | ${srcToken} | Config: [${sideACount}L, ${sideBCount}S]`);
        console.log(`${'='.repeat(60)}`);

        // Execute strategy
        await this.executeStrategy(group);

        // Return surviving accounts to pool
        this.pool = [...remaining, ...selected.filter((acc) => acc.failures < RETRY && acc.tradesCompleted < acc.targetTrades)];

        // Delay between cycles
        if (!isRangeEmpty(DELAY_BETWEEN_TRADES)) {
          await sleepByRange(DELAY_BETWEEN_TRADES, 'Delay between cycles');
        }
      } catch (e: any) {
        console.log(`\n❌ Controller error: ${e.message}`);
        await sleep(5);
      }
    }
  }

  public stop(): void {
    this.isRunning = false;
  }

  // ==================== STRATEGY EXECUTION ====================

  private async executeStrategy(group: ActiveGroup): Promise<void> {
    const { srcToken, accounts, groupConfig } = group;
    const [longCount] = groupConfig;

    try {
      // Step 1: Wait for acceptable spread
      const maxSpread = MAX_SPREAD > 0 ? MAX_SPREAD : 0.05;
      const { midPrice } = await accounts[0]!.service.waitForSpread(
        srcToken, maxSpread, POLL_INTERVAL_SEC, 180
      );

      // Step 2: Calculate position allocation
      this.calculateAllocation(accounts, longCount, srcToken);

      const longAccounts = accounts.filter((a) => a.side === 'long');
      const shortAccounts = accounts.filter((a) => a.side === 'short');
      const longTotal = longAccounts.reduce((s, a) => s + (a.orderAmount ?? 0), 0);
      const shortTotal = shortAccounts.reduce((s, a) => s + (a.orderAmount ?? 0), 0);

      console.log(`  📊 ${srcToken} | LONG(${longAccounts.length}): $${longTotal.toFixed(2)} | SHORT(${shortAccounts.length}): $${shortTotal.toFixed(2)} | Mid: $${midPrice.toFixed(2)}`);

      // Step 3: Leader-follower execution
      await this.executeLeaderFollower(group, srcToken);

      // Step 4: Mark trades completed
      for (const acc of accounts) {
        acc.tradesCompleted++;
      }

      console.log(`\n  ✅ Group ${group.id} cycle completed`);
    } catch (e: any) {
      console.log(`\n  ❌ Strategy failed: ${e.message}`);
      console.log('  🚨 Closing positions: leader LIMIT → follower MARKET...');
      try {
        // Та же схема, что и штатное закрытие: лидер — лимитки, вторая сторона — маркет
        const biggest = [...accounts].sort((a, b) => (b.orderAmount ?? 0) - (a.orderAmount ?? 0))[0];
        const limitSide = biggest?.side ?? 'long';
        const marketSide = limitSide === 'long' ? 'short' : 'long';
        await closeLeaderFollower(
          accounts.filter((acc) => acc.side === limitSide),
          accounts.filter((acc) => acc.side === marketSide),
          srcToken
        );
        console.log('  ✅ Cleanup complete');
      } catch (cleanupError: any) {
        console.log(`  ⚠️ Cleanup incomplete: ${cleanupError.message}`);
      }

      for (const acc of accounts) {
        await this.handleFailure(acc, e);
      }
    }
  }

  // ==================== ALLOCATION ====================

  /**
   * Дельта-нейтральная аллокация: суммарный notional LONG == SHORT,
   * эффективное плечо каждого кошелька ∈ [min, max].
   *
   * Решается напрямую за один проход (без перебора):
   * 1. допустимый общий notional = пересечение возможностей сторон;
   * 2. случайный total внутри пересечения;
   * 3. распределение по кошелькам с точной суммой (distributeWithCaps).
   */
  private calculateAllocation(accounts: GroupAccount[], longCount: number, token: string): void {
    const levRange = LEVERAGE[token as keyof typeof LEVERAGE];
    if (!levRange) {
      throw new Error(`LEVERAGE для ${token} не задан — добавь ${token}: [мин, макс] в settings.ts`);
    }
    const minLev = levRange[0];
    const maxLev = Math.min(levRange[1], 100 / MIN_LIQ_DISTANCE_PERCENT);
    if (maxLev < minLev) {
      throw new Error(
        `${token}: плечо от ${minLev}x недостижимо при MIN_LIQ_DISTANCE_PERCENT=` +
        `${MIN_LIQ_DISTANCE_PERCENT} (потолок ${maxLev.toFixed(1)}x)`
      );
    }

    // --- Стороны: меньшинство получает крупные кошельки (риск равномерный) ---
    const shortCount = accounts.length - longCount;
    const minorityIsLong = longCount <= shortCount;
    const minorityCount = Math.min(longCount, shortCount);

    const sorted = [...accounts].sort((a, b) => b.balance - a.balance);
    sorted.forEach((acc, index) => {
      const inMinority = index < minorityCount;
      acc.side = inMinority === minorityIsLong ? 'long' : 'short';
    });

    const longSide = accounts.filter((acc) => acc.side === 'long');
    const shortSide = accounts.filter((acc) => acc.side === 'short');

    // --- Общий notional: пересечение возможностей двух сторон ---
    const range = { min: minLev, max: maxLev };
    const longBounds = sideNotionalBounds(longSide.map((acc) => acc.balance), range);
    const shortBounds = sideNotionalBounds(shortSide.map((acc) => acc.balance), range);
    const lo = Math.max(longBounds.min, shortBounds.min);
    const hi = Math.min(longBounds.max, shortBounds.max);
    if (lo > hi + 1e-9) {
      throw new Error(
        `Группа не сводится в вилку при плече ${minLev}-${maxLev}x: ` +
        `LONG тянет $${longBounds.min.toFixed(0)}-${longBounds.max.toFixed(0)}, ` +
        `SHORT тянет $${shortBounds.min.toFixed(0)}-${shortBounds.max.toFixed(0)}. ` +
        `Измени LEVERAGE, MIN_LIQ_DISTANCE_PERCENT или состав кошельков.`
      );
    }

    const total = lo + Math.random() * (hi - lo);

    // --- Распределение по кошелькам каждой стороны ---
    for (const side of [longSide, shortSide]) {
      const caps = side.map((acc) => ({
        min: acc.balance * minLev,
        max: acc.balance * maxLev,
      }));
      const notionals = distributeWithCaps(total, caps);
      side.forEach((acc, index) => {
        acc.orderAmount = notionals[index]!;
        acc.leverage = Math.round((notionals[index]! / acc.balance) * 10) / 10;
      });
    }

    const longTotal = longSide.reduce((s, a) => s + (a.orderAmount ?? 0), 0);
    const shortTotal = shortSide.reduce((s, a) => s + (a.orderAmount ?? 0), 0);
    console.log(
      `  📐 Allocation OK | LONG: $${longTotal.toFixed(2)} | SHORT: $${shortTotal.toFixed(2)} | ` +
      `Δ: $${Math.abs(longTotal - shortTotal).toFixed(2)}`
    );
  }

  // ==================== LEADER-FOLLOWER ====================

  private async executeLeaderFollower(group: ActiveGroup, srcToken: string): Promise<void> {
    const { accounts, groupConfig, id } = group;
    const [longCount] = groupConfig;

    // Determine leader side (biggest order = limit side)
    const biggest = [...accounts].sort((a, b) => (b.orderAmount ?? 0) - (a.orderAmount ?? 0))[0]!;
    const limitSide = biggest.side!;
    const marketSide = limitSide === 'long' ? 'short' : 'long';

    const limitAccounts = accounts.filter((a) => a.side === limitSide);
    const marketAccounts = accounts.filter((a) => a.side === marketSide);

    console.log(`\n  🎯 LEADER: ${limitSide.toUpperCase()} (${limitAccounts.length}) via LIMIT | FOLLOWER: ${marketSide.toUpperCase()} (${marketAccounts.length}) via MARKET`);

    // ========== OPEN ==========
    if (EXECUTION_MODE === 'all-market') {
      await this.openAllMarket(accounts, srcToken);
    } else {
      await this.openLeaderFollower(srcToken, limitSide, marketSide, limitAccounts, marketAccounts);
    }

    // Step 6: Verify positions + log liquidation info
    console.log('\n  🔍 Verifying positions...');
    for (const acc of accounts) {
      try {
        const liq = await acc.service.getPositionWithLiquidation(srcToken);
        if (liq.hasPosition) {
          console.log(
            `  ${acc.side === 'long' ? '🟢' : '🔴'} ${shortAddr(acc.address)} | ` +
            `${liq.side!.toUpperCase()} $${liq.positionUsd.toFixed(2)} | ` +
            `Lev: ${liq.effectiveLeverage.toFixed(1)}x | ` +
            `Liq: ${liq.liqDistancePercent.toFixed(1)}% away`
          );
        }
      } catch {
        // non-critical
      }
    }

    // ========== TG #1: POSITIONS OPENED ==========
    {
      const lines: string[] = [];
      lines.push(`📂 POSITIONS OPENED | Group ${id}`);

      try {
        const snap = await accounts[0]!.service.getMarketSnapshot(srcToken);
        lines.push(`📊 ${srcToken} | Spread: ${snap.spreadPercent.toFixed(4)}% | Mid: $${snap.midPrice.toFixed(2)}`);
      } catch {
        lines.push(srcToken);
      }
      lines.push('');

      for (const acc of accounts) {
        try {
          const liq = await acc.service.getPositionWithLiquidation(srcToken);
          const emoji = acc.side === 'long' ? '🟢' : '🔴';
          const side = acc.side === 'long' ? 'LONG' : 'SHORT';
          lines.push(
            `${emoji} ${side} ${shortAddr(acc.address)} | $${liq.positionUsd.toFixed(2)} | ` +
            `Lev: ${liq.effectiveLeverage.toFixed(1)}x | ` +
            `Liq: ${liq.liqDistancePercent.toFixed(1)}%`
          );
        } catch {
          const emoji = acc.side === 'long' ? '🟢' : '🔴';
          lines.push(`${emoji} ${acc.side === 'long' ? 'LONG' : 'SHORT'} ${shortAddr(acc.address)} | error`);
        }
      }

      const longTotal = accounts.filter((a) => a.side === 'long').reduce((s, a) => s + (a.orderAmount ?? 0), 0);
      const shortTotal = accounts.filter((a) => a.side === 'short').reduce((s, a) => s + (a.orderAmount ?? 0), 0);
      lines.push('');
      lines.push(`🟢 LONG: $${longTotal.toFixed(2)} | 🔴 SHORT: $${shortTotal.toFixed(2)}`);

      await sendTg(lines.join('\n'));
    }

    // ========== HOLD ==========

    if (!isRangeEmpty(HOLD_MINUTES)) {
      const holdMinutes = getRandomNumber(HOLD_MINUTES);
      console.log(`\n  ⏸️ Holding positions for ${holdMinutes.toFixed(1)} min...`);
      const holdUntil = Date.now() + holdMinutes * 60_000;
      while (this.isRunning && Date.now() < holdUntil) {
        if (isTradingHalted()) {
          console.log('  🛑 Hold interrupted by Force Close');
          this.isRunning = false;
          return;
        }
        await sleep(Math.min(5, Math.max(0.1, (holdUntil - Date.now()) / 1000)));
      }
      console.log('  ⏸️ Hold complete');
    } else {
      console.log('\n  ⏸️ Holding indefinitely — close manually via mode 2');
      // Wait until stopped
      while (this.isRunning) {
        if (isTradingHalted()) {
          this.isRunning = false;
          return;
        }
        await sleep(5);
      }
      return;
    }

    // ========== CLOSE — Leader LIMIT first, then Follower MARKET ==========
    await closeLeaderFollower(limitAccounts, marketAccounts, srcToken);

    // ========== TG #2: POSITIONS CLOSED + PnL ==========
    {
      const lines: string[] = [];
      lines.push(`📂 POSITIONS CLOSED | Group ${id}`);
      lines.push('');

      let totalPnl = 0;
      let totalVolume = 0;

      for (const acc of accounts) {
        try {
          const bal = await acc.service.getUsdcBalance();
          acc.balanceAfter = bal;
          const pnl = bal - acc.balanceBefore;
          totalPnl += pnl;
          totalVolume += acc.orderAmount ?? 0;

          const emoji = acc.side === 'long' ? '🟢' : '🔴';
          const side = acc.side === 'long' ? 'LONG' : 'SHORT';
          const pnlSign = pnl >= 0 ? '+' : '';
          const pnlEmoji = pnl >= 0 ? '📈' : '📉';
          lines.push(
            `${emoji} ${side} ${shortAddr(acc.address)} | ${pnlEmoji} PnL: ${pnlSign}${pnl.toFixed(4)}$ | ` +
            `Bal: $${bal.toFixed(2)} | Vol: $${(acc.orderAmount ?? 0).toFixed(2)}`
          );
        } catch {
          const emoji = acc.side === 'long' ? '🟢' : '🔴';
          lines.push(`${emoji} ${acc.side === 'long' ? 'LONG' : 'SHORT'} ${shortAddr(acc.address)} | error`);
        }
      }

      const costPer100k = totalVolume > 0 ? (-totalPnl / totalVolume) * 100000 : 0;
      const pnlSign = totalPnl >= 0 ? '+' : '';
      const totalEmoji = totalPnl >= 0 ? '📈' : '📉';

      lines.push('');
      lines.push(`${totalEmoji} Total PnL: ${pnlSign}${totalPnl.toFixed(4)}$`);
      lines.push(`💰 Total Volume: $${totalVolume.toFixed(2)}`);
      lines.push(` Cost per 100k: ${costPer100k.toFixed(3)}$`);

      await sendTg(lines.join('\n'));
    }
  }

  // ==================== OPEN VARIANTS ====================

  /** all-market: open every wallet by market at once (no maker/taker split). */
  private async openAllMarket(accounts: GroupAccount[], srcToken: string): Promise<void> {
    if (isTradingHalted()) throw new Error('Trading halted by Force Close');
    console.log(`\n  🚀 ALL-MARKET mode — opening ALL ${accounts.length} via MARKET...`);
    await Promise.all(accounts.map(async (acc) => {
      try {
        if (isTradingHalted()) throw new Error('Trading halted by Force Close');
        await acc.service.placePositionOrder({
          instrument: srcToken,
          executionSide: acc.side!,
          executionType: 'market',
          amountUsd: acc.orderAmount!,
        });
        console.log(`  ✅ ${shortAddr(acc.address)} MARKET open filled`);
      } catch (e: any) {
        console.log(`  ❌ MARKET open failed for ${shortAddr(acc.address)}: ${e.message}`);
        await this.handleFailure(acc, e);
      }
    }));
  }

  /** leader-follower: leader LIMIT (maker) → wait full fill → follower MARKET (taker, delta-matched). */
  private async openLeaderFollower(
    srcToken: string,
    limitSide: 'long' | 'short',
    marketSide: 'long' | 'short',
    limitAccounts: GroupAccount[],
    marketAccounts: GroupAccount[]
  ): Promise<void> {
    // Leader places LIMIT orders (parallel)
    console.log(`\n  📋 ${limitSide.toUpperCase()} placing LIMIT orders...`);
    const pendingLeader = new Set(limitAccounts);

    if (isTradingHalted()) throw new Error('Trading halted by Force Close');

    await Promise.all(limitAccounts.map(async (acc) => {
      try {
        await acc.service.placePositionOrder({
          instrument: srcToken,
          executionSide: limitSide,
          executionType: 'limit',
          amountUsd: acc.orderAmount!,
        });
      } catch (e: any) {
        console.log(`  ❌ LIMIT open failed for ${shortAddr(acc.address)}: ${e.message}`);
        await this.handleFailure(acc, e);
      }
    }));

    // Retry loop for leader: poll every 1s up to 2min, then re-place unfilled
    console.log(`  ⏳ Waiting for leader fills (checking every 1s, up to 2min)...`);
    while (pendingLeader.size > 0) {
      let stillWaiting: GroupAccount[] = [];

      for (let i = 0; i < 120 && pendingLeader.size > 0; i++) {
        if (isTradingHalted()) throw new Error('Trading halted by Force Close');
        await sleep(1);

        stillWaiting = [];
        for (const acc of pendingLeader) {
          try {
            const position = await acc.service.getPositionBaseUnits(srcToken);
            if (position > 1e-10) {
              console.log(`  ✅ ${shortAddr(acc.address)} leader FILLED`);
            } else {
              stillWaiting.push(acc);
            }
          } catch {
            stillWaiting.push(acc);
          }
        }

        for (const acc of pendingLeader) {
          if (!stillWaiting.includes(acc)) pendingLeader.delete(acc);
        }
      }

      if (pendingLeader.size === 0) break;

      console.log(`  🔄 ${pendingLeader.size} leader limit(s) unfilled — re-placing...`);
      await Promise.all(stillWaiting.map(async (acc) => {
        try {
          await acc.service.cancelAllOrders(srcToken);
          await acc.service.placePositionOrder({
            instrument: srcToken,
            executionSide: limitSide,
            executionType: 'limit',
            amountUsd: acc.orderAmount!,
          });
        } catch (e: any) {
          console.log(`  ⚠️ Leader re-place failed for ${shortAddr(acc.address)}: ${e.message}`);
        }
      }));
    }

    console.log(`  ✅ All leader limits FILLED`);

    // Cancel remnants on leader side
    await Promise.all(limitAccounts.map(async (acc) => {
      try { await acc.service.cancelAllOrders(srcToken); } catch { /* ok */ }
    }));

    // Read actual leader base units for exact delta matching
    let totalLimitBaseUnits = 0;
    for (const acc of limitAccounts) {
      const units = await acc.service.getPositionBaseUnits(srcToken);
      totalLimitBaseUnits += units;
      console.log(`  📐 ${shortAddr(acc.address)} leader: ${parseFloat(units.toFixed(6))} ${srcToken}`);
    }
    console.log(`  📐 Total LEADER: ${parseFloat(totalLimitBaseUnits.toFixed(6))} ${srcToken}`);

    // Distribute lots proportionally among followers
    const totalFollowerWeight = marketAccounts.reduce((s, a) => s + (a.orderAmount ?? 1), 0);
    const followerBaseUnits = marketAccounts.map((a) => {
      const weight = (a.orderAmount ?? 1) / totalFollowerWeight;
      return totalLimitBaseUnits * weight;
    });

    // Follower places MARKET orders (parallel, exact lot matching)
    console.log(`\n  🚀 ${marketSide.toUpperCase()} placing MARKET orders (delta-matched)...`);
    if (isTradingHalted()) throw new Error('Trading halted by Force Close');
    await Promise.all(marketAccounts.map(async (acc, i) => {
      try {
        await acc.service.placePositionOrder({
          instrument: srcToken,
          executionSide: marketSide,
          executionType: 'market',
          amountUsd: acc.orderAmount!,
          overrideBaseUnits: followerBaseUnits[i],
        });
        console.log(`  ✅ ${shortAddr(acc.address)} follower MARKET filled`);
      } catch (e: any) {
        console.log(`  ❌ MARKET order failed for ${shortAddr(acc.address)}: ${e.message}`);
        await this.handleFailure(acc, e);
      }
    }));
  }
}
