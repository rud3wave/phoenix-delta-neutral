import assert from 'node:assert/strict';
import test from 'node:test';

import { closeLeaderFollower } from '../modules/close-strategy.js';
import { executePaired } from '../modules/paired-execution.js';
import type { PhoenixService } from '../modules/phoenix-service.js';

interface FakeService extends Pick<
  PhoenixService,
  | 'warmOrderClient'
  | 'getSignedPositionBaseUnits'
  | 'quantizeBaseUnits'
  | 'cancelAllOrders'
  | 'placePositionOrder'
  | 'getAddress'
> {}

test('executePaired hedges incremental maker fills instead of waiting for full fill', async () => {
  let makerPosition = 0;
  let takerPosition = 0;
  const hedgeSizes: number[] = [];
  let makerPlaced = false;

  const common = {
    warmOrderClient: async () => {},
    quantizeBaseUnits: async (_symbol: string, value: number) => Math.floor((value + 1e-10) * 1000) / 1000,
    cancelAllOrders: async () => {},
  };

  const maker: FakeService = {
    ...common,
    getAddress: () => 'maker-wallet',
    getSignedPositionBaseUnits: async () => makerPosition,
    placePositionOrder: async (params: any) => {
      assert.equal(params.executionType, 'post-only');
      if (!makerPlaced) {
        makerPlaced = true;
        setTimeout(() => { makerPosition = 0.4; }, 80);
        setTimeout(() => { makerPosition = 1; }, 380);
      }
      return { rfqId: 'maker', orderPrice: 100, makerReferencePrice: 100 };
    },
  };
  const taker: FakeService = {
    ...common,
    getAddress: () => 'taker-wallet',
    getSignedPositionBaseUnits: async () => takerPosition,
    placePositionOrder: async (params: any) => {
      assert.equal(params.executionType, 'market');
      hedgeSizes.push(params.overrideBaseUnits);
      takerPosition -= params.overrideBaseUnits;
      return { rfqId: 'taker' };
    },
  };

  await executePaired({
    symbol: 'ETH',
    makerSide: 'long',
    takerSide: 'short',
    makerTargets: [{ service: maker as PhoenixService, targetBaseUnits: 1 }],
    takerTargets: [{ service: taker as PhoenixService, targetBaseUnits: 1 }],
    haltCheck: () => false,
    maxMakerWaitSec: null,
  });

  assert.deepEqual(hedgeSizes, [0.4, 0.6]);
  assert.equal(makerPosition + takerPosition, 0);
});

test('strict close never degrades a maker failure to MARKET closes', async () => {
  let marketCloseCalls = 0;
  const common = {
    warmOrderClient: async () => {},
    quantizeBaseUnits: async (_symbol: string, value: number) => value,
    cancelAllOrders: async () => {},
    closePositionByMarket: async () => { marketCloseCalls++; },
  };
  const maker = {
    ...common,
    getAddress: () => 'maker-wallet',
    getSignedPositionBaseUnits: async () => -1,
    placePositionOrder: async () => { throw new Error('maker placement rejected'); },
  } as unknown as PhoenixService;
  const follower = {
    ...common,
    getAddress: () => 'follower-wallet',
    getSignedPositionBaseUnits: async () => 1,
    placePositionOrder: async () => { throw new Error('follower must wait for maker fill'); },
  } as unknown as PhoenixService;

  await assert.rejects(
    closeLeaderFollower([{ service: maker }], [{ service: follower }], 'ETH'),
    /maker placement rejected/
  );
  assert.equal(marketCloseCalls, 0);
});

test('executePaired cancels and re-prices an unfilled maker order after its max age', async () => {
  let makerPosition = 0;
  let followerPosition = 0;
  let makerPlacements = 0;
  let forcedCancels = 0;

  const maker = {
    getAddress: () => 'maker-wallet',
    warmOrderClient: async () => {},
    quantizeBaseUnits: async (_symbol: string, value: number) => value,
    getSignedPositionBaseUnits: async () => makerPosition,
    getMarketSnapshot: async () => ({ bestBid: 99.9, bestAsk: 100, midPrice: 99.95 }),
    cancelAllOrders: async (_symbol: string, _reduceOnly: boolean, force: boolean) => {
      if (force) forcedCancels++;
    },
    placePositionOrder: async () => {
      makerPlacements++;
      if (makerPlacements === 2) setTimeout(() => { makerPosition = 1; }, 20);
      return { rfqId: `maker-${makerPlacements}`, makerReferencePrice: 100 };
    },
  } as unknown as PhoenixService;
  const follower = {
    getAddress: () => 'follower-wallet',
    warmOrderClient: async () => {},
    quantizeBaseUnits: async (_symbol: string, value: number) => value,
    getSignedPositionBaseUnits: async () => followerPosition,
    cancelAllOrders: async () => {},
    placePositionOrder: async (params: any) => {
      followerPosition -= params.overrideBaseUnits;
      return { rfqId: 'follower' };
    },
  } as unknown as PhoenixService;

  await executePaired({
    symbol: 'ETH',
    makerSide: 'long',
    takerSide: 'short',
    makerTargets: [{ service: maker, targetBaseUnits: 1 }],
    takerTargets: [{ service: follower, targetBaseUnits: 1 }],
    haltCheck: () => false,
    maxMakerWaitSec: null,
    makerOrderMaxAgeSec: 0.05,
  });

  assert.equal(makerPlacements, 2);
  assert.equal(forcedCancels, 1);
  assert.equal(makerPosition + followerPosition, 0);
});
