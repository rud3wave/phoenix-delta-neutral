import assert from 'node:assert/strict';
import test from 'node:test';

import { distributeWithCaps, sideNotionalBounds } from '../modules/allocation.js';

test('distributeWithCaps keeps the exact total inside per-wallet caps', () => {
  for (let round = 0; round < 200; round++) {
    const n = 1 + Math.floor(Math.random() * 5);
    const balances = Array.from({ length: n }, () => 10 + Math.random() * 990);
    const minLev = 3 + Math.random() * 4;
    const maxLev = minLev + 1 + Math.random() * 8;
    const caps = balances.map((balance) => ({
      min: balance * minLev,
      max: balance * maxLev,
    }));

    const totalMin = caps.reduce((sum, cap) => sum + cap.min, 0);
    const totalMax = caps.reduce((sum, cap) => sum + cap.max, 0);
    const total = totalMin + Math.random() * (totalMax - totalMin);

    const parts = distributeWithCaps(total, caps);
    assert.equal(parts.length, n);

    const sum = parts.reduce((acc, part) => acc + part, 0);
    assert.ok(Math.abs(sum - total) < 1e-6, `sum ${sum} != total ${total}`);

    parts.forEach((part, index) => {
      assert.ok(part >= caps[index]!.min - 1e-9, `part ${part} below min ${caps[index]!.min}`);
      assert.ok(part <= caps[index]!.max + 1e-9, `part ${part} above max ${caps[index]!.max}`);
    });
  }
});

test('distributeWithCaps never starves the tail wallets', () => {
  // Узкое горло: последний кошелёк обязан получить минимум 10, иначе сумму не собрать
  for (let round = 0; round < 200; round++) {
    const parts = distributeWithCaps(11, [
      { min: 0, max: 10 },
      { min: 10, max: 10 },
    ]);
    assert.ok(Math.abs(parts[1]! - 10) < 1e-9);
    assert.ok(Math.abs(parts[0]! - 1) < 1e-9);
  }
});

test('distributeWithCaps works for a single wallet and throws outside bounds', () => {
  const parts = distributeWithCaps(123, [{ min: 100, max: 200 }]);
  assert.ok(Math.abs(parts[0]! - 123) < 1e-9);

  assert.throws(() => distributeWithCaps(50, [{ min: 100, max: 200 }]));
  assert.throws(() => distributeWithCaps(250, [{ min: 100, max: 200 }]));
  assert.equal(distributeWithCaps(100, []).length, 0);
});

test('sideNotionalBounds scales with total balance and leverage range', () => {
  const bounds = sideNotionalBounds([100, 200], { min: 7, max: 10 });
  assert.ok(Math.abs(bounds.min - 2100) < 1e-9);
  assert.ok(Math.abs(bounds.max - 3000) < 1e-9);
});
