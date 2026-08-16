import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTransactionLink, isMidStable, shortError } from '../modules/utils.js';

test('shortError collapses simulation dumps to one Program log line', () => {
  const dump = new Error(
    'Simulation failed. \nMessage: Transaction simulation failed. \nLogs: \n[\n' +
    '  "Program log: Failed to perform MatchingEngine::place_order",\n' +
    '  "Program log: IOC order does not meet minimum requirements. Min base: 2465",\n' +
    '  "Program EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih invoke [2]",\n]'
  );
  const line = shortError(dump);
  assert.ok(!line.includes('\n'));
  assert.ok(line.startsWith('Failed to perform MatchingEngine::place_order'));
  assert.ok(line.length <= 141);
});

test('shortError falls back to the first line and truncates', () => {
  assert.equal(shortError(new Error('boom\nstack stack')), 'boom');
  assert.equal(shortError('plain'), 'plain');
  const long = shortError(new Error('x'.repeat(500)));
  assert.equal(long.length, 141);
  assert.ok(long.endsWith('…'));
});

test('transaction links hide raw signatures from plain logs', () => {
  assert.equal(formatTransactionLink('secret-signature', false), 'Transaction');
});

test('transaction links render a compact OSC-8 Solscan hyperlink in terminals', () => {
  const link = formatTransactionLink('abc123', true);
  assert.equal(link, '\u001B]8;;https://solscan.io/tx/abc123\u001B\\Transaction\u001B]8;;\u001B\\');
});

test('isMidStable accepts a flat market covering the window', () => {
  const samples = [
    { t: 0, mid: 1000 },
    { t: 2000, mid: 1000.1 },
    { t: 4000, mid: 999.95 },
    { t: 6000, mid: 1000.05 },
  ];
  assert.equal(isMidStable(samples, 6000, 6000, 0.03), true);
});

test('isMidStable rejects drift above the threshold', () => {
  const samples = [
    { t: 0, mid: 1000 },
    { t: 3000, mid: 1002 },
    { t: 6000, mid: 1004 },
  ];
  assert.equal(isMidStable(samples, 6000, 6000, 0.03), false);
});

test('isMidStable rejects a too-short window or missing data', () => {
  const single = [{ t: 5000, mid: 1000 }];
  assert.equal(isMidStable(single, 6000, 6000, 0.03), false);

  const shortWindow = [
    { t: 4500, mid: 1000 },
    { t: 6000, mid: 1000 },
  ];
  assert.equal(isMidStable(shortWindow, 6000, 6000, 0.03), false);

  assert.equal(isMidStable([], 6000, 6000, 0.03), false);
});
