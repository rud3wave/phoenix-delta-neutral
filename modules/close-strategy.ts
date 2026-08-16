// ============================================================
//  CLOSE STRATEGY — Leader LIMIT (maker) then Follower close
// ============================================================
// Shared by the delta-neutral controller (mode 1) and the manual
// close-all (mode 2) so the close logic never drifts apart.
// The side holding the single largest position closes first via
// LIMIT and waits for fills; the opposite side then tries a short
// maker-close and falls back to MARKET after MAKER_CLOSE_TIMEOUT_SEC.
// ============================================================

import {
  EXECUTION_MODE,
  FILL_POLL_INTERVAL_MS,
  MAKER_CLOSE_TIMEOUT_SEC,
  REQUOTE_INTERVAL_SEC,
} from '../settings.js';
import { PhoenixService } from './phoenix-service.js';
import { sleep, shortAddr } from './utils.js';

export interface CloseAccount {
  service: PhoenixService;
}

/** Маркет-закрытие с ретраями: транзитентная ошибка не должна оставлять позицию открытой. */
async function closeByMarketWithRetry(acc: CloseAccount, symbol: string, attempts = 3): Promise<void> {
  let lastError: any = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await acc.service.closePositionByMarket(symbol);
      return;
    } catch (e: any) {
      lastError = e;
      if (attempt < attempts) await sleep(1);
    }
  }
  throw lastError;
}

/** Один раунд ожидания: быстрый опрос позиций до 2 минут. */
async function waitUntilClosed(
  pending: Set<CloseAccount>,
  symbol: string,
  onFilled: (acc: CloseAccount) => void
): Promise<CloseAccount[]> {
  const pollSec = FILL_POLL_INTERVAL_MS / 1000;
  const roundStart = Date.now();
  const roundDeadline = roundStart + REQUOTE_INTERVAL_SEC * 1000;
  let lastLogAt = 0;
  let stillOpen: CloseAccount[] = [];

  while (pending.size > 0 && Date.now() < roundDeadline) {
    await sleep(pollSec);

    const results = await Promise.all([...pending].map(async (acc) => {
      try {
        const position = await acc.service.getPositionBaseUnits(symbol);
        return { acc, open: position > 1e-10 };
      } catch {
        return { acc, open: true };
      }
    }));

    stillOpen = [];
    for (const { acc, open } of results) {
      if (open) {
        stillOpen.push(acc);
      } else {
        onFilled(acc);
        pending.delete(acc);
      }
    }

    const now = Date.now();
    if (pending.size > 0 && now - lastLogAt >= 15_000) {
      lastLogAt = now;
      console.log(
        `  ⏳ Still waiting for ${pending.size} limit close(s) to fill, ` +
        `${Math.round((now - roundStart) / 1000)}s elapsed...`
      );
    }
  }

  return stillOpen;
}

/**
 * Close positions leader-first:
 * `limitAccounts` close via LIMIT (maker) with a retry loop until filled,
 * then `marketAccounts` try a timed maker-close and fall back to MARKET.
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
        await closeByMarketWithRetry(acc, symbol);
        console.log(`  ✅ ${shortAddr(acc.service.getAddress())} closed via MARKET`);
      } catch (e: any) {
        console.log(`  ❌ Market close failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
      }
    }));
    console.log(`  ✅ ${symbol} closed (all-market)`);
    return;
  }

  // One-sided residuals close strictly via maker LIMIT (no MARKET leg exists)
  if (limitAccounts.length === 0 || marketAccounts.length === 0) {
    const all = [...limitAccounts, ...marketAccounts];
    console.log(`\n  📋 Closing ${all.length} ${symbol} residual via LIMIT (maker)...`);
    const pendingClose = new Set(all);

    await Promise.all(all.map(async (acc) => {
      try {
        await acc.service.closePositionByLimit(symbol);
      } catch (e: any) {
        console.log(`  ⚠️ Limit close failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
      }
    }));

    let closeRetryCount = 0;
    while (pendingClose.size > 0) {
      closeRetryCount++;
      await waitUntilClosed(pendingClose, symbol, (acc) => {
        console.log(`  ✅ ${shortAddr(acc.service.getAddress())} closed via LIMIT (maker)`);
      });

      if (pendingClose.size === 0) break;

      console.log(`  🔄 ${pendingClose.size} limit(s) unfilled — cancelling & re-placing...`);
      await Promise.all([...pendingClose].map(async (acc) => {
        try {
          await acc.service.cancelAllOrders(symbol);
          await acc.service.closePositionByLimit(symbol);
        } catch (e: any) {
          console.log(`  ⚠️ Re-place failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
        }
      }));
    }

    await Promise.all(all.map(async (acc) => {
      try { await acc.service.cancelAllOrders(symbol); } catch { /* ok */ }
    }));
    console.log(`  ✅ ${symbol} closed (maker LIMIT)`);
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

  // Retry loop: poll fast up to 2min → re-place unfilled
  let closeRetryCount = 0;

  while (pendingClose.size > 0) {
    closeRetryCount++;
    console.log(`\n  ⏳ Polling leader close fills every ${FILL_POLL_INTERVAL_MS}ms, up to ${REQUOTE_INTERVAL_SEC}s (attempt ${closeRetryCount})...`);

    await waitUntilClosed(pendingClose, symbol, (acc) => {
      console.log(`  ✅ ${shortAddr(acc.service.getAddress())} leader closed via LIMIT (maker)`);
    });

    if (pendingClose.size === 0) break;

    // Re-place unfilled
    console.log(`  🔄 ${pendingClose.size} leader limit(s) unfilled — cancelling & re-placing...`);
    await Promise.all([...pendingClose].map(async (acc) => {
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

  // ========== Step 2: Follower — timed maker close, MARKET fallback ==========

  if (MAKER_CLOSE_TIMEOUT_SEC <= 0) {
    console.log(`\n  🚀 Follower (${marketAccounts.length}) closing ${symbol} via MARKET (taker)...`);
    await Promise.all(marketAccounts.map(async (acc) => {
      try {
        await closeByMarketWithRetry(acc, symbol);
        console.log(`  ✅ ${shortAddr(acc.service.getAddress())} follower closed via MARKET`);
      } catch (e: any) {
        console.log(`  ❌ Market close failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
      }
    }));
    console.log(`  ✅ ${symbol} closed (leader LIMIT + follower MARKET)`);
    return;
  }

  console.log(`\n  📋 Follower (${marketAccounts.length}) closing ${symbol} via LIMIT (maker, up to ${MAKER_CLOSE_TIMEOUT_SEC}s)...`);
  await Promise.all(marketAccounts.map(async (acc) => {
    try {
      await acc.service.closePositionByLimit(symbol);
    } catch (e: any) {
      console.log(`  ⚠️ Limit close failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
    }
  }));

  const pendingFollower = new Set(marketAccounts);
  const deadline = Date.now() + MAKER_CLOSE_TIMEOUT_SEC * 1000;
  const pollSec = FILL_POLL_INTERVAL_MS / 1000;

  while (pendingFollower.size > 0 && Date.now() < deadline) {
    await sleep(pollSec);

    const stillOpen: CloseAccount[] = [];
    for (const acc of pendingFollower) {
      try {
        const position = await acc.service.getPositionBaseUnits(symbol);
        if (position > 1e-10) {
          stillOpen.push(acc);
        } else {
          console.log(`  ✅ ${shortAddr(acc.service.getAddress())} follower closed via LIMIT (maker)`);
        }
      } catch {
        stillOpen.push(acc);
      }
    }

    for (const acc of pendingFollower) {
      if (!stillOpen.includes(acc)) pendingFollower.delete(acc);
    }
  }

  // Не успела закрыться мейкером — дочищаем маркетом
  if (pendingFollower.size > 0) {
    console.log(`  🔄 ${pendingFollower.size} follower limit(s) unfilled in ${MAKER_CLOSE_TIMEOUT_SEC}s — MARKET fallback...`);
    await Promise.all([...pendingFollower].map(async (acc) => {
      try {
        await acc.service.cancelAllOrders(symbol);
        await closeByMarketWithRetry(acc, symbol);
        console.log(`  ✅ ${shortAddr(acc.service.getAddress())} follower closed via MARKET (fallback)`);
      } catch (e: any) {
        console.log(`  ❌ Market close failed for ${shortAddr(acc.service.getAddress())}: ${e.message}`);
      }
    }));
  }

  // Cancel any lingering orders on the follower side
  await Promise.all(marketAccounts.map(async (acc) => {
    try { await acc.service.cancelAllOrders(symbol); } catch { /* ok */ }
  }));

  console.log(`  ✅ ${symbol} closed (leader LIMIT + follower maker/market)`);
}
