// ============================================================
//  UTILS — Simple helpers for Phoenix Delta-Neutral Bot
// ============================================================

/** Sleep for N seconds */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Sleep for a random duration from [min, max] range (seconds) */
export async function sleepByRange(range: readonly number[], label?: string): Promise<void> {
  const seconds = getRandomNumber(range);
  if (label) console.log(`  ⏳ ${label}: ${seconds.toFixed(1)}s`);
  await sleep(seconds);
}

/** Random number from [min, max] range. If round=true, returns integer */
export function getRandomNumber(range: readonly number[], round = false): number {
  const min = range[0]!;
  const max = range[1]!;
  const value = min + Math.random() * (max - min);
  return round ? Math.round(value) : value;
}

/** Alias for getRandomNumber */
export function getRandomNumberRange(range: readonly number[]): number {
  return getRandomNumber(range);
}

/** Check if range is effectively empty (both values are 0) */
export function isRangeEmpty(range: readonly number[]): boolean {
  return range[0] === 0 && range[1] === 0;
}

/** Escape special characters for Telegram MarkdownV2 */
export function escapeMarkdownV2(text: string): string {
  return text?.replace(/([_*[\]()~`>#+=|{}.!\\|-])/g, '\\$1') || '';
}

/** Format USD amount for display */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Shorten address for display: AbCd...WxYz */
export function shortAddr(addr: string): string {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

/** Fisher-Yates shuffle (returns new array) */
export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Trim amount for log display */
export function trimAmount(amount: number, token = 'USDC'): string {
  return `${amount.toFixed(2)} ${token}`;
}
