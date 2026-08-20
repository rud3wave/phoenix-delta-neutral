// ============================================================
//  OPEN STRATEGY — both sides open via LIMIT simultaneously
// ============================================================
// Обе стороны одновременно ставят открывающие лимитки на тач (мейкер)
// и переставляют незаполненные каждые REQUOTE_INTERVAL_SEC. Между
// перестановками лимитки держатся первыми в стакане: каждые
// TOP_OF_BOOK_CHECK_SEC проверяем верх стакана и, если цена ушла,
// ордер сразу переставляется на лучший бид/аск. Маркет-доедания на
// открытии НЕТ (регламент): ждём филла обеих лимиток — пока обе не
// заполнились, портфель плоский.
// ============================================================

import {
  FILL_POLL_INTERVAL_MS,
  REQUOTE_INTERVAL_SEC,
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
/** Насколько позиция может превысить цель, прежде чем это станет предупреждением. */
const OVERSHOOT_EPS = 0.02;

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

  console.log(
    `\n  📋 Opening BOTH sides via LIMIT (maker): ` +
    `${longSide.length} LONG + ${shortSide.length} SHORT ${symbol}...`
  );

  if (isTradingHalted()) throw new Error('Trading halted by Force Close');

  const pending = new Set(tradable);
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
    if (isTradingHalted()) {
      await cancelAll(tradable.map((t) => t.acc), symbol);
      throw new Error('Trading halted by Force Close');
    }
    openRetryCount++;
    const roundDeadline = Date.now() + REQUOTE_INTERVAL_SEC * 1000;

    const outcome = await pollRound(
      pending, symbol, roundDeadline,
      (t) => {
        notifyOpened();
        console.log(`  ✅ ${shortAddr(t.acc.service.getAddress())} opened via LIMIT (maker)`);
      },
      notifyOpened
    );

    if (outcome === 'filled') break;

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
  if (isTradingHalted()) return;
  let placed = false;
  await Promise.all(tracks.map(async (t) => {
    try {
      const res = await t.acc.service.placePositionOrder({
        instrument: symbol,
        executionSide: t.acc.side,
        executionType: 'post-only',
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
  if (isTradingHalted()) return;
  let placed = false;
  await Promise.all(tracks.map(async (t) => {
    try {
      await t.acc.service.cancelAllOrders(symbol);
      // Свежий срез позиции: filledUnits взят из последнего полла и мог устареть —
      // ордер мог исполниться ровно в момент отмены (на движении цены). Ставить
      // замену по старому остатку = открыть тот же объём второй раз сверх цели.
      try {
        const currentUnits = await t.acc.service.getPositionBaseUnits(symbol);
        t.filledUnits = Math.max(t.filledUnits, Math.max(0, currentUnits - t.preUnits));
      } catch {
        // RPC сбой — остаёмся на последнем известном filledUnits
      }
      // Достаём только недостающее: лимитка могла заполниться частично
      const remainingUnits = Math.max(0, t.targetUnits - t.filledUnits);
      if (remainingUnits <= 1e-9) return;
      const res = await t.acc.service.placePositionOrder({
        instrument: symbol,
        executionSide: t.acc.side,
        executionType: 'post-only',
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
 * Параллельно следит, чтобы лимитки оставались первыми в стакане. */
async function pollRound(
  pending: Set<OpenTrack>,
  symbol: string,
  deadline: number,
  onFilled: (t: OpenTrack) => void,
  notifyOpened: () => void
): Promise<'filled' | 'requote'> {
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
        if (delta > t.targetUnits * (1 + OVERSHOOT_EPS)) {
          console.log(
            `  ⚠️ ${shortAddr(t.acc.service.getAddress())} overshoot: opened ` +
            `${parseFloat(delta.toFixed(6))} ${symbol} vs plan ` +
            `${parseFloat(t.targetUnits.toFixed(6))} — fill race at re-quote`
          );
        }
        onFilled(t);
        pending.delete(t);
      }
    }

    const now = Date.now();

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

async function cancelAll(accounts: OpenAccount[], symbol: string): Promise<void> {
  await Promise.all(accounts.map(async (acc) => {
    try { await acc.service.cancelAllOrders(symbol); } catch { /* ok */ }
  }));
}
