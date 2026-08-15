import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTransactionLink } from '../modules/utils.js';

test('transaction links hide raw signatures from plain logs', () => {
  assert.equal(formatTransactionLink('secret-signature', false), 'Transaction');
});

test('transaction links render a compact OSC-8 Solscan hyperlink in terminals', () => {
  const link = formatTransactionLink('abc123', true);
  assert.equal(link, '\u001B]8;;https://solscan.io/tx/abc123\u001B\\Transaction\u001B]8;;\u001B\\');
});
