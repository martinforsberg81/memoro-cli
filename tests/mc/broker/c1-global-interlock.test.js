import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createC1GlobalInterlockForTesting } from '../../../src/mc/broker/c1-global-interlock.js';

const INSTALL_IDENTITY = 'a'.repeat(64);

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-interlock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initial = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-before-c1-install',
    installIdentity: INSTALL_IDENTITY,
  });
  assert.deepEqual(initial.acquireC1(), {
    ok: false,
    reason: 'c1-clean-restart-required',
  });
  return {
    root,
    interlock: createC1GlobalInterlockForTesting({
      root,
      bootId: 'boot-after-c1-install',
      installIdentity: INSTALL_IDENTITY,
      ...options,
    }),
  };
}

const provider = Object.freeze({
  sessionId: 'sess_interlock_test',
  runtimeGeneration: 'f55e4b76-042a-478f-b9f0-1e56786b9c9c',
});

test('C1 global interlock holds private provider evidence before spawn and excludes C1', (t) => {
  const { root, interlock } = fixture(t);
  const activeProvider = interlock.acquireProvider(provider);
  assert.equal(activeProvider.ok, true);

  const markersRoot = join(root, 'providers');
  const [marker] = requireEntries(markersRoot);
  const markerPath = join(markersRoot, marker);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(markersRoot).mode & 0o777, 0o700);
  assert.equal(statSync(markerPath).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(markerPath, 'utf8'))).sort(), [
    'nonce', 'runtime_generation', 'schema', 'session_id',
  ]);

  assert.deepEqual(interlock.acquireC1(), {
    ok: false,
    reason: 'provider-marker-active',
  });
  assert.equal(activeProvider.lease.release().ok, true);

  const activeC1 = interlock.acquireC1();
  assert.equal(activeC1.ok, true);
  assert.deepEqual(interlock.acquireProvider(provider), {
    ok: false,
    reason: 'c1-global-lock-active',
  });
  assert.equal(activeC1.lease.release().ok, true);
});

test('C1 requires one clean boot after its install epoch while providers remain usable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-interlock-epoch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installedThisBoot = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-install',
    installIdentity: INSTALL_IDENTITY,
  });
  const providerLease = installedThisBoot.acquireProvider(provider);
  assert.equal(providerLease.ok, true);
  assert.equal(providerLease.lease.release().ok, true);
  assert.deepEqual(installedThisBoot.acquireC1(), {
    ok: false,
    reason: 'c1-clean-restart-required',
  });

  const afterRestart = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-clean',
    installIdentity: INSTALL_IDENTITY,
  });
  assert.equal(afterRestart.acquireC1().ok, true);
});

test('a missing install receipt disables only C1, not ordinary providers', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-interlock-no-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const interlock = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-without-receipt',
    installIdentity: null,
  });
  const providerLease = interlock.acquireProvider(provider);
  assert.equal(providerLease.ok, true);
  assert.equal(providerLease.lease.release().ok, true);
  assert.deepEqual(interlock.acquireC1(), {
    ok: false,
    reason: 'c1-clean-restart-required',
  });
});

test('C1 requires a new clean boot when the installed containment release changes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-interlock-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const firstRelease = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-before-first-release',
    installIdentity: 'a'.repeat(64),
  });
  assert.equal(firstRelease.acquireC1().ok, false);
  const firstReleaseAfterRestart = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-running-first-release',
    installIdentity: 'a'.repeat(64),
  });
  const firstC1 = firstReleaseAfterRestart.acquireC1();
  assert.equal(firstC1.ok, true);
  assert.equal(firstC1.lease.release().ok, true);

  const upgradedSameBoot = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-running-first-release',
    installIdentity: 'b'.repeat(64),
  });
  const providerLease = upgradedSameBoot.acquireProvider(provider);
  assert.equal(providerLease.ok, true, 'ordinary providers remain usable after an upgrade');
  assert.equal(providerLease.lease.release().ok, true);
  assert.deepEqual(upgradedSameBoot.acquireC1(), {
    ok: false,
    reason: 'c1-clean-restart-required',
  });

  const upgradedAfterRestart = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-running-second-release',
    installIdentity: 'b'.repeat(64),
  });
  const secondC1 = upgradedAfterRestart.acquireC1();
  assert.equal(secondC1.ok, true);
  assert.equal(secondC1.lease.release().ok, true);

  const rolledBackSameBoot = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-running-second-release',
    installIdentity: 'a'.repeat(64),
  });
  assert.deepEqual(rolledBackSameBoot.acquireC1(), {
    ok: false,
    reason: 'c1-clean-restart-required',
  });

  const rollbackAfterRestart = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-running-rollback-release',
    installIdentity: 'a'.repeat(64),
  });
  assert.equal(rollbackAfterRestart.acquireC1().ok, true);
});

test('C1/provider race is fail-closed whichever side creates its evidence first', (t) => {
  const providerFirst = fixture(t);
  const firstProvider = providerFirst.interlock.acquireProvider(provider);
  assert.equal(firstProvider.ok, true);
  assert.equal(providerFirst.interlock.acquireC1().ok, false,
    'C1 must see a marker that was created before its exclusive lock');
  firstProvider.lease.release();

  let providerDuringScan = null;
  let interlock = null;
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-interlock-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-before-race',
    installIdentity: INSTALL_IDENTITY,
  }).acquireC1();
  interlock = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-during-race',
    installIdentity: INSTALL_IDENTITY,
    beforeC1ProviderScan() {
      providerDuringScan = interlock.acquireProvider(provider);
    },
  });
  const c1 = interlock.acquireC1();
  assert.equal(providerDuringScan.ok, false,
    'a provider marker created after C1 lock acquisition must observe the lock before spawn');
  assert.equal(c1.ok, true,
    'the failed provider removes its own evidence; C1 may continue only then');
  c1.lease.release();
});

test('stale C1 and provider evidence is never reaped from PID guesses', (t) => {
  const staleProvider = fixture(t);
  assert.equal(staleProvider.interlock.acquireProvider(provider).ok, true);
  const afterProviderCrash = createC1GlobalInterlockForTesting({
    root: staleProvider.root,
    bootId: 'boot-after-c1-install',
    installIdentity: INSTALL_IDENTITY,
  });
  assert.deepEqual(afterProviderCrash.acquireC1(), {
    ok: false,
    reason: 'provider-marker-active',
  });

  const staleC1 = fixture(t);
  assert.equal(staleC1.interlock.acquireC1().ok, true);
  const afterC1Crash = createC1GlobalInterlockForTesting({
    root: staleC1.root,
    bootId: 'boot-after-c1-install',
    installIdentity: INSTALL_IDENTITY,
  });
  assert.deepEqual(afterC1Crash.acquireProvider(provider), {
    ok: false,
    reason: 'c1-global-lock-active',
  });
});

function requireEntries(path) {
  // Deliberately use the test runner's normal filesystem observation only;
  // production never enumerates a marker to select a caller-controlled path.
  return readdirSync(path);
}
