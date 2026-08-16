// ============================================================
//  ALLOCATION — delta-neutral notional distribution
// ============================================================
// Разбивает общий notional между кошельками стороны так, чтобы
// эффективное плечо каждого кошелька осталось в [minLev, maxLev].
// Один проход, точная сумма, без перебора вариантов.
// ============================================================

export interface LeverageRange {
  min: number;
  max: number;
}

/** Диапазон суммарного notional, который сторона способна набрать. */
export function sideNotionalBounds(balances: number[], range: LeverageRange): { min: number; max: number } {
  const totalBalance = balances.reduce((sum, balance) => sum + balance, 0);
  return { min: totalBalance * range.min, max: totalBalance * range.max };
}

/**
 * Дозагрузка поверх открытых позиций: итоговый notional кошелька (старый +
 * новый) остаётся в [balance*min, balance*max], а обе стороны сводятся к
 * одному итогу finalTotal — дельта-нейтрально ВМЕСТЕ со старыми позициями.
 * Возвращает null, если вилка недостижима (старые позиции вне диапазона).
 */
export function planTopUp(
  longSide: Array<{ balance: number; existing: number }>,
  shortSide: Array<{ balance: number; existing: number }>,
  range: LeverageRange
): { longs: number[]; shorts: number[]; finalTotal: number } | null {
  const capsOf = (side: Array<{ balance: number; existing: number }>) =>
    side.map((w) => ({
      min: Math.max(0, w.balance * range.min - w.existing),
      max: Math.max(0, w.balance * range.max - w.existing),
    }));
  const capsL = capsOf(longSide);
  const capsS = capsOf(shortSide);
  const existL = longSide.reduce((s, w) => s + w.existing, 0);
  const existS = shortSide.reduce((s, w) => s + w.existing, 0);

  const sum = (caps: Array<{ min: number; max: number }>, f: (c: { min: number; max: number }) => number) =>
    caps.reduce((s, c) => s + f(c), 0);
  const lo = Math.max(existL + sum(capsL, (c) => c.min), existS + sum(capsS, (c) => c.min));
  const hi = Math.min(existL + sum(capsL, (c) => c.max), existS + sum(capsS, (c) => c.max));
  if (lo > hi + 1e-9) return null;

  const finalTotal = lo + Math.random() * (hi - lo);
  return {
    longs: distributeWithCaps(finalTotal - existL, capsL),
    shorts: distributeWithCaps(finalTotal - existS, capsS),
    finalTotal,
  };
}

/**
 * Разбивает total на части по caps: part_i ∈ [min_i, max_i], сумма — точно total.
 *
 * Рандом с look-ahead: кошелёк получает случайную долю, но хвосту всегда
 * оставляется достаточно ёмкости, поэтому решение находится за один проход,
 * если только total ∈ [Σmin, Σmax].
 */
export function distributeWithCaps(total: number, caps: Array<{ min: number; max: number }>): number[] {
  const n = caps.length;
  if (n === 0) return [];

  const totalMin = caps.reduce((sum, cap) => sum + cap.min, 0);
  const totalMax = caps.reduce((sum, cap) => sum + cap.max, 0);
  if (total < totalMin - 1e-9 || total > totalMax + 1e-9) {
    throw new Error(
      `distributeWithCaps: total ${total.toFixed(2)} вне диапазона [${totalMin.toFixed(2)}, ${totalMax.toFixed(2)}]`
    );
  }

  // Ёмкость хвоста: сколько (max - min) могут поглотить кошельки после i-го
  const suffixRoom = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffixRoom[i] = suffixRoom[i + 1]! + (caps[i]!.max - caps[i]!.min);
  }

  const parts = caps.map((cap) => cap.min);
  let surplus = total - totalMin;

  for (let i = 0; i < n && surplus > 1e-12; i++) {
    const room = caps[i]!.max - parts[i]!;
    // Обязательный минимум: иначе хвост не вместит остаток
    const mustTake = Math.max(0, surplus - suffixRoom[i + 1]!);
    const canTake = Math.min(room, surplus);
    const add = mustTake + Math.random() * (canTake - mustTake);
    parts[i] = parts[i]! + add;
    surplus -= add;
  }

  // Floating-point drift — в последний кошелёк
  const drift = total - parts.reduce((sum, part) => sum + part, 0);
  parts[n - 1] = parts[n - 1]! + drift;

  return parts;
}
