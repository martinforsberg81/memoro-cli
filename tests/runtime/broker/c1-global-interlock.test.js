import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  baselineC1InstallEpochFixture,
  createC1GlobalInterlockForTesting,
} from '../../../src/runtime/broker/c1-global-interlock.js';

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
    'install_identity',
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

test('without an installation baseline C1 requires a later clean boot while providers remain unavailable for C1', (t) => {
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

test('a missing install receipt disables only C1 and leaves exact unbound provider evidence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-interlock-no-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const interlock = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-without-receipt',
    installIdentity: null,
  });
  const providerLease = interlock.acquireProvider(provider);
  assert.equal(providerLease.ok, true);
  const [marker] = requireEntries(join(root, 'providers'));
  assert.equal(statSync(join(root, 'providers', marker)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'providers', marker), 'utf8')), {
    schema: 'mc-c1-provider-marker-unbound-v1',
    nonce: marker.slice('provider-'.length, -'.json'.length),
    session_id: provider.sessionId,
    runtime_generation: provider.runtimeGeneration,
  });
  assert.equal(providerLease.lease.release().ok, true);
  assert.deepEqual(interlock.acquireC1(), {
    ok: false,
    reason: 'c1-clean-restart-required',
  });
});

test('a package-install epoch baseline admits C1 after exactly one later boot', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-interlock-postinstall-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(baselineC1InstallEpochFixture({
    root,
    bootId: 'boot-global-install',
    installIdentity: INSTALL_IDENTITY,
  }), {
    ok: true,
    code: 'c1-install-epoch-baselined',
  });

  const sameBoot = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-global-install',
    installIdentity: INSTALL_IDENTITY,
  });
  assert.deepEqual(sameBoot.acquireC1(), {
    ok: false,
    reason: 'c1-clean-restart-required',
  });

  const afterOneRestart = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-after-global-install',
    installIdentity: INSTALL_IDENTITY,
  });
  const c1 = afterOneRestart.acquireC1();
  assert.equal(c1.ok, true);
  assert.equal(c1.lease.release().ok, true);
});

test('a package-install baseline fails closed without an exact boot and install identity', (t) => {
  const cases = [
    { bootId: null, installIdentity: INSTALL_IDENTITY },
    { bootId: 'boot-global-install', installIdentity: null },
    { bootId: 'boot-global-install', installIdentity: 'not-a-sha256' },
  ];
  for (const [index, options] of cases.entries()) {
    const root = mkdtempSync(join(tmpdir(), `mc-c1-interlock-baseline-invalid-${index}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(baselineC1InstallEpochFixture({ root, ...options }), {
      ok: false,
      reason: 'install-epoch-baseline-unavailable',
    });
  }
});

test('only superseded exact provider evidence is ignored after the clean boot', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-interlock-marker-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(baselineC1InstallEpochFixture({
    root,
    bootId: 'boot-global-install',
    installIdentity: INSTALL_IDENTITY,
  }).ok, true);
  const providersRoot = join(root, 'providers');
  writeProviderMarker(providersRoot, '1'.repeat(32), {
    schema: 'mc-c1-provider-marker-v1',
    nonce: '1'.repeat(32),
    session_id: 'sess_legacy_marker',
    runtime_generation: 'legacy-generation',
  });
  writeProviderMarker(providersRoot, '2'.repeat(32), {
    schema: 'mc-c1-provider-marker-v2',
    nonce: '2'.repeat(32),
    session_id: 'sess_old_install',
    runtime_generation: 'old-install-generation',
    install_identity: 'b'.repeat(64),
  });
  writeProviderMarker(providersRoot, 'a'.repeat(32), {
    schema: 'mc-c1-provider-marker-unbound-v1',
    nonce: 'a'.repeat(32),
    session_id: 'sess_unbound_install',
    runtime_generation: 'unbound-install-generation',
  });

  const beforeRestart = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-global-install',
    installIdentity: INSTALL_IDENTITY,
  });
  assert.deepEqual(beforeRestart.acquireC1(), {
    ok: false,
    reason: 'c1-clean-restart-required',
  });

  const afterRestart = createC1GlobalInterlockForTesting({
    root,
    bootId: 'boot-after-global-install',
    installIdentity: INSTALL_IDENTITY,
  });
  const c1 = afterRestart.acquireC1();
  assert.equal(c1.ok, true);
  assert.equal(c1.lease.release().ok, true);

  writeProviderMarker(providersRoot, '3'.repeat(32), {
    schema: 'mc-c1-provider-marker-v2',
    nonce: '3'.repeat(32),
    session_id: 'sess_current_install',
    runtime_generation: 'current-install-generation',
    install_identity: INSTALL_IDENTITY,
  });
  assert.deepEqual(afterRestart.acquireC1(), {
    ok: false,
    reason: 'provider-marker-active',
  });
});

test('unsafe or ambiguous provider evidence remains a C1 barrier', (t) => {
  const cases = [
    {
      name: 'malformed-json',
      create(providersRoot) {
        writeFileSync(join(providersRoot, `provider-${'4'.repeat(32)}.json`), '{', { mode: 0o600 });
      },
    },
    {
      name: 'extra-key',
      create(providersRoot) {
        writeProviderMarker(providersRoot, '5'.repeat(32), {
          schema: 'mc-c1-provider-marker-v1',
          nonce: '5'.repeat(32),
          session_id: 'sess_extra_key',
          runtime_generation: 'legacy-generation',
          unexpected: true,
        });
      },
    },
    {
      name: 'unsafe-mode',
      create(providersRoot) {
        const path = writeProviderMarker(providersRoot, '6'.repeat(32), legacyMarker('6'.repeat(32)));
        chmodSync(path, 0o644);
      },
    },
    {
      name: 'unreadable',
      create(providersRoot) {
        const path = writeProviderMarker(providersRoot, '7'.repeat(32), legacyMarker('7'.repeat(32)));
        chmodSync(path, 0o000);
      },
    },
    {
      name: 'symlink',
      create(providersRoot) {
        const target = join(providersRoot, '..', 'marker-target.json');
        writeFileSync(target, JSON.stringify(legacyMarker('8'.repeat(32))), { mode: 0o600 });
        symlinkSync(target, join(providersRoot, `provider-${'8'.repeat(32)}.json`));
      },
    },
    {
      name: 'non-file',
      create(providersRoot) {
        mkdirSync(join(providersRoot, `provider-${'9'.repeat(32)}.json`), { mode: 0o700 });
      },
    },
  ];

  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), `mc-c1-interlock-${entry.name}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(baselineC1InstallEpochFixture({
      root,
      bootId: 'boot-global-install',
      installIdentity: INSTALL_IDENTITY,
    }).ok, true);
    entry.create(join(root, 'providers'));
    const afterRestart = createC1GlobalInterlockForTesting({
      root,
      bootId: 'boot-after-global-install',
      installIdentity: INSTALL_IDENTITY,
    });
    assert.deepEqual(afterRestart.acquireC1(), {
      ok: false,
      reason: 'provider-marker-active',
    }, entry.name);
  }
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

function writeProviderMarker(providersRoot, nonce, value) {
  const path = join(providersRoot, `provider-${nonce}.json`);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function legacyMarker(nonce) {
  return {
    schema: 'mc-c1-provider-marker-v1',
    nonce,
    session_id: 'sess_legacy_marker',
    runtime_generation: 'legacy-generation',
  };
}
