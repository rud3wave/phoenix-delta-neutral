import assert from 'node:assert/strict';
import test from 'node:test';

import { filterWalletsById } from '../modules/wallet-filter.js';
import { parsePrivateKeyEntries } from '../modules/wallet.js';

const wallets = Array.from({ length: 105 }, (_, index) => ({ id: index + 1 }));

test('wallet ID filter supports exact IDs and inclusive boundaries', () => {
  assert.deepEqual(filterWalletsById(wallets, ['5']).map(({ id }) => id), [5]);
  assert.deepEqual(filterWalletsById(wallets, ['>103']).map(({ id }) => id), [103, 104, 105]);
  assert.deepEqual(filterWalletsById(wallets, ['<3']).map(({ id }) => id), [1, 2, 3]);
});

test('wallet ID filter combines inclusive ranges and removes duplicates', () => {
  const filtered = filterWalletsById(wallets, ['3', ['10', '13'], '20', '>103', ['12', '20']]);
  assert.deepEqual(
    filtered.map(({ id }) => id),
    [3, 10, 11, 12, 13, 20, 103, 104, 105, 14, 15, 16, 17, 18, 19]
  );
});

test('empty wallet ID filter keeps every wallet and invalid filters fail fast', () => {
  assert.equal(filterWalletsById(wallets, []), wallets);
  assert.throws(() => filterWalletsById(wallets, ['>abc']), /Invalid wallet ID filter/);
  assert.throws(() => filterWalletsById(wallets, [['10', '1']]), /exceeds end/);
});

test('wallet IDs use physical private key line numbers', () => {
  const entries = parsePrivateKeyEntries('first-key\n\n# hidden comment\nfourth-key\r\n fifth-key ');
  assert.deepEqual(entries, [
    { privateKey: 'first-key', id: 1 },
    { privateKey: 'fourth-key', id: 4 },
    { privateKey: 'fifth-key', id: 5 },
  ]);
});
