// ============================================================
//  CLOSE STRATEGY — Leader LIMIT (maker) then Follower MARKET (taker)
// ============================================================
// Shared by the delta-neutral controller (mode 1) and the manual
// close-all (mode 2) so the close logic never drifts apart.
// The side holding the single largest position closes first via
// LIMIT and waits for fills; the opposite side then closes via MARKET.
// ============================================================

import { EXECUTION_MODE } from '../settings.js';
import { PhoenixService } from './phoenix-service.js';
import { sleep, shortAddr } from './utils.js';

export interface CloseAccount {
  service: PhoenixService;
}

/**
 * Close positions leader-first:
 * `limitAccounts` close via LIMIT (maker) with a retry loop until filled,
 * then `marketAccounts` close via MARKET (taker).
 */
export async function closeLeaderFollower(
  limitAccounts: CloseAccount[],
  marketAccounts: CloseAccount[],
  symbol: string
): Promise<void> {
  if (limitAccounts.length === 0 && marketAccounts.length === 0) return;

  // ========== all-market: close everything by market at once ==========
  if (EXECUTION_MODE === 'all-market') {
    const all = [...limitAccounts, ...marketAccounts];
    console.log(`\n  🚀 Closing ALL ${all.length} ${symbol} via MARKET (all-market mode)...`);
    await Promise.all(all.map(async (acc) => {
      try {
        await acc.service.closePositionByMarket(symbol);
        console.log(`  ✅ ${shortAddr(acc.service.getAddress())} closed via MARKET`);
      } catch (e: any) {
        console.log(`  ❌ Market close failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
      }
    }));
    console.log(`  ✅ ${symbol} closed (all-market)`);
    return;
  }

  // ========== Step 1: Leader LIMIT (maker) ==========

  console.log(`\n  📋 Leader (${limitAccounts.length}) closing ${symbol} via LIMIT (maker)...`);
  const pendingClose = new Set(limitAccounts);

  // Initial placement
  await Promise.all(limitAccounts.map(async (acc) => {
    try {
      await acc.service.closePositionByLimit(symbol);
    } catch (e: any) {
      console.log(`  ⚠️ Limit close failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
    }
  }));

  // Retry loop: poll every 1s up to 10s → re-place unfilled
  let closeRetryCount = 0;

  while (pendingClose.size > 0) {
    closeRetryCount++;
    console.log(`\n  ⏳ Polling leader close fills every 1s, up to 2min (attempt ${closeRetryCount})...`);
    let stillOpen: CloseAccount[] = [];

    for (let i = 0; i < 120 && pendingClose.size > 0; i++) {
      await sleep(1);

      stillOpen = [];
      for (const acc of pendingClose) {
        try {
          const state = await acc.service.getPositions();
          const subaccounts = state.snapshot?.subaccounts ?? [];
          let hasPosition = false;
          for (const sub of subaccounts) {
            const positions = sub.positions ?? [];
            if (positions.some((p) => p.symbol === symbol && Number(p.basePositionLots) !== 0)) {
              hasPosition = true;
              break;
            }
          }
          if (hasPosition) {
            stillOpen.push(acc);
          } else {
            console.log(`  ✅ ${shortAddr(acc.service.getAddress())} leader closed via LIMIT (maker)`);
          }
        } catch {
          stillOpen.push(acc);
        }
      }

      for (const acc of pendingClose) {
        if (!stillOpen.includes(acc)) pendingClose.delete(acc);
      }
    }

    if (pendingClose.size === 0) break;

    // Re-place unfilled
    console.log(`  🔄 ${pendingClose.size} leader limit(s) unfilled — cancelling & re-placing...`);
    await Promise.all(stillOpen.map(async (acc) => {
      try {
        await acc.service.cancelAllOrders(symbol);
        await acc.service.closePositionByLimit(symbol);
      } catch (e: any) {
        console.log(`  ⚠️ Re-place failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
      }
    }));
  }

  // Cancel any lingering orders on the leader side
  await Promise.all(limitAccounts.map(async (acc) => {
    try { await acc.service.cancelAllOrders(symbol); } catch { /* ok */ }
  }));

  console.log(`  ✅ Leader closed via LIMIT (maker) after ${closeRetryCount} attempt(s)`);

  // ========== Step 2: Follower MARKET (taker) ==========

  console.log(`\n  🚀 Follower (${marketAccounts.length}) closing ${symbol} via MARKET (taker)...`);
  await Promise.all(marketAccounts.map(async (acc) => {
    try {
      await acc.service.closePositionByMarket(symbol);
      console.log(`  ✅ ${shortAddr(acc.service.getAddress())} follower closed via MARKET`);
    } catch (e: any) {
      console.log(`  ❌ Market close failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
    }
  }));

  console.log(`  ✅ ${symbol} closed (leader LIMIT + follower MARKET)`);
}
