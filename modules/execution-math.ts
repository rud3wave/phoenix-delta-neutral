import type { TraderFillRecord, TraderFundingEvent } from './phoenix-api.js';

export interface TaggedFill extends TraderFillRecord {
  wallet: string;
}

export interface TaggedFunding extends TraderFundingEvent {
  wallet: string;
}

export interface CycleMetrics {
  grossRealizedPnl: number;
  openingFees: number;
  closingFees: number;
  totalFees: number;
  funding: number;
  netPnl: number;
  actualVolume: number;
  openPriceGapPnl: number;
  closePriceGapPnl: number;
  totalPriceGapPnl: number;
  longOpenVwap: number | null;
  shortOpenVwap: number | null;
  longCloseVwap: number | null;
  shortCloseVwap: number | null;
  longOpenQuantity: number;
  shortOpenQuantity: number;
  longCloseQuantity: number;
  shortCloseQuantity: number;
}

interface PriceAccumulator {
  quantity: number;
  quote: number;
}

function finite(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function timestampMs(value: string | number): number {
  if (typeof value === 'number') {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== '') {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addPrice(acc: PriceAccumulator, quantity: number, price: number): void {
  if (quantity <= 0 || price <= 0) return;
  acc.quantity += quantity;
  acc.quote += quantity * price;
}

function vwap(acc: PriceAccumulator): number | null {
  return acc.quantity > 0 ? acc.quote / acc.quantity : null;
}

export function analyzeCycle(
  fills: TaggedFill[],
  fundingEvents: TaggedFunding[]
): CycleMetrics {
  const longOpen: PriceAccumulator = { quantity: 0, quote: 0 };
  const shortOpen: PriceAccumulator = { quantity: 0, quote: 0 };
  const longClose: PriceAccumulator = { quantity: 0, quote: 0 };
  const shortClose: PriceAccumulator = { quantity: 0, quote: 0 };

  let grossRealizedPnl = 0;
  let openingFees = 0;
  let closingFees = 0;
  let actualVolume = 0;

  for (const fill of fills) {
    const before = finite(fill.baseLotsBefore);
    const delta = finite(fill.baseLotsDelta);
    const quantity = Math.abs(delta);
    const price = finite(fill.price);
    const fee = Math.abs(finite(fill.fees));

    if (quantity <= 0) continue;

    const closesExisting = before !== 0 && Math.sign(before) !== Math.sign(delta);
    const closingQuantity = closesExisting ? Math.min(Math.abs(before), quantity) : 0;
    const openingQuantity = quantity - closingQuantity;

    openingFees += fee * (openingQuantity / quantity);
    closingFees += fee * (closingQuantity / quantity);
    grossRealizedPnl += finite(fill.realizedPnl);
    actualVolume += quantity * price;

    if (openingQuantity > 0) {
      addPrice(delta > 0 ? longOpen : shortOpen, openingQuantity, price);
    }
    if (closingQuantity > 0) {
      addPrice(before > 0 ? longClose : shortClose, closingQuantity, price);
    }
  }

  const funding = fundingEvents.reduce(
    (sum, event) => sum + finite(event.fundingPayment),
    0
  );
  const totalFees = openingFees + closingFees;
  const netPnl = grossRealizedPnl - totalFees + funding;

  const longOpenVwap = vwap(longOpen);
  const shortOpenVwap = vwap(shortOpen);
  const longCloseVwap = vwap(longClose);
  const shortCloseVwap = vwap(shortClose);

  const pairedOpen = Math.min(longOpen.quantity, shortOpen.quantity);
  const pairedClose = Math.min(longClose.quantity, shortClose.quantity);
  const openPriceGapPnl =
    longOpenVwap !== null && shortOpenVwap !== null
      ? (shortOpenVwap - longOpenVwap) * pairedOpen
      : 0;
  const closePriceGapPnl =
    longCloseVwap !== null && shortCloseVwap !== null
      ? (longCloseVwap - shortCloseVwap) * pairedClose
      : 0;

  return {
    grossRealizedPnl,
    openingFees,
    closingFees,
    totalFees,
    funding,
    netPnl,
    actualVolume,
    openPriceGapPnl,
    closePriceGapPnl,
    totalPriceGapPnl: openPriceGapPnl + closePriceGapPnl,
    longOpenVwap,
    shortOpenVwap,
    longCloseVwap,
    shortCloseVwap,
    longOpenQuantity: longOpen.quantity,
    shortOpenQuantity: shortOpen.quantity,
    longCloseQuantity: longClose.quantity,
    shortCloseQuantity: shortClose.quantity,
  };
}

export function formatSignedUsd(value: number, digits = 4): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}$`;
}

export function combineCycleMetrics(items: CycleMetrics[]): CycleMetrics {
  const sum = (key: keyof CycleMetrics): number => items.reduce((total, item) => {
    const value = item[key];
    return total + (typeof value === 'number' ? value : 0);
  }, 0);

  return {
    grossRealizedPnl: sum('grossRealizedPnl'),
    openingFees: sum('openingFees'),
    closingFees: sum('closingFees'),
    totalFees: sum('totalFees'),
    funding: sum('funding'),
    netPnl: sum('netPnl'),
    actualVolume: sum('actualVolume'),
    openPriceGapPnl: sum('openPriceGapPnl'),
    closePriceGapPnl: sum('closePriceGapPnl'),
    totalPriceGapPnl: sum('totalPriceGapPnl'),
    longOpenVwap: null,
    shortOpenVwap: null,
    longCloseVwap: null,
    shortCloseVwap: null,
    longOpenQuantity: sum('longOpenQuantity'),
    shortOpenQuantity: sum('shortOpenQuantity'),
    longCloseQuantity: sum('longCloseQuantity'),
    shortCloseQuantity: sum('shortCloseQuantity'),
  };
}
