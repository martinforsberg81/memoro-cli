/**
 * Every `changelog.d/` fragment must read as a fragment: one malformed
 * fragment stops `scripts/changelog-fold.js` at every later fold, so the
 * Unreleased section can never be built. Nothing else checks them. Reads the
 * fragments the fold reads (`listFragments`, on disk, no git call), and names
 * each malformed fragment in the failure.
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { listFragments } from '../../scripts/changelog-fold.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every changelog.d fragment reads as a fragment', () => {
  // listFragments reads each file through readFragment and keeps the error.
  const errors = listFragments(root)
    .filter((item) => item.error)
    .map((item) => `${item.name}: ${item.error}`);
  assert.deepStrictEqual(errors, []);
});
