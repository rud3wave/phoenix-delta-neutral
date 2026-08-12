import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeCycle,
  combineCycleMetrics,
  timestampMs,
  type TaggedFill,
} from '../modules/execution-math.js';

function fill(overrides: Partial<TaggedFill>): TaggedFill {
  return {
    wallet: 'test-wallet',
    marketSymbol: 'ETH',
    signature: null,
    fillId: null,
    timestamp: 1_700_000_000,
    baseLotsBefore: '0',
    baseLotsAfter: '0',
    baseLotsDelta: '0',
    price: '0',
    realizedPnl: '0',
    fees: '0',
    liquidity: 'maker',
    tradeType: 'limit',
    instructionType: 'PlaceOrder',
    ...overrides,
  };
}

test('analyzeCycle includes both fee legs, funding and LONG/SHORT price gaps', () => {
  const quantity = 9.519;
  const fills: TaggedFill[] = [
    fill({ baseLotsAfter: `${quantity}`, baseLotsDelta: `${quantity}`, price: '3500', fees: '3.2' }),
    fill({ wallet: 'short', baseLotsAfter: `-${quantity}`, baseLotsDelta: `-${quantity}`, price: '3498.648', fees: '3.27721' }),
    fill({ baseLotsBefore: `${quantity}`, baseLotsAfter: '0', baseLotsDelta: `-${quantity}`, price: '3499', realizedPnl: '-9.519', fees: '3.25' }),
    fill({ wallet: 'short', baseLotsBefore: `-${quantity}`, baseLotsAfter: '0', baseLotsDelta: `${quantity}`, price: '3499.718', realizedPnl: '-10.2138', fees: '3.281918' }),
  ];

  const metrics = analyzeCycle(fills, [{
    wallet: 'test-wallet',
    timestamp: 1_700_000_100,
    symbol: 'ETH',
    fundingPayment: '0.000118',
    fundingRatePercentage: '0',
    positionSize: `${quantity}`,
    positionSide: 'long',
  }]);

  assert.ok(Math.abs(metrics.openingFees - 6.47721) < 1e-9);
  assert.ok(Math.abs(metrics.closingFees - 6.531918) < 1e-9);
  assert.ok(Math.abs(metrics.grossRealizedPnl - -19.7328) < 1e-9);
  assert.ok(Math.abs(metrics.openPriceGapPnl - -12.869688) < 1e-6);
  assert.ok(Math.abs(metrics.closePriceGapPnl - -6.834642) < 1e-6);
  assert.ok(Math.abs(metrics.netPnl - -32.74181) < 1e-9);
});

test('flip fill splits fees between closing and opening portions', () => {
  const metrics = analyzeCycle([
    fill({
      baseLotsBefore: '2',
      baseLotsAfter: '-1',
      baseLotsDelta: '-3',
      price: '100',
      fees: '3',
      realizedPnl: '-2',
    }),
  ], []);

  assert.equal(metrics.closingFees, 2);
  assert.equal(metrics.openingFees, 1);
  assert.equal(metrics.longCloseQuantity, 2);
  assert.equal(metrics.shortOpenQuantity, 1);
});

test('timestamps and aggregate metrics remain stable', () => {
  assert.equal(timestampMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(timestampMs('1700000000000'), 1_700_000_000_000);

  const one = analyzeCycle([fill({ baseLotsAfter: '1', baseLotsDelta: '1', price: '10', fees: '1' })], []);
  const combined = combineCycleMetrics([one, one]);
  assert.equal(combined.openingFees, 2);
  assert.equal(combined.actualVolume, 20);
});
