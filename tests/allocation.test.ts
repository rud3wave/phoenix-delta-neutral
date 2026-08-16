import assert from 'node:assert/strict';
import test from 'node:test';

import { distributeWithCaps, planTopUp, sideNotionalBounds } from '../modules/allocation.js';

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

test('planTopUp without existing positions is a plain delta-neutral allocation', () => {
  for (let round = 0; round < 200; round++) {
    const longs = Array.from({ length: 3 }, () => ({ balance: 100 + Math.random() * 900, existing: 0 }));
    const shorts = Array.from({ length: 2 }, () => ({ balance: 100 + Math.random() * 900, existing: 0 }));
    const minLev = 3 + Math.random() * 4;
    const maxLev = minLev + 1 + Math.random() * 8;
    const range = { min: minLev, max: maxLev };

    const plan = planTopUp(longs, shorts, range);
    const sumBalL = longs.reduce((s, w) => s + w.balance, 0);
    const sumBalS = shorts.reduce((s, w) => s + w.balance, 0);
    const feasible =
      Math.max(sumBalL * minLev, sumBalS * minLev) <=
      Math.min(sumBalL * maxLev, sumBalS * maxLev) + 1e-9;
    if (!feasible) {
      assert.equal(plan, null, 'disjoint side ranges must yield null');
      continue;
    }
    assert.ok(plan, 'plan must exist when side ranges overlap');

    const sumL = plan!.longs.reduce((s, x) => s + x, 0);
    const sumS = plan!.shorts.reduce((s, x) => s + x, 0);
    assert.ok(Math.abs(sumL - sumS) < 1e-6, `sides differ: ${sumL} vs ${sumS}`);

    longs.forEach((w, i) => {
      assert.ok(plan!.longs[i]! >= w.balance * range.min - 1e-6);
      assert.ok(plan!.longs[i]! <= w.balance * range.max + 1e-6);
    });
    shorts.forEach((w, i) => {
      assert.ok(plan!.shorts[i]! >= w.balance * range.min - 1e-6);
      assert.ok(plan!.shorts[i]! <= w.balance * range.max + 1e-6);
    });
  }
});

test('planTopUp keeps final totals equal including existing positions', () => {
  for (let round = 0; round < 200; round++) {
    const longs = [
      { balance: 600, existing: 500 + Math.random() * 500 },
      { balance: 600, existing: 500 + Math.random() * 500 },
    ];
    const shorts = [
      { balance: 600, existing: Math.random() * 500 },
      { balance: 600, existing: Math.random() * 500 },
    ];
    const plan = planTopUp(longs, shorts, { min: 1, max: 10 });
    assert.ok(plan, 'plan must exist when caps are wide');

    const finalL = longs.reduce((s, w, i) => s + w.existing + plan!.longs[i]!, 0);
    const finalS = shorts.reduce((s, w, i) => s + w.existing + plan!.shorts[i]!, 0);
    assert.ok(Math.abs(finalL - finalS) < 1e-6, `final totals differ: ${finalL} vs ${finalS}`);

    longs.forEach((w, i) => {
      assert.ok(plan!.longs[i]! >= -1e-9, 'additions are non-negative');
      assert.ok(w.existing + plan!.longs[i]! <= w.balance * 10 + 1e-6, 'final within max leverage');
    });
    shorts.forEach((w, i) => {
      assert.ok(plan!.shorts[i]! >= -1e-9, 'additions are non-negative');
      assert.ok(w.existing + plan!.shorts[i]! <= w.balance * 10 + 1e-6, 'final within max leverage');
    });
  }
});

test('planTopUp returns null when existing positions cannot be netted', () => {
  // Лонг уже за максимумом плеча: итог лонга зажат на 5000, шорт столько не тянет
  const plan = planTopUp(
    [{ balance: 100, existing: 5000 }],
    [{ balance: 100, existing: 0 }],
    { min: 1, max: 10 }
  );
  assert.equal(plan, null);
});

test('planTopUp yields zero additions when everyone is already at max leverage', () => {
  const plan = planTopUp(
    [{ balance: 100, existing: 1000 }, { balance: 100, existing: 1000 }],
    [{ balance: 100, existing: 1000 }, { balance: 100, existing: 1000 }],
    { min: 7, max: 10 }
  );
  assert.ok(plan);
  for (const add of [...plan!.longs, ...plan!.shorts]) {
    assert.ok(Math.abs(add) < 1e-9);
  }
  assert.ok(Math.abs(plan!.finalTotal - 2000) < 1e-6);
});
