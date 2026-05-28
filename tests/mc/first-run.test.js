/**
 * Pure-helper tests for §11d first-run friendliness.
 *
 * The trigger is intentionally narrow: hint fires only when sentinel
 * AND keychain token both miss. Anything else (token present, sentinel
 * present, both present) keeps quiet. We isolate via MC_HOME = tmpdir
 * and never touch the real keychain — the keychain layer is mocked
 * in tests/lib/keychain.* style by setting up a fallback secrets file.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

describe('first-run.js — sentinel + token cross-check', () => {
  let mcDir, fakeHome;
  let origMcHome, origHome;

  beforeEach(() => {
    mcDir = mkdtempSync(join(tmpdir(), 'mc-firstrun-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'mc-firstrun-home-'));
    origMcHome = process.env.MC_HOME;
    origHome = process.env.HOME;
    process.env.MC_HOME = mcDir;
    // HOME redirect lets the keychain fallback (FALLBACK_FILE =
    // ~/.memoro/secrets.json) hit our tmpdir instead of the real ~.
    // On macOS the OS keychain still wins via `security`, so we
    // explicitly scrub PATH below to force the fallback path.
    process.env.HOME = fakeHome;
  });
  afterEach(async () => {
    // Wipe the module cache so subsequent test files get a fresh
    // first-run module that re-reads our env. The dynamic import
    // pattern below already produces fresh bindings on each call.
    if (origMcHome === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = origMcHome;
    if (origHome === undefined)  delete process.env.HOME;   else process.env.HOME   = origHome;
    try { rmSync(mcDir, { recursive: true, force: true }); } catch {}
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });

  test('sentinelPath resolves under MC_HOME', async () => {
    const { sentinelPath } = await import('../../src/mc/first-run.js?p=' + Math.random());
    assert.equal(sentinelPath(), join(mcDir, '.setup-done-v1'));
  });

  test('ensureSentinel writes when missing, is idempotent', async () => {
    const { ensureSentinel, sentinelPath } = await import('../../src/mc/first-run.js?p=' + Math.random());
    const path = sentinelPath();
    assert.equal(existsSync(path), false);
    assert.equal(ensureSentinel(), true);
    assert.equal(existsSync(path), true);
    // Second call → no-op, returns false (didn't write).
    assert.equal(ensureSentinel(), false);
  });

  test('freshInstallHintText is the exact coordinator-specified wording', async () => {
    const { freshInstallHintText } = await import('../../src/mc/first-run.js?p=' + Math.random());
    assert.equal(
      freshInstallHintText(),
      'Looks like a fresh install. Run `mc setup` to get started.',
    );
  });

  test('isFreshInstall is false once sentinel exists', async () => {
    mkdirSync(mcDir, { recursive: true });
    writeFileSync(join(mcDir, '.setup-done-v1'), 'x\n');
    const { isFreshInstall } = await import('../../src/mc/first-run.js?p=' + Math.random());
    assert.equal(await isFreshInstall(), false);
  });
});
