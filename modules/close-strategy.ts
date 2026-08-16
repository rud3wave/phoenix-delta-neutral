// ============================================================
//  CLOSE STRATEGY — both sides close via LIMIT simultaneously
// ============================================================
// Shared by the delta-neutral controller (mode 1) and the manual
// close-all (mode 2) so the close logic never drifts apart.
// Обе стороны одновременно ставят закрывающие лимитки на тач
// (мейкер) и переставляют незаполненные каждые REQUOTE_INTERVAL_SEC.
// Между перестановками лимитки держатся первыми в стакане: каждые
// TOP_OF_BOOK_CHECK_SEC проверяем верх стакана и, если цена ушла выше
// нашей покупки (или ниже нашей продажи), ордер сразу переставляется
// на лучший бид/аск. Если одна сторона закрылась полностью, а вторая
// отстаёт дольше ONE_SIDED_CLOSE_TIMEOUT_SEC — отстающая закрывается
// маркетом, чтобы не стоять голым.
// ============================================================

import {
  EXECUTION_MODE,
  FILL_POLL_INTERVAL_MS,
  ONE_SIDED_CLOSE_TIMEOUT_SEC,
  REQUOTE_INTERVAL_SEC,
  TOP_OF_BOOK_CHECK_SEC,
} from '../settings.js';
import { PhoenixService } from './phoenix-service.js';
import { sleep, shortAddr, shortError } from './utils.js';

export interface CloseAccount {
  service: PhoenixService;
}

/** Куда и по какой цене поставлена закрывающая лимитка аккаунта. */
interface OrderInfo {
  side: 'long' | 'short';
  price: number;
}

const PRICE_EPS = 1e-9;

/** Как часто повторять постановку, если закрывающая лимитка не встала после ошибки. */
const MISSING_ORDER_RETRY_SEC = 15;

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

async function placeLimits(
  accounts: Iterable<CloseAccount>,
  symbol: string,
  orderInfo: Map<CloseAccount, OrderInfo>
): Promise<void> {
  await Promise.all([...accounts].map(async (acc) => {
    try {
      const placed = await acc.service.closePositionByLimit(symbol);
      if (placed) orderInfo.set(acc, placed);
    } catch (e: any) {
      console.log(`  ⚠️ Limit close failed for ${shortAddr(acc.service.getAddress())}: ${shortError(e)}`);
    }
  }));
}

async function rePlace(
  accounts: Iterable<CloseAccount>,
  symbol: string,
  orderInfo: Map<CloseAccount, OrderInfo>
): Promise<void> {
  await Promise.all([...accounts].map(async (acc) => {
    try {
      await acc.service.cancelAllOrders(symbol);
      const placed = await acc.service.closePositionByLimit(symbol);
      if (placed) orderInfo.set(acc, placed);
    } catch (e: any) {
      console.log(`  ⚠️ Re-place failed for ${shortAddr(acc.service.getAddress())}: ${shortError(e)}`);
    }
  }));
}

/** Лимитка должна стоять первой в стакане: если рынок ушёл и ордер
 * оказался ниже верха (для покупки) или выше (для продажи) — снимаем
 * и переставляем на лучший бид/аск. Лимитки, которые не встали после ошибки
 * постановки, повторяем каждые MISSING_ORDER_RETRY_SEC. */
async function maintainTopOfBook(
  pending: Set<CloseAccount>,
  symbol: string,
  orderInfo: Map<CloseAccount, OrderInfo>,
  placeRetry: Map<CloseAccount, number>
): Promise<void> {
  if (pending.size === 0) return;

  const reader = [...pending][0]!;
  let bestBid: number;
  let bestAsk: number;
  try {
    const snap = await reader.service.getMarketSnapshot(symbol);
    bestBid = snap.bestBid;
    bestAsk = snap.bestAsk;
  } catch {
    return;
  }

  const now = Date.now();
  const behind = [...pending].filter((acc) => {
    const info = orderInfo.get(acc);
    if (!info || info.price <= 0) {
      // лимитка не встала после ошибки постановки — повторяем с откатом
      return now - (placeRetry.get(acc) ?? 0) >= MISSING_ORDER_RETRY_SEC * 1000;
    }
    return info.side === 'long'
      ? bestBid > info.price + PRICE_EPS
      : bestAsk < info.price - PRICE_EPS;
  });
  if (behind.length === 0) return;

  for (const acc of behind) placeRetry.set(acc, now);
  console.log(`  ⬆️ ${behind.length} limit(s) missing or off the top of the book — re-placing at best...`);
  await rePlace(behind, symbol, orderInfo);
}

async function cancelAll(accounts: CloseAccount[], symbol: string): Promise<void> {
  await Promise.all(accounts.map(async (acc) => {
    try { await acc.service.cancelAllOrders(symbol); } catch { /* ok */ }
  }));
}

async function marketCloseAll(accounts: CloseAccount[], symbol: string): Promise<void> {
  await Promise.all(accounts.map(async (acc) => {
    try {
      await acc.service.cancelAllOrders(symbol);
      await closeByMarketWithRetry(acc, symbol);
      console.log(`  ✅ ${shortAddr(acc.service.getAddress())} closed via MARKET (fallback)`);
    } catch (e: any) {
      console.log(`  ❌ Market close failed for ${shortAddr(acc.service.getAddress())}: ${shortError(e)}`);
    }
  }));
}

/** Один раунд быстрого опроса позиций (параллельно), строго до deadline.
 * Параллельно следит, чтобы лимитки оставались первыми в стакане. */
async function pollRound(
  pending: Set<CloseAccount>,
  symbol: string,
  deadline: number,
  onFilled: (acc: CloseAccount) => void,
  orderInfo: Map<CloseAccount, OrderInfo>,
  placeRetry: Map<CloseAccount, number>
): Promise<void> {
  const pollSec = FILL_POLL_INTERVAL_MS / 1000;
  const roundStart = Date.now();
  let lastLogAt = 0;
  let lastTopCheckAt = 0;

  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(pollSec);

    const results = await Promise.all([...pending].map(async (acc) => {
      try {
        const position = await acc.service.getPositionBaseUnits(symbol);
        return { acc, open: position > 1e-10 };
      } catch {
        return { acc, open: true };
      }
    }));

    for (const { acc, open } of results) {
      if (open) continue;
      onFilled(acc);
      pending.delete(acc);
    }

    const now = Date.now();
    if (pending.size > 0 && now - lastTopCheckAt >= TOP_OF_BOOK_CHECK_SEC * 1000) {
      lastTopCheckAt = now;
      await maintainTopOfBook(pending, symbol, orderInfo, placeRetry);
    }

    if (pending.size > 0 && now - lastLogAt >= 15_000) {
      lastLogAt = now;
      console.log(
        `  ⏳ Still waiting for ${pending.size} limit close(s) to fill, ` +
        `${Math.round((now - roundStart) / 1000)}s elapsed...`
      );
    }
  }
}

/**
 * Close positions: обе стороны закрываются лимитками одновременно (мейкер).
 * `limitAccounts` / `marketAccounts` — исторические имена сторон группы;
 * при закрытии обе работают как мейкер.
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
        console.log(`  ❌ Market close failed for ${shortAddr(acc.service.getAddress())}: ${shortError(e)}`);
      }
    }));
    console.log(`  ✅ ${symbol} closed (all-market)`);
    return;
  }

  const all = [...limitAccounts, ...marketAccounts];
  const nakedTimeoutMs = ONE_SIDED_CLOSE_TIMEOUT_SEC > 0
    ? ONE_SIDED_CLOSE_TIMEOUT_SEC * 1000
    : Number.POSITIVE_INFINITY;

  // ========== One-sided residuals: maker LIMIT, timed market fallback ==========
  if (limitAccounts.length === 0 || marketAccounts.length === 0) {
    console.log(`\n  📋 Closing ${all.length} ${symbol} residual via LIMIT (maker)...`);
    const pendingClose = new Set(all);
    const orderInfo = new Map<CloseAccount, OrderInfo>();
    const placeRetry = new Map<CloseAccount, number>();
    await placeLimits(pendingClose, symbol, orderInfo);

    let closeRetryCount = 0;
    while (pendingClose.size > 0) {
      closeRetryCount++;
      const roundDeadline = Math.min(
        Date.now() + REQUOTE_INTERVAL_SEC * 1000,
        Date.now() + nakedTimeoutMs
      );
      await pollRound(pendingClose, symbol, roundDeadline, (acc) => {
        console.log(`  ✅ ${shortAddr(acc.service.getAddress())} closed via LIMIT (maker)`);
      }, orderInfo, placeRetry);

      if (pendingClose.size === 0) break;

      if (nakedTimeoutMs !== Number.POSITIVE_INFINITY && Date.now() >= roundDeadline) {
        console.log(`  🔄 Residual unfilled in ${ONE_SIDED_CLOSE_TIMEOUT_SEC}s — MARKET fallback...`);
        await marketCloseAll([...pendingClose], symbol);
        break;
      }

      console.log(`  🔄 ${pendingClose.size} limit(s) unfilled — cancelling & re-placing (attempt ${closeRetryCount})...`);
      await rePlace(pendingClose, symbol, orderInfo);
    }

    await cancelAll(all, symbol);
    console.log(`  ✅ ${symbol} closed (maker LIMIT)`);
    return;
  }

  // ========== Both sides LIMIT simultaneously ==========
  console.log(
    `\n  📋 Closing BOTH sides via LIMIT (maker): ` +
    `${limitAccounts.length} + ${marketAccounts.length} ${symbol}...`
  );
  const pending = new Set(all);
  const orderInfo = new Map<CloseAccount, OrderInfo>();
  const placeRetry = new Map<CloseAccount, number>();
  await placeLimits(pending, symbol, orderInfo);

  let closeRetryCount = 0;
  let oneSidedSince: number | null = null;

  while (pending.size > 0) {
    closeRetryCount++;
    const roundStart = Date.now();
    const roundDeadline = roundStart + REQUOTE_INTERVAL_SEC * 1000;

    await pollRound(pending, symbol, roundDeadline, (acc) => {
      console.log(`  ✅ ${shortAddr(acc.service.getAddress())} closed via LIMIT (maker)`);
    }, orderInfo, placeRetry);

    if (pending.size === 0) break;

    // Односторонность: одна сторона закрылась полностью, вторая ещё нет.
    // Пока открыты обе — портфель хеджирован, таймер не идёт.
    const limitOpen = limitAccounts.some((acc) => pending.has(acc));
    const marketOpen = marketAccounts.some((acc) => pending.has(acc));
    if (limitOpen !== marketOpen) {
      oneSidedSince ??= Date.now();
    } else {
      oneSidedSince = null;
    }

    if (oneSidedSince !== null && Date.now() - oneSidedSince >= nakedTimeoutMs) {
      const laggards = [...pending];
      console.log(
        `  🔄 One-sided for ${ONE_SIDED_CLOSE_TIMEOUT_SEC}s — ` +
        `MARKET closing ${laggards.length} laggard(s)...`
      );
      await marketCloseAll(laggards, symbol);
      for (const acc of laggards) pending.delete(acc);
      oneSidedSince = null;
      if (pending.size === 0) break;
    }

    console.log(`  🔄 ${pending.size} limit(s) unfilled — cancelling & re-placing (attempt ${closeRetryCount})...`);
    await rePlace(pending, symbol, orderInfo);
  }

  await cancelAll(all, symbol);
  console.log(`  ✅ ${symbol} closed (both sides maker LIMIT)`);
}
