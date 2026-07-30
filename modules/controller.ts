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
  LEVERAGE_RANGE,
  MARGIN_MODE,
  MARGIN_RANGE,
  MAX_SPREAD,
  LIMIT_FILL_TIMEOUT_MINUTES,
  DELAY_AFTER_LEADER_FILL,
  HOLD_MINUTES,
  TRADES_COUNT,
  DELAY_BETWEEN_TRADES,
  POLL_INTERVAL_SEC,
  TOKENS_TO_TRADE,
  RETRY,
} from '../settings.js';
import { PhoenixService } from './phoenix-service.js';
import { sendTg } from './telegram.js';
import {
  sleep,
  sleepByRange,
  getRandomNumber,
  isRangeEmpty,
  shuffleArray,
  shortAddr,
} from './utils.js';

// ==================== HELPERS ====================

/** Resolve MARGIN_RANGE value to USDC based on MARGIN_MODE. */
function resolveMargin(balanceUsd: number, rangeValue: number): number {
  if (MARGIN_MODE === 'percent') {
    const pct = Math.min(Math.max(rangeValue, 0), 100);
    return balanceUsd * (pct / 100);
  }
  return rangeValue;
}

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
  tradesCompleted: number;
  targetTrades: number;
}

interface ActiveGroup {
  id: string;
  accounts: GroupAccount[];
  srcToken: string;
  groupConfig: [number, number];
}

// ==================== CONTROLLER ====================

export class DeltaNeutralController {
  private pool: GroupAccount[] = [];
  private isRunning = false;
  private nextGroupId = 1;

  /** Register a wallet into the pool */
  public register(service: PhoenixService, balance: number): void {
    const account: GroupAccount = {
      service,
      address: service.getAddress(),
      balance,
      balanceBefore: balance,
      balanceAfter: 0,
      failures: 0,
      tradesCompleted: 0,
      targetTrades: getRandomNumber(TRADES_COUNT, true),
    };
    this.pool.push(account);
    console.log(`  📥 Registered ${shortAddr(account.address)} | Balance: $${balance.toFixed(2)} | Target trades: ${account.targetTrades}`);
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

        // Shuffle and pick group
        const shuffled = shuffleArray(this.pool);
        const selected = shuffled.slice(0, groupSize);
        const remaining = shuffled.slice(groupSize);

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

        // Validate balances can cover min margin
        const canCover = selected.every((acc) => {
          const minMargin = resolveMargin(acc.balance, MARGIN_RANGE[0]);
          return acc.balance * 0.99 >= minMargin && minMargin > 0;
        });
        if (!canCover) {
          console.log('  ⚠️ Some wallets cannot cover min margin. Returning to pool.');
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
        srcToken, maxSpread, POLL_INTERVAL_SEC, LIMIT_FILL_TIMEOUT_MINUTES * 60
      );

      // Step 2: Calculate position allocation
      this.calculateAllocation(accounts, longCount);

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
      console.log('  🚨 Emergency cleanup...');

      for (const acc of accounts) {
        try {
          await acc.service.closeAllPositionsAndOrders();
        } catch {
          // best effort
        }
        acc.failures++;
      }
    }
  }

  // ==================== ALLOCATION ====================

  private calculateAllocation(accounts: GroupAccount[], longCount: number): void {
    const sorted = [...accounts].sort((a, b) => b.balance - a.balance);

    const accountData = sorted.map((account) => {
      const leverage = getRandomNumber(LEVERAGE_RANGE);
      const safeBalance = account.balance * 0.99;
      const margin = Math.min(resolveMargin(account.balance, getRandomNumber(MARGIN_RANGE)), safeBalance);
      const notional = margin * leverage;
      return { account, leverage, margin, notional };
    });

    const longData = accountData.slice(0, longCount);
    const shortData = accountData.slice(longCount);

    const totalLongNotional = longData.reduce((s, a) => s + a.notional, 0);
    const totalShortNotional = shortData.reduce((s, a) => s + a.notional, 0);
    const targetPerSide = Math.min(totalLongNotional, totalShortNotional);

    for (const d of longData) {
      const proportion = totalLongNotional > 0 ? d.notional / totalLongNotional : 1 / longData.length;
      d.account.side = 'long';
      d.account.orderAmount = targetPerSide * proportion;
      d.account.leverage = d.leverage;
    }

    for (const d of shortData) {
      const proportion = totalShortNotional > 0 ? d.notional / totalShortNotional : 1 / shortData.length;
      d.account.side = 'short';
      d.account.orderAmount = targetPerSide * proportion;
      d.account.leverage = d.leverage;
    }
  }

  // ==================== LEADER-FOLLOWER ====================

  private async executeLeaderFollower(group: ActiveGroup, srcToken: string): Promise<void> {
    const { accounts, groupConfig, id } = group;
    const [longCount] = groupConfig;
    const timeoutMs = LIMIT_FILL_TIMEOUT_MINUTES * 60 * 1000;

    // Determine limit side (side with biggest orderAmount)
    const biggest = [...accounts].sort((a, b) => (b.orderAmount ?? 0) - (a.orderAmount ?? 0))[0]!;
    const limitSide = biggest.side!;
    const marketSide = limitSide === 'long' ? 'short' : 'long';

    const limitAccounts = accounts.filter((a) => a.side === limitSide);
    const marketAccounts = accounts.filter((a) => a.side === marketSide);

    console.log(`\n  🎯 LIMIT side: ${limitSide.toUpperCase()} (${limitAccounts.length}) | MARKET side: ${marketSide.toUpperCase()} (${marketAccounts.length})`);

    // ========== OPEN ==========

    // Step 1: Limit side places LIMIT orders
    console.log(`\n  📋 ${limitSide.toUpperCase()} placing LIMIT orders...`);
    for (const acc of limitAccounts) {
      try {
        await acc.service.placePositionOrder({
          instrument: srcToken,
          executionSide: limitSide,
          executionType: 'limit',
          amountUsd: acc.orderAmount!,
          leverage: acc.leverage,
        });
      } catch (e: any) {
        console.log(`  ❌ LIMIT order failed for ${shortAddr(acc.address)}: ${e.message}`);
        acc.failures++;
        throw new Error('Limit order placement failed');
      }
    }

    // Step 2: Wait for ALL limit fills
    console.log(`\n  ⏳ Waiting for ${limitAccounts.length} limit fill(s) (timeout: ${LIMIT_FILL_TIMEOUT_MINUTES} min)...`);
    await Promise.all(
      limitAccounts.map((acc) => this.waitForPositionOpen(acc, srcToken, timeoutMs))
    );
    console.log(`  ✅ All limit orders FILLED`);

    // Step 2.5: Cancel unfilled remnants on limit side
    for (const acc of limitAccounts) {
      try {
        await acc.service.cancelAllOrders(srcToken);
      } catch {
        // no open orders — ok
      }
    }

    // Step 3: Delay after leader fill
    if (!isRangeEmpty(DELAY_AFTER_LEADER_FILL)) {
      await sleepByRange(DELAY_AFTER_LEADER_FILL, 'Delay after leader fill');
    }

    // Step 3.5: Read actual limit-side position sizes for exact delta matching
    let totalLimitBaseUnits = 0;
    for (const acc of limitAccounts) {
      const units = await acc.service.getPositionBaseUnits(srcToken);
      totalLimitBaseUnits += units;
      console.log(`  📐 ${shortAddr(acc.address)} limit position: ${units.toFixed(6)} ${srcToken}`);
    }
    console.log(`  📐 Total LIMIT side: ${totalLimitBaseUnits.toFixed(6)} ${srcToken} — MARKET side must match`);

    // Distribute lots proportionally among followers
    const totalFollowerWeight = marketAccounts.reduce((s, a) => s + (a.orderAmount ?? 1), 0);
    const followerBaseUnits = marketAccounts.map((a) => {
      const weight = (a.orderAmount ?? 1) / totalFollowerWeight;
      return totalLimitBaseUnits * weight;
    });

    // Step 4: Check spread before market orders
    if (MAX_SPREAD > 0) {
      const snap = await accounts[0]!.service.getMarketSnapshot(srcToken);
      if (snap.spreadPercent > MAX_SPREAD) {
        console.log(`  ⚠️ Spread widened: ${snap.spreadPercent.toFixed(4)}% — waiting...`);
        await accounts[0]!.service.waitForSpread(srcToken, MAX_SPREAD, POLL_INTERVAL_SEC, 60);
      }
    }

    // Step 5: Market side places MARKET orders with exact lot matching
    console.log(`\n  🚀 ${marketSide.toUpperCase()} placing MARKET orders (delta-matched)...`);
    for (let i = 0; i < marketAccounts.length; i++) {
      const acc = marketAccounts[i]!;
      try {
        await acc.service.placePositionOrder({
          instrument: srcToken,
          executionSide: marketSide,
          executionType: 'market',
          amountUsd: acc.orderAmount!,
          leverage: acc.leverage,
          overrideBaseUnits: followerBaseUnits[i],
        });
      } catch (e: any) {
        console.log(`  ❌ MARKET order failed for ${shortAddr(acc.address)}: ${e.message}`);
        acc.failures++;
        throw new Error('Market order placement failed');
      }
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

    // ========== CLOSE ==========
    // Smart close: majority LIMIT (maker fee), minority MARKET (taker fee)

    const limitCloseAccounts = limitAccounts.length >= marketAccounts.length ? limitAccounts : marketAccounts;
    const marketCloseAccounts = limitAccounts.length >= marketAccounts.length ? marketAccounts : limitAccounts;
    const limitCloseSide = limitAccounts.length >= marketAccounts.length ? limitSide : marketSide;
    const marketCloseSide = limitAccounts.length >= marketAccounts.length ? marketSide : limitSide;

    console.log(`\n  📋 Closing: ${limitCloseSide.toUpperCase()} (${limitCloseAccounts.length}) via LIMIT | ${marketCloseSide.toUpperCase()} (${marketCloseAccounts.length}) via MARKET`);

    // Step 7: Majority closes via LIMIT
    for (const acc of limitCloseAccounts) {
      try {
        await acc.service.closePositionByLimit(srcToken);
      } catch (e: any) {
        console.log(`  ⚠️ Limit close failed for ${shortAddr(acc.address)}: ${e.message}`);
      }
    }

    // Step 8: Wait for limit closes
    await Promise.all(
      limitCloseAccounts.map((acc) => this.waitForPositionClose(acc, srcToken))
    );
    console.log(`  ✅ ${limitCloseSide.toUpperCase()} group closed (maker fee)`);

    // Step 9: Delay before market close
    if (!isRangeEmpty(DELAY_AFTER_LEADER_FILL)) {
      await sleepByRange(DELAY_AFTER_LEADER_FILL, 'Delay before market close');
    }

    // Step 10: Minority closes via MARKET
    for (const acc of marketCloseAccounts) {
      try {
        await acc.service.closeAllPositionsAndOrders();
      } catch (e: any) {
        console.log(`  ⚠️ Market close failed for ${shortAddr(acc.address)}: ${e.message}`);
      }
    }
    console.log(`  ✅ All positions closed`);

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
    srcToken: string
  ): Promise<void> {
    while (true) {
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
      } catch {
        // retry
      }

      await sleep(POLL_INTERVAL_SEC);
    }
  }
}
