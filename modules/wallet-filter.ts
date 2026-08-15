export type WalletIdFilterItem = string | [string, string];
export type WalletIdFilter = WalletIdFilterItem[];

interface WalletWithId {
  id: number;
}

function parseId(value: string): number {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('Invalid wallet ID filter');
  }

  const id = Number(normalized);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Invalid wallet ID filter');
  }
  return id;
}

export function filterWalletsById<T extends WalletWithId>(
  wallets: T[],
  filters: WalletIdFilter
): T[] {
  if (filters.length === 0) return wallets;

  const selected: T[] = [];
  const selectedIds = new Set<number>();
  const appendMatches = (predicate: (id: number) => boolean): void => {
    for (const wallet of wallets) {
      if (predicate(wallet.id) && !selectedIds.has(wallet.id)) {
        selected.push(wallet);
        selectedIds.add(wallet.id);
      }
    }
  };

  for (const filter of filters) {
    if (Array.isArray(filter)) {
      if (filter.length !== 2) throw new Error('Wallet ID range must contain exactly two values');
      const start = parseId(filter[0]);
      const end = parseId(filter[1]);
      if (start > end) throw new Error('Wallet ID range start exceeds end');
      appendMatches((id) => id >= start && id <= end);
      continue;
    }

    const normalized = filter.trim();
    const operator = normalized[0];
    if (operator === '<' || operator === '>') {
      const boundary = parseId(normalized.slice(1));
      appendMatches(operator === '<' ? (id) => id <= boundary : (id) => id >= boundary);
      continue;
    }

    const exactId = parseId(normalized);
    appendMatches((id) => id === exactId);
  }

  return selected;
}
