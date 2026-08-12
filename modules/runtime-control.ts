import {
  existsSync,
  readFileSync,
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

export function requestTradingHalt(): void {
  writeFileSync(HALT_PATH, `${Date.now()}\n`, 'utf8');
}

export function clearTradingHalt(): void {
  try { unlinkSync(HALT_PATH); } catch { /* already clear */ }
}

export function isTradingHalted(): boolean {
  return existsSync(HALT_PATH);
}
