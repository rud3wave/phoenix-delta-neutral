import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleParent = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = existsSync(resolve(moduleParent, 'package.json'))
  ? moduleParent
  : resolve(moduleParent, '..');
const LOCK_PATH = resolve(ROOT, '.phoenix-trading.lock');
const HALT_PATH = resolve(ROOT, '.phoenix-halt');

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireTradingLock(): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
        encoding: 'utf8',
        flag: 'wx',
      });
      return;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      let existingPid = 0;
      try {
        existingPid = Number(JSON.parse(readFileSync(LOCK_PATH, 'utf8')).pid);
      } catch {
        // Invalid lock files are stale.
      }
      if (processIsAlive(existingPid)) {
        throw new Error(`Trading process ${existingPid} is already active`);
      }
      try { unlinkSync(LOCK_PATH); } catch { /* another process may have won */ }
    }
  }
  throw new Error('Could not acquire the trading process lock');
}

export function releaseTradingLock(): void {
  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    if (Number(lock.pid) === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    // Missing or foreign lock: leave it alone.
  }
}

/** Когда ЭТОТ процесс запросил halt (0 = не запрашивал). */
let haltRequestedAtMs = 0;

export function requestTradingHalt(): void {
  haltRequestedAtMs = Date.now();
  writeFileSync(HALT_PATH, `${haltRequestedAtMs}\n`, 'utf8');
}

export function clearTradingHalt(): void {
  try { unlinkSync(HALT_PATH); } catch { /* already clear */ }
}

export function isTradingHalted(): boolean {
  return existsSync(HALT_PATH);
}

/** Halt активен, только если он запрошен ПОСЛЕ `sinceMs` (этим процессом
 * или другим — по mtime файла). Режим 2 сам ставит halt при старте, чтобы
 * остановить торгующий процесс; собственный цикл закрытия не должен из-за
 * этого останавливаться — он реагирует лишь на halt, возникший позже
 * (Ctrl+C или Force Close, запущенный во время закрытия). */
export function isTradingHaltedSince(sinceMs: number): boolean {
  if (!existsSync(HALT_PATH)) return false;
  if (haltRequestedAtMs > sinceMs) return true;
  try {
    return statSync(HALT_PATH).mtimeMs > sinceMs;
  } catch {
    return false;
  }
}
