// ============================================================
//  OPEN STRATEGY — both sides open via LIMIT simultaneously
// ============================================================
// Зеркало close-strategy для входа: обе стороны одновременно ставят
// открывающие лимитки на тач (мейкер) и переставляют незаполненные
// каждые REQUOTE_INTERVAL_SEC. Между перестановками лимитки держатся
// первыми в стакане: каждые TOP_OF_BOOK_CHECK_SEC проверяем верх стакана
// и, если цена ушла, ордер сразу переставляется на лучший бид/аск.
// Если одна сторона заполнилась полностью, а вторая отстаёт дольше
// ONE_SIDED_OPEN_TIMEOUT_SEC — отстающая открывается маркетом,
// чтобы не упустить вход. Односторонность детектится прямо в цикле
// опроса (каждые FILL_POLL_INTERVAL_MS), а не между перестановками.
// ============================================================

import {
  FILL_POLL_INTERVAL_MS,
  ONE_SIDED_OPEN_TIMEOUT_SEC,
  REQUOTE_INTERVAL_SEC,
  SLIPPAGE,
  TOP_OF_BOOK_CHECK_SEC,
} from '../settings.js';
import { PhoenixService } from './phoenix-service.js';
import { isTradingHalted } from './runtime-control.js';
import { sleep, shortAddr, shortError } from './utils.js';

export interface OpenAccount {
  service: PhoenixService;
  side: 'long' | 'short';
  /** Сумма догрузки в этом цикле (USD). */
  orderAmount: number;
}

/** Состояние открывающей лимитки аккаунта. */
interface OpenTrack {
  acc: OpenAccount;
  preUnits: number;
  targetUnits: number;
  filledUnits: number;
  price: number;
  lastPlaceAttempt: number;
}

const FILL_EPS = 0.001;
const PRICE_EPS = 1e-9;

/** Как часто повторять постановку, если открывающая лимитка не встала после ошибки. */
const MISSING_ORDER_RETRY_SEC = 15;

/**
 * Open positions: обе стороны ставят лимитки одновременно (мейкер).
 * Филлы считаются по ДЕЛЬТЕ позиции относительно снимка до ордера:
 * старые позиции не принимаются за филл.
 * `markOpened` вызывается один раз, когда первый ордер встал on-chain —
 * с этого момента при сбое нужна cleanup-развязка.
 */
export async function openBothSidesLimit(
  accounts: OpenAccount[],
  symbol: string,
  markOpened?: () => void
): Promise<void> {
  const active = accounts.filter((a) => a.orderAmount > 1e-9);
  if (active.length === 0) return;

  // Снимок позиций и мида ДО ордеров: филлы считаются только как дельта
  const midPrice = (await active[0]!.service.getMarketSnapshot(symbol)).midPrice;
  if (midPrice <= 0) throw new Error(`Invalid mid price for ${symbol}`);

  const tracks: OpenTrack[] = [];
  for (const acc of active) {
    let preUnits = 0;
    try {
      preUnits = await acc.service.getPositionBaseUnits(symbol);
    } catch {
      // позиция неизвестна — считаем с нуля, первый полл поправит
    }
    // Цель выравнивается до целых лотов СРАЗУ: on-chain программа отклоняет
    // дробные лоты, и «хвост» меньше лота навсегда зависал бы как
    // «незаполненный» ордер (re-place: quantity rounds to zero lots).
    const targetUnits = await acc.service.quantizeBaseUnits(symbol, acc.orderAmount / midPrice);
    tracks.push({
      acc,
      preUnits,
      targetUnits,
      filledUnits: 0,
      price: 0,
      lastPlaceAttempt: 0,
    });
  }

  const tradable = tracks.filter((t) => t.targetUnits > 0);
  if (tradable.length === 0) {
    console.log(`  ℹ️ All allocations below one ${symbol} lot — nothing to open`);
    return;
  }

  const longSide = tradable.filter((t) => t.acc.side === 'long');
  const shortSide = tradable.filter((t) => t.acc.side === 'short');
  const nakedTimeoutMs = ONE_SIDED_OPEN_TIMEOUT_SEC > 0
    ? ONE_SIDED_OPEN_TIMEOUT_SEC * 1000
    : Number.POSITIVE_INFINITY;

  console.log(
    `\n  📋 Opening BOTH sides via LIMIT (maker): ` +
    `${longSide.length} LONG + ${shortSide.length} SHORT ${symbol}...`
  );

  if (isTradingHalted()) throw new Error('Trading halted by Force Close');

  const pending = new Set(tradable);
  const oneSided = { since: null as number | null };
  let markedOpened = false;
  const notifyOpened = (): void => {
    if (!markedOpened) {
      markedOpened = true;
      markOpened?.();
    }
  };

  await placeLimits([...pending], symbol, notifyOpened);

  let openRetryCount = 0;
  while (pending.size > 0) {
    openRetryCount++;
    const roundDeadline = Date.now() + REQUOTE_INTERVAL_SEC * 1000;

    const outcome = await pollRound(
      pending, longSide, shortSide, symbol, roundDeadline,
      (t) => {
        notifyOpened();
        console.log(`  ✅ ${shortAddr(t.acc.service.getAddress())} opened via LIMIT (maker)`);
      },
      oneSided, nakedTimeoutMs, notifyOpened
    );

    if (outcome === 'filled') break;

    if (outcome === 'one-sided') {
      const laggards = [...pending];
      console.log(
        `  🔄 One-sided for ${ONE_SIDED_OPEN_TIMEOUT_SEC}s — ` +
        `MARKET opening ${laggards.length} laggard(s)...`
      );
      const failed = await marketOpenLaggards(laggards, symbol);
      for (const t of laggards) pending.delete(t);
      oneSided.since = null;
      if (failed.length > 0) {
        await cancelAll(tradable.map((t) => t.acc), symbol);
        throw new Error(
          `${failed.length} laggard(s) failed to open via MARKET — group left one-sided`
        );
      }
      break;
    }

    console.log(
      `  🔄 ${pending.size} limit(s) unfilled — cancelling & re-placing (attempt ${openRetryCount})...`
    );
    await rePlace([...pending], symbol, notifyOpened);
  }

  await cancelAll(tradable.map((t) => t.acc), symbol);
  console.log(`  ✅ ${symbol} opened (both sides maker LIMIT)`);
}

async function placeLimits(
  tracks: OpenTrack[],
  symbol: string,
  notifyOpened: () => void
): Promise<void> {
  let placed = false;
  await Promise.all(tracks.map(async (t) => {
    try {
      const res = await t.acc.service.placePositionOrder({
        instrument: symbol,
        executionSide: t.acc.side,
        executionType: 'limit',
        amountUsd: t.acc.orderAmount,
      });
      t.price = res.orderPrice ?? 0;
      t.lastPlaceAttempt = Date.now();
      placed = true;
    } catch (e: any) {
      console.log(`  ❌ LIMIT open failed for ${shortAddr(t.acc.service.getAddress())}: ${shortError(e)}`);
    }
  }));
  if (placed) notifyOpened();
}

async function rePlace(
  tracks: OpenTrack[],
  symbol: string,
  notifyOpened: () => void
): Promise<void> {
  let placed = false;
  await Promise.all(tracks.map(async (t) => {
    try {
      await t.acc.service.cancelAllOrders(symbol);
      // Достаём только недостающее: лимитка могла заполниться частично
      const remainingUnits = Math.max(0, t.targetUnits - t.filledUnits);
      if (remainingUnits <= 1e-9) return;
      const res = await t.acc.service.placePositionOrder({
        instrument: symbol,
        executionSide: t.acc.side,
        executionType: 'limit',
        amountUsd: t.acc.orderAmount,
        overrideBaseUnits: remainingUnits,
      });
      t.price = res.orderPrice ?? 0;
      t.lastPlaceAttempt = Date.now();
      placed = true;
    } catch (e: any) {
      t.price = 0;
      console.log(`  ⚠️ Re-place failed for ${shortAddr(t.acc.service.getAddress())}: ${shortError(e)}`);
    }
  }));
  if (placed) notifyOpened();
}

/** Лимитка должна стоять первой в стакане: если рынок ушёл и ордер
 * оказался ниже верха (для покупки) или выше (для продажи) — снимаем
 * и переставляем на лучший бид/аск. Лимитки, которые не встали после ошибки
 * постановки, повторяем каждые MISSING_ORDER_RETRY_SEC. */
async function maintainTopOfBook(
  pending: Set<OpenTrack>,
  symbol: string,
  notifyOpened: () => void
): Promise<void> {
  if (pending.size === 0) return;

  const reader = [...pending][0]!.acc;
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
  const behind = [...pending].filter((t) => {
    if (t.price <= 0) {
      // лимитка не встала после ошибки постановки — повторяем с откатом
      return now - t.lastPlaceAttempt >= MISSING_ORDER_RETRY_SEC * 1000;
    }
    return t.acc.side === 'long'
      ? bestBid > t.price + PRICE_EPS
      : bestAsk < t.price - PRICE_EPS;
  });
  if (behind.length === 0) return;

  for (const t of behind) t.lastPlaceAttempt = now;
  console.log(`  ⬆️ ${behind.length} open limit(s) missing or off the top of the book — re-placing at best...`);
  await rePlace(behind, symbol, notifyOpened);
}

/** Один раунд быстрого опроса позиций (параллельно), строго до deadline.
 * Односторонность детектится прямо здесь: как только одна сторона открылась
 * полностью, а вторая ещё в ожидании — таймер стартует, и по истечении
 * ONE_SIDED_OPEN_TIMEOUT_SEC раунд прерывается для маркет-доедания.
 * Параллельно следит, чтобы лимитки оставались первыми в стакане. */
async function pollRound(
  pending: Set<OpenTrack>,
  longSide: OpenTrack[],
  shortSide: OpenTrack[],
  symbol: string,
  deadline: number,
  onFilled: (t: OpenTrack) => void,
  oneSided: { since: number | null },
  nakedTimeoutMs: number,
  notifyOpened: () => void
): Promise<'filled' | 'one-sided' | 'requote'> {
  const pollSec = FILL_POLL_INTERVAL_MS / 1000;
  const roundStart = Date.now();
  let lastLogAt = 0;
  let lastTopCheckAt = 0;

  while (pending.size > 0 && Date.now() < deadline) {
    if (isTradingHalted()) throw new Error('Trading halted by Force Close');
    await sleep(pollSec);

    const results = await Promise.all([...pending].map(async (t) => {
      try {
        const position = await t.acc.service.getPositionBaseUnits(symbol);
        return { t, delta: Math.max(0, position - t.preUnits) };
      } catch {
        return { t, delta: t.filledUnits };
      }
    }));

    for (const { t, delta } of results) {
      t.filledUnits = delta;
      if (delta >= t.targetUnits * (1 - FILL_EPS)) {
        onFilled(t);
        pending.delete(t);
      }
    }

    const now = Date.now();

    // Односторонность: одна сторона открылась полностью, вторая ещё нет.
    // Пока ожидаются обе (или ни одной) — таймер не идёт.
    const longPending = longSide.some((t) => pending.has(t));
    const shortPending = shortSide.some((t) => pending.has(t));
    if (longPending !== shortPending) {
      oneSided.since ??= now;
      if (now - oneSided.since >= nakedTimeoutMs) return 'one-sided';
    } else {
      oneSided.since = null;
    }

    if (pending.size > 0 && now - lastTopCheckAt >= TOP_OF_BOOK_CHECK_SEC * 1000) {
      lastTopCheckAt = now;
      await maintainTopOfBook(pending, symbol, notifyOpened);
    }

    if (pending.size > 0 && now - lastLogAt >= 15_000) {
      lastLogAt = now;
      console.log(
        `  ⏳ Still waiting for ${pending.size} limit open(s) to fill, ` +
        `${Math.round((now - roundStart) / 1000)}s elapsed...`
      );
    }
  }

  return pending.size === 0 ? 'filled' : 'requote';
}

/** Маркет-открытие отстающей стороны с ретраями: транзитентная ошибка
 * не должна оставить группу односторонней без хеджа. */
async function marketOpenLaggards(laggards: OpenTrack[], symbol: string): Promise<OpenTrack[]> {
  const remaining = (t: OpenTrack): number => Math.max(0, t.targetUnits - t.filledUnits);
  const totalRemaining = laggards.reduce((s, t) => s + remaining(t), 0);

  if (totalRemaining > 1e-9) {
    // Филлы наших лимиток оставили дыру в стакане: маркеты умрут об тонкий
    // стакан. Ждём восстановления глубины в пределах слиппеджа.
    await waitForBookRecovery(laggards[0]!.acc, symbol, laggards[0]!.acc.side, totalRemaining);
  }

  if (isTradingHalted()) throw new Error('Trading halted by Force Close');

  const failed: OpenTrack[] = [];
  await Promise.all(laggards.map(async (t) => {
    try { await t.acc.service.cancelAllOrders(symbol); } catch { /* ok */ }
    const units = remaining(t);
    if (units <= 1e-9) return;
    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await t.acc.service.placePositionOrder({
          instrument: symbol,
          executionSide: t.acc.side,
          executionType: 'market',
          amountUsd: t.acc.orderAmount,
          overrideBaseUnits: units,
        });
        console.log(`  ✅ ${shortAddr(t.acc.service.getAddress())} opened via MARKET (fallback)`);
        return;
      } catch (e: any) {
        lastError = e;
        console.log(
          `  ❌ MARKET open failed for ${shortAddr(t.acc.service.getAddress())} ` +
          `(attempt ${attempt}/3): ${shortError(e)}`
        );
        if (attempt < 3) await sleep(1);
      }
    }
    failed.push(t);
  }));
  return failed;
}

/** После филлов наших лимиток в стакане дыра на нашей стороне: маркеты
 * отстающих умирают об тонкий стакан. Ждём, пока глубина в пределах
 * слиппеджа восстановится до суммарного объёма (не дольше таймаута). */
async function waitForBookRecovery(
  reader: OpenAccount,
  symbol: string,
  marketSide: 'long' | 'short',
  requiredUnits: number,
  timeoutSec = 10
): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  const buy = marketSide === 'long';
  let logged = false;

  while (Date.now() < deadline) {
    if (isTradingHalted()) throw new Error('Trading halted by Force Close');
    try {
      const depth = await reader.service.getBookDepth(symbol, buy ? 'buy' : 'sell', SLIPPAGE);
      if (depth >= requiredUnits) return;
      if (!logged) {
        logged = true;
        console.log(
          `  ⏳ Book thin after limit fills ` +
          `(${depth.toFixed(2)}/${requiredUnits.toFixed(2)} ${symbol} within slippage) — waiting for recovery...`
        );
      }
    } catch {
      return; // не удалось прочитать стакан — ретраи маркетов подстрахуют
    }
    await sleep(1);
  }
  console.log(`  ⚠️ Book still thin after ${timeoutSec}s — placing laggard markets anyway`);
}

async function cancelAll(accounts: OpenAccount[], symbol: string): Promise<void> {
  await Promise.all(accounts.map(async (acc) => {
    try { await acc.service.cancelAllOrders(symbol); } catch { /* ok */ }
  }));
}
