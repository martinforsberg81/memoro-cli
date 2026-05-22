/**
 * Tests for the staleness detector + its renderers.
 *
 * Pure functions — no I/O. Drive the matrix of (installed, hook-stamp,
 * npm-cache) combinations and assert (a) reasons are detected accurately
 * and (b) the rendered copy points the user at both update steps.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  detectStaleness,
  formatStaleLensBanner,
  formatStaleStatusLine,
} from '../../src/lib/staleness.js';

describe('detectStaleness', () => {
  test('returns stale=false when nothing is newer', () => {
    const out = detectStaleness({
      installedVersion: '0.2.0',
      hookVersion: '0.2.0',
      latestVersion: '0.2.0',
    });
    assert.equal(out.stale, false);
    assert.deepEqual(out.reasons, []);
  });

  test('flags "hooks" when installed binary is newer than the hook stamp', () => {
    const out = detectStaleness({
      installedVersion: '0.3.0',
      hookVersion: '0.2.0',
      latestVersion: '0.3.0',
    });
    assert.equal(out.stale, true);
    assert.deepEqual(out.reasons, ['hooks']);
  });

  test('flags "npm" when npm cache is newer than installed', () => {
    const out = detectStaleness({
      installedVersion: '0.2.0',
      hookVersion: '0.2.0',
      latestVersion: '0.3.0',
    });
    assert.equal(out.stale, true);
    assert.deepEqual(out.reasons, ['npm']);
  });

  test('flags both reasons when binary is ahead of hooks AND npm is ahead of binary', () => {
    const out = detectStaleness({
      installedVersion: '0.3.0',
      hookVersion: '0.2.0',
      latestVersion: '0.4.0',
    });
    assert.equal(out.stale, true);
    assert.deepEqual(out.reasons, ['hooks', 'npm']);
  });

  test('treats missing hook-version stamp as "unknown, not stale"', () => {
    // Pre-stamp installs (or non-claude-code adapters) have no version.
    const out = detectStaleness({
      installedVersion: '0.3.0',
      hookVersion: null,
      latestVersion: '0.3.0',
    });
    assert.equal(out.stale, false);
    assert.deepEqual(out.reasons, []);
  });

  test('treats missing latestVersion as "unknown, not stale"', () => {
    const out = detectStaleness({
      installedVersion: '0.2.0',
      hookVersion: '0.2.0',
      latestVersion: null,
    });
    assert.equal(out.stale, false);
  });

  test('ignores unparseable versions instead of throwing', () => {
    const out = detectStaleness({
      installedVersion: 'not-semver',
      hookVersion: '0.2.0',
      latestVersion: '0.3.0',
    });
    // isSemverGreaterThan returns false for unparseable inputs, so neither
    // reason triggers — the user just won't get a banner. That's an
    // acceptable degradation given missing/odd version strings should be
    // vanishingly rare in practice.
    assert.equal(out.stale, false);
  });
});

describe('formatStaleLensBanner', () => {
  test('mentions both update steps and the slash command', () => {
    const banner = formatStaleLensBanner({
      installedVersion: '0.3.0',
      hookVersion: '0.2.0',
      latestVersion: null,
      reasons: ['hooks'],
    });
    assert.match(banner, /memoro-cli update available/);
    assert.match(banner, /npm install -g memoro-cli/);
    assert.match(banner, /memoro-cli hook install --tool claude-code/);
    assert.match(banner, /\/memoro-update/);
  });

  test('prefers the npm version detail when both reasons present', () => {
    const banner = formatStaleLensBanner({
      installedVersion: '0.3.0',
      hookVersion: '0.2.0',
      latestVersion: '0.4.0',
      reasons: ['hooks', 'npm'],
    });
    // npm has higher signal (true new release) — surface that first.
    assert.match(banner, /Latest on npm: 0\.4\.0/);
    assert.match(banner, /Installed: 0\.3\.0/);
  });

  test('falls back to hook-stamp detail when only hooks are stale', () => {
    const banner = formatStaleLensBanner({
      installedVersion: '0.3.0',
      hookVersion: '0.2.0',
      latestVersion: null,
      reasons: ['hooks'],
    });
    assert.match(banner, /Hooks last installed for: 0\.2\.0/);
  });
});

describe('formatStaleStatusLine', () => {
  test('returns null when no reasons', () => {
    const line = formatStaleStatusLine({
      installedVersion: '0.2.0',
      hookVersion: '0.2.0',
      latestVersion: '0.2.0',
      reasons: [],
    });
    assert.equal(line, null);
  });

  test('reports the npm gap concisely', () => {
    const line = formatStaleStatusLine({
      installedVersion: '0.2.0',
      hookVersion: '0.2.0',
      latestVersion: '0.3.0',
      reasons: ['npm'],
    });
    assert.match(line, /npm has 0\.3\.0/);
    assert.match(line, /you have 0\.2\.0/);
  });

  test('reports the hook gap with the re-run hint', () => {
    const line = formatStaleStatusLine({
      installedVersion: '0.3.0',
      hookVersion: '0.2.0',
      latestVersion: null,
      reasons: ['hooks'],
    });
    assert.match(line, /hooks stamped 0\.2\.0/);
    assert.match(line, /binary is 0\.3\.0/);
    assert.match(line, /memoro-cli hook install/);
  });

  test('joins both gaps with a semicolon when both present', () => {
    const line = formatStaleStatusLine({
      installedVersion: '0.3.0',
      hookVersion: '0.2.0',
      latestVersion: '0.4.0',
      reasons: ['hooks', 'npm'],
    });
    assert.match(line, /npm has 0\.4\.0/);
    assert.match(line, /hooks stamped 0\.2\.0/);
    assert.match(line, /;/);
  });
});
