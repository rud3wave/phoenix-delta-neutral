import type { PhoenixService } from './phoenix-service.js';
import type {
  TraderFillRecord,
  TraderFundingEvent,
} from './phoenix-api.js';
import {
  analyzeCycle,
  formatSignedUsd,
  timestampMs,
  type CycleMetrics,
  type TaggedFill,
  type TaggedFunding,
} from './execution-math.js';
import { shortAddr, sleep } from './utils.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 30;
const HISTORY_INGEST_RETRIES = 6;

async function fetchFillsSince(
  service: PhoenixService,
  symbol: string,
  startTimeMs: number,
  endTimeMs: number
): Promise<TraderFillRecord[]> {
  const out: TraderFillRecord[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await service.getApiClient().getTraderTradesHistory(
      service.getAddress(),
      { marketSymbol: symbol, limit: PAGE_LIMIT, cursor }
    );
    const rows = response.data ?? [];
    out.push(...rows.filter((fill) => {
      const time = timestampMs(fill.timestamp);
      return time >= startTimeMs && time <= endTimeMs;
    }));

    const oldest = rows.reduce(
      (min, fill) => Math.min(min, timestampMs(fill.timestamp)),
      Number.POSITIVE_INFINITY
    );
    if (!response.hasMore || !response.nextCursor || oldest <= startTimeMs) break;
    cursor = response.nextCursor;
  }

  return out;
}

async function fetchFundingSince(
  service: PhoenixService,
  symbol: string,
  startTimeMs: number,
  endTimeMs: number
): Promise<TraderFundingEvent[]> {
  const out: TraderFundingEvent[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await service.getApiClient().getTraderFundingHistory(
      service.getAddress(),
      {
        symbol,
        startTime: startTimeMs,
        endTime: endTimeMs,
        limit: PAGE_LIMIT,
        cursor,
      }
    );
    const rows = response.events ?? [];
    out.push(...rows.filter((event) => {
      const time = timestampMs(event.timestamp);
      return time >= startTimeMs && time <= endTimeMs;
    }));

    if (!response.hasMore || !response.nextCursor) break;
    cursor = response.nextCursor;
  }

  return out;
}

async function fetchRecentFills(
  service: PhoenixService,
  symbol: string
): Promise<TraderFillRecord[]> {
  const out: TraderFillRecord[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await service.getApiClient().getTraderTradesHistory(
      service.getAddress(),
      { marketSymbol: symbol, limit: PAGE_LIMIT, cursor }
    );
    out.push(...(response.data ?? []));
    if (!response.hasMore || !response.nextCursor) break;
    cursor = response.nextCursor;
  }

  return out;
}

export async function discoverOpenCycleStart(
  services: PhoenixService[],
  symbol: string
): Promise<number> {
  const starts = await Promise.all(services.map(async (service) => {
    const fills = await fetchRecentFills(service, symbol);
    const sorted = [...fills].sort(
      (a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp)
    );

    const opening = sorted.find((fill) => {
      const before = Number(fill.baseLotsBefore);
      const after = Number(fill.baseLotsAfter);
      return before === 0 && after !== 0;
    });

    return opening ? timestampMs(opening.timestamp) : Number.POSITIVE_INFINITY;
  }));

  const earliest = Math.min(...starts);
  if (!Number.isFinite(earliest)) {
    throw new Error(`Could not locate the opening fills for ${symbol}`);
  }
  return earliest - 1000;
}

export interface CollectedCycleReport {
  metrics: CycleMetrics;
  byWallet: Map<string, CycleMetrics>;
  startTimeMs: number;
  endTimeMs: number;
}

export async function collectCycleReport(
  services: PhoenixService[],
  symbol: string,
  startTimeMs: number,
  endTimeMs = Date.now()
): Promise<CollectedCycleReport> {
  const taggedFills: TaggedFill[] = [];
  const taggedFunding: TaggedFunding[] = [];
  const byWallet = new Map<string, CycleMetrics>();

  await Promise.all(services.map(async (service) => {
    const wallet = shortAddr(service.getAddress());
    let fills: TraderFillRecord[] = [];
    for (let attempt = 0; attempt < HISTORY_INGEST_RETRIES; attempt++) {
      if (attempt > 0) await sleep(2);
      fills = await fetchFillsSince(service, symbol, startTimeMs, endTimeMs);
      const newest = [...fills].sort(
        (a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp)
      )[0];
      if (newest && Math.abs(Number(newest.baseLotsAfter)) <= 1e-10) break;
    }
    const funding = await fetchFundingSince(service, symbol, startTimeMs, endTimeMs);
    const walletFills = fills.map((fill) => ({ ...fill, wallet }));
    const walletFunding = funding.map((event) => ({ ...event, wallet }));
    taggedFills.push(...walletFills);
    taggedFunding.push(...walletFunding);
    byWallet.set(wallet, analyzeCycle(walletFills, walletFunding));
  }));

  return {
    metrics: analyzeCycle(taggedFills, taggedFunding),
    byWallet,
    startTimeMs,
    endTimeMs,
  };
}

export function formatCycleMetrics(metrics: CycleMetrics): string[] {
  const costPer100k = metrics.actualVolume > 0
    ? (-metrics.netPnl / metrics.actualVolume) * 100_000
    : 0;

  const lines = [
    `📊 Full-cycle PnL: ${formatSignedUsd(metrics.netPnl)}`,
    `💸 Fees: -${metrics.totalFees.toFixed(2)}$ ` +
      `(open -${metrics.openingFees.toFixed(2)}$ | close -${metrics.closingFees.toFixed(2)}$)`,
    `↔️ Разница цен LONG/SHORT: ${formatSignedUsd(metrics.totalPriceGapPnl)}`,
    `💰 Turnover (open + close): $${metrics.actualVolume.toFixed(2)} | ` +
      `Cost: ${costPer100k.toFixed(2)}$ / 100k`,
  ];
  if (Math.abs(metrics.funding) >= 0.01) {
    lines.splice(3, 0, `⏱ Funding: ${formatSignedUsd(metrics.funding)}`);
  }
  return lines;
}
