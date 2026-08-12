import assert from 'node:assert/strict';
import test from 'node:test';

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
  });

  assert.deepEqual(hedgeSizes, [0.4, 0.6]);
  assert.equal(makerPosition + takerPosition, 0);
});
