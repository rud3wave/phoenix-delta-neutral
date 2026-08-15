import {
  HEDGE_POLL_INTERVAL_MS,
  MAKER_REQUOTE_INTERVAL_SEC,
  MAKER_REQUOTE_THRESHOLD_PERCENT,
  MAX_HEDGE_RETRIES,
  MAX_MAKER_WAIT_SEC,
} from '../settings.js';
import { PhoenixService } from './phoenix-service.js';
import { isTradingHalted } from './runtime-control.js';
import { shortAddr, sleep } from './utils.js';

export type PositionSide = 'long' | 'short';

export interface PairedAccountTarget {
  service: PhoenixService;
  targetBaseUnits: number;
}

export interface PairedExecutionParams {
  symbol: string;
  makerSide: PositionSide;
  takerSide: PositionSide;
  makerTargets: PairedAccountTarget[];
  takerTargets: PairedAccountTarget[];
  reduceOnly?: boolean;
  haltCheck?: () => boolean;
  maxMakerWaitSec?: number | null;
  makerOrderMaxAgeSec?: number;
  makerOnly?: boolean;
}

interface TrackedTarget extends PairedAccountTarget {
  startPosition: number;
}

const EPSILON = 1e-10;
const DEFAULT_MAKER_ORDER_MAX_AGE_SEC = 120;

function direction(side: PositionSide): number {
  return side === 'long' ? 1 : -1;
}

function sumTargets(targets: PairedAccountTarget[]): number {
  return targets.reduce((sum, target) => sum + target.targetBaseUnits, 0);
}

async function trackTargets(targets: PairedAccountTarget[], symbol: string): Promise<TrackedTarget[]> {
  return Promise.all(targets.map(async (target) => ({
    ...target,
    startPosition: await target.service.getSignedPositionBaseUnits(symbol),
  })));
}

async function readProgress(
  targets: TrackedTarget[],
  symbol: string,
  side: PositionSide
): Promise<number[]> {
  const sign = direction(side);
  return Promise.all(targets.map(async (target) => {
    const current = await target.service.getSignedPositionBaseUnits(symbol);
    const filled = (current - target.startPosition) * sign;
    return Math.max(0, Math.min(target.targetBaseUnits, filled));
  }));
}

export async function allocateTargets(
  totalBaseUnits: number,
  accounts: Array<{ service: PhoenixService; weight: number }>,
  symbol: string
): Promise<PairedAccountTarget[]> {
  if (accounts.length === 0 || totalBaseUnits <= 0) return [];

  const weightedAccounts = accounts.filter((account) => account.weight > 0);
  const totalWeight = weightedAccounts.reduce((sum, account) => sum + account.weight, 0);
  if (totalWeight <= 0) throw new Error('Cannot allocate paired targets with zero total weight');

  const decimals = await weightedAccounts[0]!.service.getBaseLotsDecimals(symbol);
  const scale = Math.pow(10, decimals);
  const totalLots = Math.max(0, Math.round(totalBaseUnits * scale));
  if (totalLots === 0) return [];

  const targets: PairedAccountTarget[] = [];
  let allocatedLots = 0;
  for (let i = 0; i < weightedAccounts.length; i++) {
    const account = weightedAccounts[i]!;
    const targetLots = i === weightedAccounts.length - 1
      ? totalLots - allocatedLots
      : Math.floor(totalLots * (account.weight / totalWeight));
    allocatedLots += targetLots;
    if (targetLots > 0) {
      targets.push({ service: account.service, targetBaseUnits: targetLots / scale });
    }
  }
  return targets;
}

export async function executePaired(params: PairedExecutionParams): Promise<void> {
  const {
    symbol,
    makerSide,
    takerSide,
    makerTargets,
    takerTargets,
    reduceOnly = false,
    haltCheck = isTradingHalted,
    maxMakerWaitSec = MAX_MAKER_WAIT_SEC,
    makerOrderMaxAgeSec = DEFAULT_MAKER_ORDER_MAX_AGE_SEC,
    makerOnly = false,
  } = params;
  if (makerTargets.length === 0 || (!makerOnly && takerTargets.length === 0)) {
    throw new Error(`Paired ${symbol} execution requires both maker and taker accounts`);
  }
  if (!Number.isFinite(makerOrderMaxAgeSec) || makerOrderMaxAgeSec <= 0) {
    throw new Error('makerOrderMaxAgeSec must be greater than zero');
  }

  const makerTotal = sumTargets(makerTargets);
  const takerTotal = sumTargets(takerTargets);
  if (makerTotal <= EPSILON || (!makerOnly && takerTotal <= EPSILON)) {
    throw new Error(`Paired ${symbol} execution has an empty target`);
  }
  if (!makerOnly && Math.abs(makerTotal - takerTotal) > EPSILON) {
    throw new Error(
      `Paired ${symbol} target mismatch: maker ${makerTotal.toFixed(8)} / ` +
      `taker ${takerTotal.toFixed(8)}`
    );
  }

  await Promise.all([...makerTargets, ...takerTargets].map((target) => target.service.warmOrderClient()));
  const makers = await trackTargets(makerTargets, symbol);
  const takers = await trackTargets(takerTargets, symbol);
  const startedAt = Date.now();
  const makerDeadline = maxMakerWaitSec === null
    ? Number.POSITIVE_INFINITY
    : startedAt + maxMakerWaitSec * 1000;
  const makerHighWater = makers.map(() => 0);
  const acknowledgedTakerProgress = takers.map(() => 0);

  const readMakerProgress = async (): Promise<number[]> => {
    const observed = await readProgress(makers, symbol, makerSide);
    return observed.map((value, index) => {
      makerHighWater[index] = Math.max(makerHighWater[index]!, value);
      return makerHighWater[index]!;
    });
  };

  const cancelMakerOrders = async (force = false): Promise<void> => {
    await Promise.all(makers.map((target) => target.service.cancelAllOrders(symbol, true, force)));
  };

  const hedgeToMakerProgress = async (makerFilled: number): Promise<void> => {
    if (makerOnly) return;
    const fraction = Math.max(0, Math.min(1, makerFilled / makerTotal));

    for (let attempt = 1; attempt <= MAX_HEDGE_RETRIES; attempt++) {
      const observedProgress = await readProgress(takers, symbol, takerSide);
      const progress = observedProgress.map((value, index) =>
        Math.max(value, acknowledgedTakerProgress[index]!)
      );
      const desiredByAccount = await Promise.all(takers.map((target) =>
        target.service.quantizeBaseUnits(symbol, target.targetBaseUnits * fraction)
      ));
      const deficits = await Promise.all(takers.map(async (target, index) => {
        return target.service.quantizeBaseUnits(
          symbol,
          Math.max(0, desiredByAccount[index]! - progress[index]!)
        );
      }));

      const pending = deficits
        .map((quantity, index) => ({ quantity, index, target: takers[index]! }))
        .filter(({ quantity }) => quantity > EPSILON);
      if (pending.length === 0) return;

      const results = await Promise.allSettled(pending.map(({ quantity, target }) =>
        target.service.placePositionOrder({
          instrument: symbol,
          executionSide: takerSide,
          executionType: 'market',
          amountUsd: 0,
          overrideBaseUnits: quantity,
          reduceOnly,
        })
      ));
      const failed = results.filter((result) => result.status === 'rejected');
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const order = pending[index]!;
        acknowledgedTakerProgress[order.index] = Math.max(
          acknowledgedTakerProgress[order.index]!,
          progress[order.index]! + order.quantity
        );
      });
      if (failed.length === 0) return;

      console.log(
        `  Hedge retry ${attempt}/${MAX_HEDGE_RETRIES}: ${failed.length} FOK order(s) rejected`
      );
    }

    const finalObserved = await readProgress(takers, symbol, takerSide);
    const finalProgress = finalObserved.map((value, index) =>
      Math.max(value, acknowledgedTakerProgress[index]!)
    );
    const desiredByAccount = await Promise.all(takers.map((target) =>
      target.service.quantizeBaseUnits(symbol, target.targetBaseUnits * fraction)
    ));
    const desiredTotal = desiredByAccount.reduce((sum, value) => sum + value, 0);
    const actualTotal = finalProgress.reduce((sum, value) => sum + value, 0);
    if (actualTotal + 1e-8 < desiredTotal) {
      throw new Error(
        `Unable to hedge ${symbol} maker fill: ${actualTotal.toFixed(8)}/${desiredTotal.toFixed(8)}`
      );
    }
  };

  console.log(makerOnly
    ? `  Maker-only ${symbol}: ${makerSide.toUpperCase()} ${makerTotal.toFixed(6)}`
    : `  Paired ${symbol}: maker ${makerSide.toUpperCase()} ${makerTotal.toFixed(6)} / ` +
      `taker ${takerSide.toUpperCase()} ${takerTotal.toFixed(6)}`
  );

  let makerOrdersActive = false;
  let quotedReferencePrice = 0;
  let makerOrderPlacedAt = 0;

  try {
    // Cheap when the API sees no stale orders; no cancel transaction is sent.
    await cancelMakerOrders(false);

    let makerProgress = 0;
    while (makerProgress + EPSILON < makerTotal) {
      if (haltCheck()) throw new Error('Trading halted by Force Close');
      if (Date.now() > makerDeadline) {
        throw new Error(`Maker phase timed out after ${maxMakerWaitSec}s`);
      }

      const progressBeforeQuote = await readMakerProgress();
      makerProgress = progressBeforeQuote.reduce((sum, value) => sum + value, 0);
      await hedgeToMakerProgress(makerProgress);
      if (makerProgress + EPSILON >= makerTotal) {
        makerOrdersActive = false;
        break;
      }

      if (!makerOrdersActive) {
        const placements = makers
          .map((target, index) => ({
            target,
            remaining: Math.max(0, target.targetBaseUnits - progressBeforeQuote[index]!),
          }))
          .filter(({ remaining }) => remaining > EPSILON);

        // Set before awaiting so a partial placement failure is always cleaned up.
        makerOrdersActive = true;
        makerOrderPlacedAt = Date.now();
        const results = await Promise.all(placements.map(async ({ target, remaining }) => {
          const result = await target.service.placePositionOrder({
            instrument: symbol,
            executionSide: makerSide,
            executionType: 'post-only',
            amountUsd: 0,
            overrideBaseUnits: remaining,
            reduceOnly,
          });
          console.log(
            `  Maker ${shortAddr(target.service.getAddress())}: ${remaining.toFixed(6)} ${symbol}`
          );
          return result;
        }));
        const prices = results
          .map((result) => result.makerReferencePrice ?? 0)
          .filter((price) => price > 0);
        if (prices.length > 0) {
          quotedReferencePrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
        } else {
          const snapshot = await makers[0]!.service.getMarketSnapshot(symbol);
          quotedReferencePrice = makerSide === 'long' ? snapshot.bestAsk : snapshot.bestBid;
        }
      }

      const quoteCheckAt = Math.min(
        makerDeadline,
        makerOrderPlacedAt + makerOrderMaxAgeSec * 1000,
        Date.now() + MAKER_REQUOTE_INTERVAL_SEC * 1000
      );
      while (Date.now() < quoteCheckAt && makerProgress + EPSILON < makerTotal) {
        await sleep(HEDGE_POLL_INTERVAL_MS / 1000);
        if (haltCheck()) throw new Error('Trading halted by Force Close');
        const progress = await readMakerProgress();
        const nextProgress = progress.reduce((sum, value) => sum + value, 0);
        if (nextProgress > makerProgress + EPSILON) {
          makerProgress = nextProgress;
          await hedgeToMakerProgress(makerProgress);
        }
      }

      if (makerProgress + EPSILON >= makerTotal) {
        makerOrdersActive = false;
        break;
      }

      const snapshot = await makers[0]!.service.getMarketSnapshot(symbol);
      const currentReferencePrice = makerSide === 'long' ? snapshot.bestAsk : snapshot.bestBid;
      const driftPercent = quotedReferencePrice > 0
        ? (Math.abs(currentReferencePrice - quotedReferencePrice) / quotedReferencePrice) * 100
        : Number.POSITIVE_INFINITY;
      const orderAgeExpired = Date.now() - makerOrderPlacedAt >= makerOrderMaxAgeSec * 1000;

      if (orderAgeExpired || driftPercent >= MAKER_REQUOTE_THRESHOLD_PERCENT) {
        const reason = orderAgeExpired
          ? `quote age ${makerOrderMaxAgeSec}s`
          : `quote drift ${driftPercent.toFixed(4)}%`;
        console.log(`  Maker ${reason}: cancelling and re-pricing ${symbol}`);
        await cancelMakerOrders(true);
        makerOrdersActive = false;

        // Capture fills that landed while the cancellation transaction confirmed.
        const progressAfterCancel = await readMakerProgress();
        makerProgress = progressAfterCancel.reduce((sum, value) => sum + value, 0);
        await hedgeToMakerProgress(makerProgress);
      }
    }

    const finalMakerProgress = (await readMakerProgress())
      .reduce((sum, value) => sum + value, 0);
    await hedgeToMakerProgress(finalMakerProgress);
    if (finalMakerProgress + 1e-8 < makerTotal) {
      throw new Error(
        `Maker target incomplete for ${symbol}: ${finalMakerProgress.toFixed(8)}/${makerTotal.toFixed(8)}`
      );
    }
  } finally {
    // Fully consumed maker orders require no cancel transaction.
    if (makerOrdersActive) await cancelMakerOrders(true);
  }
}
