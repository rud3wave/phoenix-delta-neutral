// ============================================================
//  CONTROLLER — Delta-neutral strategy execution
// ============================================================
// Leader-follower: limit side opens first → wait for fill →
// cancel unfilled → market side matches exact lots.
// Smart close: majority LIMIT (maker), minority MARKET (taker).
// Two TG messages: #1 after open, #2 after close with PnL.
// ============================================================

import {
  GROUP_CONFIGS,
  TOKEN_LEVERAGE,
  POSITION_PERCENT,
  MAX_SPREAD,
  DELAY_AFTER_LEADER_FILL,
  HOLD_MINUTES,
  TRADES_COUNT,
  DELAY_BETWEEN_TRADES,
  POLL_INTERVAL_SEC,
  TOKENS_TO_TRADE,
  RETRY,
  EXECUTION_MODE,
} from '../settings.js';
import { PhoenixService } from './phoenix-service.js';
import { closeLeaderFollower } from './close-strategy.js';
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

        // Randomly decide which side is LONG
        const selected = Math.random() < 0.5
          ? [...smallerSideAccounts, ...largerSideAccounts]
          : [...largerSideAccounts, ...smallerSideAccounts];

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
      console.log('  🚨 Emergency cleanup via LIMIT (maker)...');

      // Close all via limit with retry loop (same as normal close)
      const pendingCleanup = new Set(accounts);

      // Initial limit placement
      await Promise.all(accounts.map(async (acc) => {
        try {
          await acc.service.closePositionByLimit(srcToken);
        } catch {
          // best effort
        }
      }));

      // Retry until all closed: poll every 1s up to 2min, then re-place unfilled
      while (pendingCleanup.size > 0) {
        let stillOpen: GroupAccount[] = [];

        for (let i = 0; i < 120 && pendingCleanup.size > 0; i++) {
          await sleep(1);

          stillOpen = [];
          for (const acc of pendingCleanup) {
            try {
              const state = await acc.service.getPositions();
              const subaccounts = state.snapshot?.subaccounts ?? [];
              let hasPosition = false;
              for (const sub of subaccounts) {
                const positions = sub.positions ?? [];
                if (positions.some((p) => p.symbol === srcToken && Number(p.basePositionLots) !== 0)) {
                  hasPosition = true;
                  break;
                }
              }
              if (hasPosition) stillOpen.push(acc);
            } catch {
              stillOpen.push(acc);
            }
          }

          for (const acc of pendingCleanup) {
            if (!stillOpen.includes(acc)) pendingCleanup.delete(acc);
          }
        }

        if (pendingCleanup.size === 0) break;

        // Re-place unfilled
        await Promise.all(stillOpen.map(async (acc) => {
          try {
            await acc.service.cancelAllOrders(srcToken);
            await acc.service.closePositionByLimit(srcToken);
          } catch {
            // best effort
          }
        }));
      }

      console.log('  ✅ Emergency cleanup complete (maker)');

      for (const acc of accounts) {
        await this.handleFailure(acc, e);
      }
    }
  }

  // ==================== ALLOCATION ====================

  /**
   * Distribute `total` into `n` parts where each part ∈ [min, max] and sum == total.
   * Uses random constrained partitioning.
   */
  private distributeNotional(total: number, n: number, min: number, max: number): number[] | null {
    if (n === 1) return total >= min && total <= max ? [total] : null;
    if (total < n * min || total > n * max) return null;

    const parts: number[] = new Array(n).fill(min);
    let remaining = total - n * min;

    for (let i = 0; i < n - 1 && remaining > 0; i++) {
      const maxAdd = Math.min(max - min, remaining);
      const add = Math.random() * maxAdd;
      parts[i] += add;
      remaining -= add;
    }
    parts[n - 1] += remaining;

    // Fix floating-point drift
    const drift = total - parts.reduce((s, p) => s + p, 0);
    parts[n - 1] += drift;

    return parts;
  }

  /**
   * Try to compute a balanced allocation where LONG notional == SHORT notional exactly.
   *
   * Formula: notional = balance × (percent / 100) × leverage
   * - percent from POSITION_PERCENT controls risk (liquidation distance)
   * - leverage from TOKEN_LEVERAGE[token] controls position multiplier
   */
  private tryCalculateAllocation(accounts: GroupAccount[], longCount: number, token: string): boolean {
    const levRange = TOKEN_LEVERAGE[token as keyof typeof TOKEN_LEVERAGE] ?? TOKEN_LEVERAGE.ETH;
    const [minLev, maxLev] = levRange;
    const [minPct, maxPct] = POSITION_PERCENT;

    const sorted = [...accounts].sort((a, b) => b.balance - a.balance);

    const longIsSource = longCount <= accounts.length - longCount;
    const sourceCount = longIsSource ? longCount : accounts.length - longCount;
    const targetCount = accounts.length - sourceCount;

    const sourceAccounts = sorted.slice(0, sourceCount);
    const targetAccounts = sorted.slice(sourceCount);

    // --- Source side: notional = balance × (percent/100) × leverage ---
    const sourceData: { account: GroupAccount; leverage: number; notional: number }[] = [];
    let targetNotional = 0;

    for (const acc of sourceAccounts) {
      const leverage = getRandomNumber(levRange);
      const pct = getRandomNumber(POSITION_PERCENT);
      const notional = acc.balance * (pct / 100) * leverage;
      if (notional <= 0) return false;
      sourceData.push({ account: acc, leverage, notional });
      targetNotional += notional;
    }

    // --- Target side: derived to match ---
    const targetCaps = targetAccounts.map((acc) => ({
      account: acc,
      minCap: acc.balance * (minPct / 100) * minLev,
      maxCap: acc.balance * (maxPct / 100) * maxLev,
    }));

    const totalMinCap = targetCaps.reduce((s, c) => s + c.minCap, 0);
    const totalMaxCap = targetCaps.reduce((s, c) => s + c.maxCap, 0);
    if (targetNotional < totalMinCap || targetNotional > totalMaxCap) return false;

    const rawWeights = targetCaps.map((c) => c.maxCap);
    const totalWeight = rawWeights.reduce((s, w) => s + w, 0);

    let parts: number[] | null = this.distributeNotional(
      targetNotional, targetCount,
      Math.max(...targetCaps.map((c) => c.minCap)),
      Math.min(...targetCaps.map((c) => c.maxCap))
    );

    if (!parts) {
      parts = [];
      let allocated = 0;
      for (let i = 0; i < targetCount - 1; i++) {
        const proportional = (rawWeights[i] / totalWeight) * targetNotional;
        const clamped = Math.max(targetCaps[i]!.minCap, Math.min(targetCaps[i]!.maxCap, proportional));
        parts.push(clamped);
        allocated += clamped;
      }
      const last = targetNotional - allocated;
      if (last < targetCaps[targetCount - 1]!.minCap || last > targetCaps[targetCount - 1]!.maxCap) return false;
      parts.push(last);
    }

    // Derive leverage for each target wallet
    const targetData: { account: GroupAccount; leverage: number; notional: number }[] = [];

    for (let i = 0; i < targetCount; i++) {
      const acc = targetAccounts[i]!;
      const part = parts[i]!;

      let pctLow = (part / (acc.balance * maxLev)) * 100;
      let pctHigh = (part / (acc.balance * minLev)) * 100;
      pctLow = Math.max(pctLow, minPct);
      pctHigh = Math.min(pctHigh, maxPct);
      if (pctLow > pctHigh || pctLow <= 0) return false;

      const pct = pctLow + Math.random() * (pctHigh - pctLow);
      const leverage = part / (acc.balance * (pct / 100));
      const roundedLev = Math.round(leverage * 10) / 10;
      if (roundedLev < minLev || roundedLev > maxLev) return false;

      targetData.push({ account: acc, leverage: roundedLev, notional: part });
    }

    // --- Liquidation safety (hardcoded 10% min distance) ---
    const MIN_LIQ_DISTANCE = 10;
    for (const d of [...sourceData, ...targetData]) {
      const effectiveLev = d.notional / d.account.balance;
      if ((1 / effectiveLev) * 100 < MIN_LIQ_DISTANCE) return false;
    }

    // --- Assign ---
    for (const d of sourceData) {
      d.account.side = longIsSource ? 'long' : 'short';
      d.account.orderAmount = d.notional;
      d.account.leverage = d.leverage;
    }
    for (const d of targetData) {
      d.account.side = longIsSource ? 'short' : 'long';
      d.account.orderAmount = d.notional;
      d.account.leverage = d.leverage;
    }

    return true;
  }

  /**
   * Public allocation entry point — retries up to 1000 times.
   */
  private calculateAllocation(accounts: GroupAccount[], longCount: number, token: string): void {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (this.tryCalculateAllocation(accounts, longCount, token)) {
        const longTotal = accounts.filter((a) => a.side === 'long').reduce((s, a) => s + (a.orderAmount ?? 0), 0);
        const shortTotal = accounts.filter((a) => a.side === 'short').reduce((s, a) => s + (a.orderAmount ?? 0), 0);
        console.log(`  📐 Allocation OK (attempt ${attempt + 1}) | LONG: $${longTotal.toFixed(2)} | SHORT: $${shortTotal.toFixed(2)} | Δ: $${Math.abs(longTotal - shortTotal).toFixed(4)}`);
        return;
      }
    }
    throw new Error('Failed to calculate delta-neutral allocation after 1000 attempts');
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
      console.log(`\n  ⏸️ Holding positions for ${holdMinutes.toFixed(1)} min (quiet hold)...`);
      await sleep(holdMinutes * 60);
      console.log('  ⏸️ Hold complete');
    } else {
      console.log('\n  ⏸️ Holding indefinitely — close manually via mode 2');
      // Wait until stopped
      while (this.isRunning) {
        await sleep(60);
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
    console.log(`\n  🚀 ALL-MARKET mode — opening ALL ${accounts.length} via MARKET...`);
    await Promise.all(accounts.map(async (acc) => {
      try {
        await acc.service.placePositionOrder({
          instrument: srcToken,
          executionSide: acc.side!,
          executionType: 'market',
          amountUsd: acc.orderAmount!,
          leverage: acc.leverage,
        });
        console.log(`  ✅ ${shortAddr(acc.address)} MARKET open filled`);
      } catch (e: any) {
        console.log(`  ❌ MARKET open failed for ${shortAddr(acc.address)}: ${e.message}`);
        await this.handleFailure(acc, e);
      }
    }));
  }

  /** leader-follower: leader LIMIT (maker) → wait fill → follower MARKET (taker, delta-matched). */
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

    await Promise.all(limitAccounts.map(async (acc) => {
      try {
        await acc.service.placePositionOrder({
          instrument: srcToken,
          executionSide: limitSide,
          executionType: 'limit',
          amountUsd: acc.orderAmount!,
          leverage: acc.leverage,
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
        await sleep(1);

        stillWaiting = [];
        for (const acc of pendingLeader) {
          try {
            const state = await acc.service.getPositions();
            const subaccounts = state.snapshot?.subaccounts ?? [];
            let hasPosition = false;
            for (const sub of subaccounts) {
              const positions = sub.positions ?? [];
              if (positions.some((p) => p.symbol === srcToken && Number(p.basePositionLots) !== 0)) {
                hasPosition = true;
                break;
              }
            }
            if (hasPosition) {
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
            leverage: acc.leverage,
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
    await Promise.all(marketAccounts.map(async (acc, i) => {
      try {
        await acc.service.placePositionOrder({
          instrument: srcToken,
          executionSide: marketSide,
          executionType: 'market',
          amountUsd: acc.orderAmount!,
          leverage: acc.leverage,
          overrideBaseUnits: followerBaseUnits[i],
        });
        console.log(`  ✅ ${shortAddr(acc.address)} follower MARKET filled`);
      } catch (e: any) {
        console.log(`  ❌ MARKET order failed for ${shortAddr(acc.address)}: ${e.message}`);
        await this.handleFailure(acc, e);
      }
    }));
  }

  // ==================== WAIT HELPERS ====================

  private async waitForPositionOpen(
    account: GroupAccount,
    srcToken: string,
    timeoutMs: number
  ): Promise<void> {
    const startTime = Date.now();

    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Limit fill timeout for ${shortAddr(account.address)}`);
      }

      try {
        const state = await account.service.getPositions();
        const subaccounts = state.snapshot?.subaccounts ?? [];
        for (const sub of subaccounts) {
          const positions = sub.positions ?? [];
          if (positions.some((p) => p.symbol === srcToken && Number(p.basePositionLots) !== 0)) {
            return;
          }
        }
      } catch {
        // retry on next poll
      }

      await sleep(POLL_INTERVAL_SEC);
    }
  }

  private async waitForPositionClose(
    account: GroupAccount,
    srcToken: string,
    timeoutMs: number = 0
  ): Promise<void> {
    const startTime = Date.now();

    while (true) {
      if (timeoutMs > 0 && Date.now() - startTime > timeoutMs) {
        throw new Error(`Close timeout for ${shortAddr(account.address)}`);
      }

      try {
        const state = await account.service.getPositions();
        const subaccounts = state.snapshot?.subaccounts ?? [];

        let hasPosition = false;
        for (const sub of subaccounts) {
          const positions = sub.positions ?? [];
          if (positions.some((p) => p.symbol === srcToken && Number(p.basePositionLots) !== 0)) {
            hasPosition = true;
            break;
          }
        }

        if (!hasPosition) return;
      } catch (e: any) {
        // Don't swallow timeout errors
        if (e.message?.includes('Close timeout')) throw e;
        // retry on other errors
      }

      await sleep(POLL_INTERVAL_SEC);
    }
  }
}
