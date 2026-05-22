/**
 * Tests for the package-version helper.
 *
 * Reads from the real package.json that ships with the repo, so the
 * assertion is loose — we just confirm we get a parseable semver-like
 * string. Version-bumping in package.json shouldn't break this test.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { getPackageVersion, _resetVersionCache } from '../../src/lib/version.js';

describe('getPackageVersion', () => {
  test('returns the package.json version as a string', async () => {
    _resetVersionCache();
    const v = await getPackageVersion();
    assert.equal(typeof v, 'string');
    assert.match(v, /^\d+\.\d+\.\d+/);
  });

  test('caches the version after first read', async () => {
    _resetVersionCache();
    const a = await getPackageVersion();
    const b = await getPackageVersion();
    assert.equal(a, b);
  });
});
