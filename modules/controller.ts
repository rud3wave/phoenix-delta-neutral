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
  MAX_SPREAD,
  HOLD_MINUTES,
  TRADES_COUNT,
  DELAY_BETWEEN_TRADES,
  POLL_INTERVAL_SEC,
  TOKENS_TO_TRADE,
  RETRY,
  EXECUTION_MODE,
  FILL_POLL_INTERVAL_MS,
  REQUOTE_INTERVAL_SEC,
  SLIPPAGE,
} from '../settings.js';
import { planTopUp } from './allocation.js';
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
  shortError,
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
  existingSide: 'long' | 'short' | null;
  existingUnits: number;
  existingNotional: number;
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
  /** В этом цикле реально открывались новые ордера — тогда при ошибке нужна cleanup-развязка. */
  opened?: boolean;
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
      existingSide: null,
      existingUnits: 0,
      existingNotional: 0,
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

        // Токен выбираем ДО группы: стороны кошельков фиксируются по открытым позициям
        const srcToken = TOKENS_TO_TRADE[Math.floor(Math.random() * TOKENS_TO_TRADE.length)]!;

        // Refresh balances + existing positions for the whole pool
        console.log(`\n  🔄 Refreshing balances & ${srcToken} positions...`);
        for (const acc of this.pool) {
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
          try {
            const pos = await acc.service.getPositionWithLiquidation(srcToken);
            acc.existingSide = pos.hasPosition ? pos.side : null;
            acc.existingUnits = pos.hasPosition ? pos.quantity : 0;
            acc.existingNotional = pos.hasPosition ? pos.positionUsd : 0;
          } catch {
            acc.existingSide = null;
            acc.existingUnits = 0;
            acc.existingNotional = 0;
          }
        }

        // Группа обязана забрать ВСЕ открытые позиции — конфиг подбирается под них
        const longPos = this.pool.filter((a) => a.existingSide === 'long');
        const shortPos = this.pool.filter((a) => a.existingSide === 'short');
        const noPos = this.pool.filter((a) => a.existingSide === null);
        const feasible = GROUP_CONFIGS.filter(([lc, sc]) =>
          lc >= longPos.length &&
          sc >= shortPos.length &&
          (lc - longPos.length) + (sc - shortPos.length) <= noPos.length
        );
        if (feasible.length === 0) {
          console.log(
            `\n⚠️ Open positions (${longPos.length}L/${shortPos.length}S) don't fit any group config — ` +
            `close via mode 2. Waiting...`
          );
          await sleep(10);
          continue;
        }
        const groupConfig = feasible[Math.floor(Math.random() * feasible.length)]!;
        const [longCount, shortCount] = groupConfig;

        // Стороны позиций фиксированы; свободные слоты заполняют кошельки без позиций:
        // крупные балансы — меньшей стороне (они несут больше notional на кошелёк)
        const sortedNoPos = [...noPos].sort((a, b) => b.balance - a.balance);
        const needL = longCount - longPos.length;
        const needS = shortCount - shortPos.length;
        const minorityFirst = needL <= needS;
        const firstNeed = minorityFirst ? needL : needS;
        const secondNeed = minorityFirst ? needS : needL;
        const firstSide: 'long' | 'short' = minorityFirst ? 'long' : 'short';
        const secondSide: 'long' | 'short' = minorityFirst ? 'short' : 'long';
        const firstFillers = sortedNoPos.slice(0, firstNeed);
        const secondFillers = shuffleArray(sortedNoPos.slice(firstNeed)).slice(0, secondNeed);
        const remaining = sortedNoPos.filter(
          (a) => !firstFillers.includes(a) && !secondFillers.includes(a)
        );
        for (const acc of longPos) acc.side = 'long';
        for (const acc of shortPos) acc.side = 'short';
        for (const acc of firstFillers) acc.side = firstSide;
        for (const acc of secondFillers) acc.side = secondSide;
        const selected = [...longPos, ...firstFillers, ...shortPos, ...secondFillers];

        // Validate balances are sufficient (need at least $1 to trade)
        const canCover = selected.every((acc) => acc.balance >= 1);
        if (!canCover) {
          console.log('  ⚠️ Some wallets have insufficient balance. Returning to pool.');
          this.pool = [...remaining, ...selected];
          await sleep(10);
          continue;
        }

        const groupId = String(this.nextGroupId++);
        const group: ActiveGroup = {
          id: groupId,
          accounts: selected,
          srcToken,
          groupConfig,
        };

        console.log(`\n${'='.repeat(60)}`);
        console.log(`📦 Group ${groupId} | ${srcToken} | Config: [${longCount}L, ${shortCount}S]`);
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
        console.log(`\n❌ Controller error: ${shortError(e)}`);
        await sleep(5);
      }
    }
  }

  public stop(): void {
    this.isRunning = false;
  }

  // ==================== STRATEGY EXECUTION ====================

  private async executeStrategy(group: ActiveGroup): Promise<void> {
    const { srcToken, accounts } = group;

    try {
      // Step 1: Wait for acceptable spread
      const maxSpread = MAX_SPREAD > 0 ? MAX_SPREAD : 0.05;
      const { midPrice } = await accounts[0]!.service.waitForSpread(
        srcToken, maxSpread, POLL_INTERVAL_SEC, 180
      );

      // Step 2: Calculate top-up allocation (existing positions included)
      this.calculateAllocation(accounts, srcToken);

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
      console.log(`\n  ❌ Strategy failed: ${shortError(e)}`);
      if (group.opened) {
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
      } else {
        // В этом цикле ничего не открывалось — старые позиции не трогаем
        console.log('  ℹ️ Nothing opened this cycle — existing positions left untouched');
      }

      for (const acc of accounts) {
        await this.handleFailure(acc, e);
      }
    }
  }

  // ==================== ALLOCATION ====================

  /**
   * Дозагрузка до целевого плеча: стороны уже назначены (по открытым позициям
   * в run()), здесь считается только ДОБОР: итог кошелька (старое + новое)
   * ∈ [balance*min, balance*max], а стороны сводятся к одному итогу —
   * дельта-нейтрально вместе со старыми позициями (planTopUp).
   */
  private calculateAllocation(accounts: GroupAccount[], token: string): void {
    const levRange = LEVERAGE[token as keyof typeof LEVERAGE];
    if (!levRange) {
      throw new Error(`LEVERAGE для ${token} не задан — добавь ${token}: [мин, макс] в settings.ts`);
    }
    const minLev = levRange[0];
    const maxLev = levRange[1];
    if (maxLev < minLev) {
      throw new Error(
        `LEVERAGE ${token}: мин ${minLev}x больше максимума ${maxLev}x — исправь диапазон в settings.ts`
      );
    }

    const longSide = accounts.filter((acc) => acc.side === 'long');
    const shortSide = accounts.filter((acc) => acc.side === 'short');

    const plan = planTopUp(
      longSide.map((acc) => ({ balance: acc.balance, existing: acc.existingNotional })),
      shortSide.map((acc) => ({ balance: acc.balance, existing: acc.existingNotional })),
      { min: minLev, max: maxLev }
    );
    if (!plan) {
      const existL = longSide.reduce((s, a) => s + a.existingNotional, 0);
      const existS = shortSide.reduce((s, a) => s + a.existingNotional, 0);
      throw new Error(
        `Группа не сводится в вилку при плече ${minLev}-${maxLev}x с учётом открытых позиций ` +
        `(LONG $${existL.toFixed(0)}, SHORT $${existS.toFixed(0)}). ` +
        `Измени LEVERAGE, состав кошельков или закрой позиции (режим 2).`
      );
    }

    longSide.forEach((acc, index) => {
      acc.orderAmount = plan.longs[index]!;
      acc.leverage = Math.round(((acc.existingNotional + plan.longs[index]!) / acc.balance) * 10) / 10;
    });
    shortSide.forEach((acc, index) => {
      acc.orderAmount = plan.shorts[index]!;
      acc.leverage = Math.round(((acc.existingNotional + plan.shorts[index]!) / acc.balance) * 10) / 10;
    });

    const longAdd = longSide.reduce((s, a) => s + (a.orderAmount ?? 0), 0);
    const shortAdd = shortSide.reduce((s, a) => s + (a.orderAmount ?? 0), 0);
    const longFinal = longSide.reduce((s, a) => s + a.existingNotional + (a.orderAmount ?? 0), 0);
    const shortFinal = shortSide.reduce((s, a) => s + a.existingNotional + (a.orderAmount ?? 0), 0);
    console.log(
      `  📐 Allocation OK | add L: $${longAdd.toFixed(2)} | add S: $${shortAdd.toFixed(2)} | ` +
      `final L: $${longFinal.toFixed(2)} | final S: $${shortFinal.toFixed(2)}`
    );
  }

  // ==================== LEADER-FOLLOWER ====================

  private async executeLeaderFollower(group: ActiveGroup, srcToken: string): Promise<void> {
    const { accounts, id } = group;

    // Дозагрузка не нужна: все кошельки уже в целевом плече — сразу в холд
    const totalAdd = accounts.reduce((s, a) => s + (a.orderAmount ?? 0), 0);
    if (totalAdd < 1) {
      console.log('\n  ✅ Positions already at target leverage — skipping open, going to hold');
      return;
    }

    // Determine leader side (biggest top-up = limit side)
    const biggest = [...accounts].sort((a, b) => (b.orderAmount ?? 0) - (a.orderAmount ?? 0))[0]!;
    const limitSide = biggest.side!;
    const marketSide = limitSide === 'long' ? 'short' : 'long';

    const limitAccounts = accounts.filter((a) => a.side === limitSide);
    const marketAccounts = accounts.filter((a) => a.side === marketSide);

    console.log(`\n  🎯 LEADER: ${limitSide.toUpperCase()} (${limitAccounts.length}) via LIMIT | FOLLOWER: ${marketSide.toUpperCase()} (${marketAccounts.length}) via MARKET`);

    // ========== OPEN ==========
    if (EXECUTION_MODE === 'all-market') {
      group.opened = true;
      await this.openAllMarket(accounts, srcToken);
    } else {
      await this.openLeaderFollower(group, srcToken, limitSide, marketSide, limitAccounts, marketAccounts);
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
      // stop()/halt вышли из цикла раньше дедлайна (Ctrl+C, Force Close) —
      // позиции остаются открытыми, закрытие только через режим 2.
      if (!this.isRunning || isTradingHalted()) {
        console.log('  🛑 Hold interrupted by stop — positions left open');
        this.isRunning = false;
        return;
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

      let totalFees = 0;
      let totalFeesOpen = 0;
      let totalFeesClose = 0;
      let totalFunding = 0;
      let costsSeen = 0;
      for (const acc of accounts) {
        try {
          const costs = await acc.service.getLastCycleCosts(srcToken);
          totalFees += costs.fees;
          totalFeesOpen += costs.feesOpen;
          totalFeesClose += costs.feesClose;
          totalFunding += costs.funding;
          costsSeen++;
        } catch {
          // non-critical
        }
      }

      const costPer100k = totalVolume > 0 ? (-totalPnl / totalVolume) * 100000 : 0;
      const pnlSign = totalPnl >= 0 ? '+' : '';
      const totalEmoji = totalPnl >= 0 ? '📈' : '📉';

      lines.push('');
      lines.push(`${totalEmoji} Total PnL: ${pnlSign}${totalPnl.toFixed(4)}$`);
      lines.push(`💰 Total Volume: $${totalVolume.toFixed(2)}`);
      if (costsSeen > 0) {
        const fundingSign = totalFunding >= 0 ? '+' : '';
        lines.push(
          `💸 Fees: -${totalFees.toFixed(4)}$ (open: -${totalFeesOpen.toFixed(4)}$, close: -${totalFeesClose.toFixed(4)}$) | ` +
          `Funding: ${fundingSign}${totalFunding.toFixed(4)}$`
        );
      }
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
        console.log(`  ❌ MARKET open failed for ${shortAddr(acc.address)}: ${shortError(e)}`);
        await this.handleFailure(acc, e);
      }
    }));
  }

  /** leader-follower: leader LIMIT (maker) → wait full fill → follower MARKET (taker, delta-matched).
   * Филлы считаются по ДЕЛЬТЕ позиции относительно снимка до ордера:
   * старые позиции не принимаются за филл и не участвуют в матчинге фолловера. */
  private async openLeaderFollower(
    group: ActiveGroup,
    srcToken: string,
    limitSide: 'long' | 'short',
    marketSide: 'long' | 'short',
    limitAccounts: GroupAccount[],
    marketAccounts: GroupAccount[]
  ): Promise<void> {
    const midPrice = (await limitAccounts[0]!.service.getMarketSnapshot(srcToken)).midPrice;
    const FILL_EPS = 0.001;

    interface LeaderTrack {
      acc: GroupAccount;
      preUnits: number;
      targetUnits: number;
      filledUnits: number;
    }
    const tracks: LeaderTrack[] = [];
    for (const acc of limitAccounts) {
      let preUnits = 0;
      try {
        preUnits = await acc.service.getPositionBaseUnits(srcToken);
      } catch {
        // позиция неизвестна — считаем с нуля, первый полл поправит
      }
      tracks.push({
        acc,
        preUnits,
        targetUnits: (acc.orderAmount ?? 0) / midPrice,
        filledUnits: 0,
      });
    }
    const pendingLeader = new Set(tracks.filter((t) => t.targetUnits > 1e-9));

    if (pendingLeader.size > 0) {
      if (isTradingHalted()) throw new Error('Trading halted by Force Close');
      console.log(`\n  📋 ${limitSide.toUpperCase()} placing LIMIT orders...`);
      await Promise.all([...pendingLeader].map(async ({ acc }) => {
        try {
          await acc.service.placePositionOrder({
            instrument: srcToken,
            executionSide: limitSide,
            executionType: 'limit',
            amountUsd: acc.orderAmount!,
          });
        } catch (e: any) {
          console.log(`  ❌ LIMIT open failed for ${shortAddr(acc.address)}: ${shortError(e)}`);
          await this.handleFailure(acc, e);
        }
      }));
      group.opened = true;
    }

    // Retry loop for leader: poll fast up to REQUOTE_INTERVAL_SEC, then re-place.
    // Быстрый опрос = фолловер бьёт маркетом ближе к цене филла лидера.
    const pollSec = FILL_POLL_INTERVAL_MS / 1000;
    console.log(`  ⏳ Waiting for leader fills (checking every ${FILL_POLL_INTERVAL_MS}ms, up to ${REQUOTE_INTERVAL_SEC}s)...`);
    while (pendingLeader.size > 0) {
      const roundStart = Date.now();
      const roundDeadline = roundStart + REQUOTE_INTERVAL_SEC * 1000;
      let lastLogAt = 0;

      while (pendingLeader.size > 0 && Date.now() < roundDeadline) {
        if (isTradingHalted()) throw new Error('Trading halted by Force Close');
        await sleep(pollSec);

        const results = await Promise.all([...pendingLeader].map(async (t) => {
          try {
            const position = await t.acc.service.getPositionBaseUnits(srcToken);
            return { t, delta: Math.max(0, position - t.preUnits) };
          } catch {
            return { t, delta: t.filledUnits };
          }
        }));

        for (const { t, delta } of results) {
          t.filledUnits = delta;
          if (delta >= t.targetUnits * (1 - FILL_EPS)) {
            console.log(`  ✅ ${shortAddr(t.acc.address)} leader FILLED`);
            pendingLeader.delete(t);
          }
        }

        const now = Date.now();
        if (pendingLeader.size > 0 && now - lastLogAt >= 15_000) {
          lastLogAt = now;
          console.log(
            `  ⏳ Still waiting for ${pendingLeader.size} leader fill(s), ` +
            `${Math.round((now - roundStart) / 1000)}s elapsed...`
          );
        }
      }

      if (pendingLeader.size === 0) break;

      console.log(`  🔄 ${pendingLeader.size} leader limit(s) unfilled — re-placing...`);
      await Promise.all([...pendingLeader].map(async (t) => {
        try {
          await t.acc.service.cancelAllOrders(srcToken);
          // Достаём только недостающее: лидер мог заполниться частично
          const remainingUnits = Math.max(0, t.targetUnits - t.filledUnits);
          if (remainingUnits <= 0) return;
          await t.acc.service.placePositionOrder({
            instrument: srcToken,
            executionSide: limitSide,
            executionType: 'limit',
            amountUsd: t.acc.orderAmount!,
            overrideBaseUnits: remainingUnits,
          });
        } catch (e: any) {
          console.log(`  ⚠️ Leader re-place failed for ${shortAddr(t.acc.address)}: ${shortError(e)}`);
        }
      }));
    }

    console.log(`  ✅ All leader limits FILLED`);

    // Cancel remnants on leader side
    await Promise.all(limitAccounts.map(async (acc) => {
      try { await acc.service.cancelAllOrders(srcToken); } catch { /* ok */ }
    }));

    // Read actual leader DELTA for exact matching (старые позиции не в счёт)
    let totalLimitBaseUnits = 0;
    for (const t of tracks) {
      try {
        const position = await t.acc.service.getPositionBaseUnits(srcToken);
        t.filledUnits = Math.max(0, position - t.preUnits);
      } catch {
        // оставляем последнюю известную дельту
      }
      totalLimitBaseUnits += t.filledUnits;
      console.log(`  📐 ${shortAddr(t.acc.address)} leader: ${parseFloat(t.filledUnits.toFixed(6))} ${srcToken}`);
    }
    console.log(`  📐 Total LEADER: ${parseFloat(totalLimitBaseUnits.toFixed(6))} ${srcToken}`);

    // Фолловеры с нулевой догрузкой не торгуют; остальные делят дельту пропорционально
    const activeFollowers = marketAccounts.filter((a) => (a.orderAmount ?? 0) > 1e-9);
    const totalFollowerWeight = activeFollowers.reduce((s, a) => s + (a.orderAmount ?? 0), 0);
    const followerBaseUnits = new Map<GroupAccount, number>();
    for (const a of activeFollowers) {
      followerBaseUnits.set(a, totalLimitBaseUnits * ((a.orderAmount ?? 0) / totalFollowerWeight));
    }

    // Follower places MARKET orders (parallel, exact lot matching).
    // Ошибка фолловера недопустима: группа осталась бы односторонней,
    // поэтому ретраим, а при полном провале откатываем ногу лидера.
    const failedFollowers: GroupAccount[] = [];
    if (totalLimitBaseUnits > 1e-9 && activeFollowers.length > 0) {
      await this.waitForBookRecovery(srcToken, marketSide, totalLimitBaseUnits, activeFollowers[0]!);

      console.log(`\n  🚀 ${marketSide.toUpperCase()} placing MARKET orders (delta-matched)...`);
      if (isTradingHalted()) throw new Error('Trading halted by Force Close');

      await Promise.all(activeFollowers.map(async (acc) => {
        let lastError: any = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await acc.service.placePositionOrder({
              instrument: srcToken,
              executionSide: marketSide,
              executionType: 'market',
              amountUsd: acc.orderAmount!,
              overrideBaseUnits: followerBaseUnits.get(acc)!,
            });
            console.log(`  ✅ ${shortAddr(acc.address)} follower MARKET filled`);
            return;
          } catch (e: any) {
            lastError = e;
            console.log(`  ❌ MARKET order failed for ${shortAddr(acc.address)} (attempt ${attempt}/3): ${shortError(e)}`);
            if (attempt < 3) await sleep(1);
          }
        }
        failedFollowers.push(acc);
        await this.handleFailure(acc, lastError);
      }));
    } else {
      console.log(`\n  ℹ️ ${marketSide.toUpperCase()} has nothing to match — skipping MARKET orders`);
    }

    if (failedFollowers.length > 0) {
      throw new Error(
        `${failedFollowers.length} follower(s) failed to open after retries — unwinding leader side`
      );
    }
  }

  /** После филла лидера в стакане дыра на его стороне: маркеты фолловеров
   * умирают об тонкий стакан (IOC min-fill) и конкурируют друг с другом.
   * Ждём, пока глубина в пределах слиппеджа восстановится до суммарного
   * объёма фолловеров (не дольше таймаута), затем бьём маркетом. */
  private async waitForBookRecovery(
    srcToken: string,
    marketSide: 'long' | 'short',
    requiredUnits: number,
    reader: GroupAccount,
    timeoutSec = 10
  ): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000;
    const buy = marketSide === 'long';
    let logged = false;

    while (Date.now() < deadline) {
      if (isTradingHalted()) throw new Error('Trading halted by Force Close');
      try {
        const depth = await reader.service.getBookDepth(srcToken, buy ? 'buy' : 'sell', SLIPPAGE);
        if (depth >= requiredUnits) return;
        if (!logged) {
          logged = true;
          console.log(
            `  ⏳ Book thin after leader fill ` +
            `(${depth.toFixed(2)}/${requiredUnits.toFixed(2)} ${srcToken} within slippage) — waiting for recovery...`
          );
        }
      } catch {
        return; // не удалось прочитать стакан — ретраи фолловеров подстрахуют
      }
      await sleep(1);
    }
    console.log(`  ⚠️ Book still thin after ${timeoutSec}s — placing follower markets anyway`);
  }
}
