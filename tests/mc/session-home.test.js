import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  privateStateFs,
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
  replacePrivateJsonSync,
} from '../../src/mc/private-state.js';
import {
  MC_SESSION_ID_RE,
  SESSION_HOME_VERSION,
  SESSION_IDENTITY_SCHEMA,
  SESSION_METADATA_SCHEMA,
  SESSION_NAME_CLAIM_SCHEMA,
  SESSION_PROJECTION_SCHEMA,
  __test__,
  createSessionHomeSync,
  inspectSessionCatalogSync,
  listSessionHomesSync,
  mintMcSessionId,
  readSessionHomeSync,
  renameSessionHomeSync,
  repairSessionCatalogSync,
  resolveSessionHomeSync,
  sessionHomePaths,
  updateSessionMetadataSync,
  validateSessionIdentity,
  validateSessionMetadata,
  validateSessionNameClaim,
  validateSessionProjection,
  writeSessionProjectionSync,
} from '../../src/mc/session-home.js';

const timestamp = '2026-08-02T20:00:00.000Z';
const later = '2026-08-02T20:01:00.000Z';
let temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots = [];
});

function temporaryHome(prefix = 'mc-session-home-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function sessionId(number) {
  return `mcs_${number.toString(16).padStart(24, '0')}`;
}

function create(mcHomeDir, overrides = {}) {
  return createSessionHomeSync({
    mcHomeDir,
    mcSessionId: sessionId(1),
    sourceId: 'machine_test',
    name: 'alpha',
    objective: null,
    preferredLaunchCwd: '/workspace/alpha',
    now: () => timestamp,
    ...overrides,
  });
}

test('mints and lays out an opaque source-owned session identity', () => {
  const mcHomeDir = temporaryHome();
  assert.match(mintMcSessionId(() => Buffer.alloc(12, 0xab)), MC_SESSION_ID_RE);
  assert.equal(mintMcSessionId(() => Buffer.alloc(12, 0xab)), `mcs_${'ab'.repeat(12)}`);

  const paths = sessionHomePaths({
    mcHomeDir,
    mcSessionId: sessionId(1),
    normalizedName: 'Alpha',
  });
  assert.equal(paths.home, join(mcHomeDir, 'sessions', sessionId(1)));
  assert.equal(paths.ephemeralRunPath, join(mcHomeDir, 'run', 'sessions', sessionId(1)));
  assert.equal(paths.normalizedName, 'alpha');
  assert.match(paths.nameClaimPath, /session-names\/[a-f0-9]{64}\.json$/u);
});

test('creates a private session home and resolves it by id or source-local name', () => {
  const mcHomeDir = temporaryHome();
  const created = create(mcHomeDir);

  assert.equal(created.kind, 'present');
  assert.equal(created.catalog_state, 'ready');
  assert.deepEqual(created.identity.owner, { kind: 'machine', source_id: 'machine_test' });
  assert.equal(created.metadata.name, 'alpha');
  assert.equal(created.metadata.preferred_launch_cwd, '/workspace/alpha');
  assert.equal(created.projection.runtime_state, 'none');

  const paths = sessionHomePaths({ mcHomeDir, mcSessionId: sessionId(1) });
  assert.equal(lstatSync(paths.home).mode & 0o077, 0);
  assert.equal(lstatSync(paths.identityPath).mode & 0o077, 0);
  for (const path of [
    paths.workspacesPath,
    paths.conversationsPath,
    paths.generationsPath,
    paths.resourcesPath,
  ]) {
    assert.equal(lstatSync(path).mode & 0o077, 0);
  }

  assert.equal(resolveSessionHomeSync(sessionId(1), { mcHomeDir }).session.mc_session_id, sessionId(1));
  assert.equal(resolveSessionHomeSync('ALPHA', { mcHomeDir }).session.mc_session_id, sessionId(1));
  assert.deepEqual(listSessionHomesSync({ mcHomeDir }).issues, []);
});

test('claims names case-insensitively without coupling them to a repository', () => {
  const mcHomeDir = temporaryHome();
  create(mcHomeDir, { name: 'Billing' });

  assert.throws(() => create(mcHomeDir, {
    mcSessionId: sessionId(2),
    name: 'billing',
  }), (error) => error.reason === 'session-name-claim-conflict');

  const second = create(mcHomeDir, {
    mcSessionId: sessionId(2),
    name: 'analytics',
    preferredLaunchCwd: '/another/repository',
  });
  assert.equal(second.metadata.preferred_launch_cwd, '/another/repository');
  assert.equal(listSessionHomesSync({ mcHomeDir }).sessions.length, 2);
});

test('updates metadata with revision CAS while keeping the name claim valid', () => {
  const mcHomeDir = temporaryHome();
  create(mcHomeDir);
  const updated = updateSessionMetadataSync({
    mcHomeDir,
    mcSessionId: sessionId(1),
    expectedRevision: 1,
    objective: 'Investigate the session store',
    preferredLaunchCwd: '/workspace/beta',
    now: () => later,
  });

  assert.equal(updated.metadata.revision, 2);
  assert.equal(updated.metadata.name_revision, 1);
  assert.equal(updated.metadata.objective, 'Investigate the session store');
  assert.equal(updated.catalog_state, 'ready');
  assert.throws(() => updateSessionMetadataSync({
    mcHomeDir,
    mcSessionId: sessionId(1),
    expectedRevision: 1,
    objective: null,
  }), (error) => error.reason === 'metadata-revision-conflict');
});

test('renames atomically at the metadata boundary without moving the session home', () => {
  const mcHomeDir = temporaryHome();
  const before = create(mcHomeDir);
  const home = sessionHomePaths({ mcHomeDir, mcSessionId: sessionId(1) }).home;
  const renamed = renameSessionHomeSync({
    mcHomeDir,
    mcSessionId: sessionId(1),
    expectedRevision: before.metadata.revision,
    name: 'beta',
    now: () => later,
  });

  assert.equal(renamed.metadata.name, 'beta');
  assert.equal(renamed.metadata.name_revision, 2);
  assert.equal(sessionHomePaths({ mcHomeDir, mcSessionId: sessionId(1) }).home, home);
  assert.equal(resolveSessionHomeSync('alpha', { mcHomeDir }).ok, false);
  assert.equal(resolveSessionHomeSync('beta', { mcHomeDir }).session.mc_session_id, sessionId(1));
});

test('updates the bounded status projection independently from metadata', () => {
  const mcHomeDir = temporaryHome();
  create(mcHomeDir);
  const updated = writeSessionProjectionSync({
    mcHomeDir,
    mcSessionId: sessionId(1),
    expectedRevision: 1,
    lifecycle: 'open',
    runtimeState: 'running',
    activeRuntimeGeneration: 'runtime_1',
    tool: 'codex',
    now: () => later,
  });

  assert.equal(updated.projection.revision, 2);
  assert.equal(updated.projection.runtime_state, 'running');
  assert.equal(updated.projection.active_runtime_generation, 'runtime_1');
  assert.equal(updated.metadata.revision, 1);
});

test('isolates corrupt and unexpected session state instead of returning an empty catalog', () => {
  const mcHomeDir = temporaryHome();
  create(mcHomeDir, { mcSessionId: sessionId(1), name: 'healthy' });
  create(mcHomeDir, { mcSessionId: sessionId(2), name: 'corrupt' });
  const corrupt = sessionHomePaths({ mcHomeDir, mcSessionId: sessionId(2) });
  writeFileSync(corrupt.metadataPath, '{bad-json', { mode: 0o600 });

  const listed = listSessionHomesSync({ mcHomeDir });
  assert.deepEqual(listed.sessions.map((session) => session.metadata.name), ['healthy']);
  assert.deepEqual(listed.issues, [{
    scope: 'session',
    mc_session_id: sessionId(2),
    reason: 'metadata-corrupt',
  }]);

  writeFileSync(join(sessionHomePaths({ mcHomeDir, mcSessionId: sessionId(1) }).home, 'surprise'), 'x', { mode: 0o600 });
  const withUnexpected = listSessionHomesSync({ mcHomeDir });
  assert.equal(withUnexpected.sessions.length, 0);
  assert.equal(withUnexpected.issues.length, 2);
});

test('rejects symlinked control files without reading their target', () => {
  const mcHomeDir = temporaryHome();
  create(mcHomeDir);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId: sessionId(1) });
  const outside = join(temporaryHome('mc-session-outside-'), 'identity.json');
  writeFileSync(outside, JSON.stringify({ secret: 'must-not-be-read' }), { mode: 0o600 });
  unlinkSync(paths.identityPath);
  symlinkSync(outside, paths.identityPath);

  const read = readSessionHomeSync({ mcHomeDir, mcSessionId: sessionId(1) });
  assert.equal(read.kind, 'unknown');
  assert.equal(read.reason, 'identity-unsafe-file');
});

test('rejects a session catalog below a non-private trusted root', () => {
  const mcHomeDir = temporaryHome();
  chmodSync(mcHomeDir, 0o755);

  const listed = listSessionHomesSync({ mcHomeDir });
  assert.deepEqual(listed, {
    sessions: [],
    issues: [{ scope: 'catalog', reason: 'unsafe-directory' }],
  });
  assert.throws(() => create(mcHomeDir), (error) => (
    error.code === 'MC_PRIVATE_STATE_UNSAFE' && error.reason === 'unsafe-directory'
  ));
});

test('atomic replacement preserves the old file when publication is interrupted', () => {
  const mcHomeDir = temporaryHome();
  const directory = join(mcHomeDir, 'state');
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'metadata.json');
  replacePrivateJsonSync({ path, value: { revision: 1 }, trustedRoot: mcHomeDir });
  const before = readFileSync(path, 'utf8');
  const failingFs = {
    ...privateStateFs,
    renameSync() {
      const error = new Error('simulated interruption');
      error.code = 'EIO';
      throw error;
    },
  };

  assert.throws(() => replacePrivateJsonSync({
    path,
    value: { revision: 2 },
    trustedRoot: mcHomeDir,
    fs: failingFs,
  }), /simulated interruption/u);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(readdirSync(directory), ['metadata.json']);
});

test('immutable publication leaves neither a partial claim nor a temporary file', () => {
  const mcHomeDir = temporaryHome();
  const directory = join(mcHomeDir, 'claims');
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'claim.json');
  const failingFs = {
    ...privateStateFs,
    linkSync() {
      const error = new Error('simulated interrupted publication');
      error.code = 'EIO';
      throw error;
    },
  };

  assert.throws(() => publishImmutablePrivateJsonSync({
    path,
    value: { revision: 1 },
    trustedRoot: mcHomeDir,
    fs: failingFs,
  }), /simulated interrupted publication/u);
  assert.deepEqual(readdirSync(directory), []);
});

test('private reads consume a regular file fully even when reads are short', () => {
  const mcHomeDir = temporaryHome();
  const directory = join(mcHomeDir, 'state');
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'metadata.json');
  replacePrivateJsonSync({ path, value: { revision: 1 }, trustedRoot: mcHomeDir });
  const shortReadFs = {
    ...privateStateFs,
    readSync(fd, buffer, offset, length, position) {
      return privateStateFs.readSync(fd, buffer, offset, Math.min(length, 2), position);
    },
  };

  const read = readPrivateJsonSync({
    path,
    trustedRoot: mcHomeDir,
    fs: shortReadFs,
    validate: (value) => ({ ok: true, value }),
  });
  assert.deepEqual(read, { kind: 'present', value: { revision: 1 } });
});

test('serializes mutations and reclaims only a proven dead lock owner', () => {
  const mcHomeDir = temporaryHome();
  const lockPath = join(mcHomeDir, 'run', 'locks', 'sessions', sessionId(1));
  const first = __test__.acquireLockSync({
    path: lockPath,
    trustedRoot: mcHomeDir,
    purpose: 'test-first',
  });
  assert.throws(() => __test__.acquireLockSync({
    path: lockPath,
    trustedRoot: mcHomeDir,
    purpose: 'test-second',
    isAlive: () => true,
  }), (error) => error.reason === 'session-mutation-busy');

  const replacement = __test__.acquireLockSync({
    path: lockPath,
    trustedRoot: mcHomeDir,
    purpose: 'test-recovery',
    isAlive: () => false,
  });
  assert.equal(__test__.releaseLockSync(first), false);
  assert.equal(__test__.releaseLockSync(replacement), true);
});

test('session and name mutations fail closed while their exact lock is live', () => {
  const mcHomeDir = temporaryHome();
  create(mcHomeDir);
  const sessionPaths = sessionHomePaths({ mcHomeDir, mcSessionId: sessionId(1) });
  const sessionLock = __test__.acquireLockSync({
    path: sessionPaths.mutationLockPath,
    trustedRoot: mcHomeDir,
    purpose: 'test-session-race',
  });
  assert.throws(() => updateSessionMetadataSync({
    mcHomeDir,
    mcSessionId: sessionId(1),
    expectedRevision: 1,
    objective: 'must not win the race',
  }), (error) => error.reason === 'session-mutation-busy');
  assert.equal(__test__.releaseLockSync(sessionLock), true);

  const targetPaths = sessionHomePaths({ mcHomeDir, normalizedName: 'beta' });
  const nameLock = __test__.acquireLockSync({
    path: targetPaths.nameLockPath,
    trustedRoot: mcHomeDir,
    purpose: 'test-name-race',
  });
  assert.throws(() => renameSessionHomeSync({
    mcHomeDir,
    mcSessionId: sessionId(1),
    expectedRevision: 1,
    name: 'beta',
  }), (error) => error.reason === 'session-mutation-busy');
  assert.throws(() => create(mcHomeDir, {
    mcSessionId: sessionId(2),
    name: 'beta',
  }), (error) => error.reason === 'session-mutation-busy');
  assert.equal(__test__.releaseLockSync(nameLock), true);
});

test('repairs a missing name claim without changing session identity', () => {
  const mcHomeDir = temporaryHome();
  create(mcHomeDir);
  const namePaths = sessionHomePaths({ mcHomeDir, normalizedName: 'alpha' });
  unlinkSync(namePaths.nameClaimPath);

  const before = inspectSessionCatalogSync({ mcHomeDir });
  assert.equal(before.sessions[0].catalog_state, 'unclaimed');
  assert.deepEqual(before.actions, [{
    action: 'publish-name-claim',
    mc_session_id: sessionId(1),
    normalized_name: 'alpha',
    safe: true,
  }]);

  const repaired = repairSessionCatalogSync({ mcHomeDir, apply: true, now: () => later });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.actions_applied.length, 1);
  assert.equal(resolveSessionHomeSync('alpha', { mcHomeDir }).session.mc_session_id, sessionId(1));
});

test('repairs a stale claim left by an interrupted rename', () => {
  const mcHomeDir = temporaryHome();
  const initial = create(mcHomeDir);
  renameSessionHomeSync({
    mcHomeDir,
    mcSessionId: sessionId(1),
    expectedRevision: initial.metadata.revision,
    name: 'beta',
    now: () => later,
  });
  const stalePaths = sessionHomePaths({ mcHomeDir, normalizedName: 'alpha' });
  publishImmutablePrivateJsonSync({
    path: stalePaths.nameClaimPath,
    trustedRoot: mcHomeDir,
    value: {
      schema: SESSION_NAME_CLAIM_SCHEMA,
      version: SESSION_HOME_VERSION,
      mc_session_id: sessionId(1),
      name: 'alpha',
      normalized_name: 'alpha',
      name_revision: 1,
      claimed_at: timestamp,
    },
  });

  const inspected = inspectSessionCatalogSync({ mcHomeDir });
  assert.ok(inspected.actions.some((action) => (
    action.action === 'remove-stale-name-claim' && action.normalized_name === 'alpha'
  )));
  const repaired = repairSessionCatalogSync({ mcHomeDir, apply: true });
  assert.equal(repaired.ok, true);
  assert.equal(resolveSessionHomeSync('alpha', { mcHomeDir }).ok, false);
  assert.equal(resolveSessionHomeSync('beta', { mcHomeDir }).ok, true);
});

test('repairs a dangling name claim left before session-home publication', () => {
  const mcHomeDir = temporaryHome();
  const paths = sessionHomePaths({ mcHomeDir, normalizedName: 'abandoned' });
  publishImmutablePrivateJsonSync({
    path: paths.nameClaimPath,
    trustedRoot: mcHomeDir,
    value: {
      schema: SESSION_NAME_CLAIM_SCHEMA,
      version: SESSION_HOME_VERSION,
      mc_session_id: sessionId(99),
      name: 'abandoned',
      normalized_name: 'abandoned',
      name_revision: 1,
      claimed_at: timestamp,
    },
  });

  const inspected = inspectSessionCatalogSync({ mcHomeDir });
  assert.deepEqual(inspected.actions, [{
    action: 'remove-stale-name-claim',
    mc_session_id: sessionId(99),
    normalized_name: 'abandoned',
    safe: true,
  }]);
  const repaired = repairSessionCatalogSync({ mcHomeDir, apply: true });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.actions_applied.length, 1);
  assert.equal(resolveSessionHomeSync('abandoned', { mcHomeDir }).ok, false);
});

test('bounds schemas and rejects authority-bearing or malformed extensions', () => {
  const identity = {
    schema: SESSION_IDENTITY_SCHEMA,
    version: SESSION_HOME_VERSION,
    mc_session_id: sessionId(1),
    owner: { kind: 'machine', source_id: 'machine_test' },
    created_at: timestamp,
  };
  const metadata = {
    schema: SESSION_METADATA_SCHEMA,
    version: SESSION_HOME_VERSION,
    mc_session_id: sessionId(1),
    revision: 1,
    name_revision: 1,
    name: 'alpha',
    normalized_name: 'alpha',
    objective: null,
    preferred_launch_cwd: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const projection = {
    schema: SESSION_PROJECTION_SCHEMA,
    version: SESSION_HOME_VERSION,
    mc_session_id: sessionId(1),
    revision: 1,
    lifecycle: 'open',
    runtime_state: 'none',
    active_runtime_generation: null,
    tool: null,
    updated_at: timestamp,
  };
  const claim = {
    schema: SESSION_NAME_CLAIM_SCHEMA,
    version: SESSION_HOME_VERSION,
    mc_session_id: sessionId(1),
    name: 'alpha',
    normalized_name: 'alpha',
    name_revision: 1,
    claimed_at: timestamp,
  };

  assert.equal(validateSessionIdentity(identity).ok, true);
  assert.equal(validateSessionMetadata(metadata).ok, true);
  assert.equal(validateSessionProjection(projection).ok, true);
  assert.equal(validateSessionNameClaim(claim).ok, true);
  assert.equal(validateSessionIdentity({ ...identity, token: 'forbidden' }).ok, false);
  assert.equal(validateSessionMetadata({ ...metadata, objective: 'x'.repeat(2049) }).ok, false);
  assert.equal(validateSessionProjection({ ...projection, runtime_state: 'running' }).ok, false);
  assert.equal(validateSessionNameClaim({ ...claim, normalized_name: '../alpha' }).ok, false);
});

test('enumerates 1,000 bounded session homes without consulting runtime state', () => {
  const mcHomeDir = temporaryHome('mc-session-scale-');
  mkdirSync(join(mcHomeDir, 'sessions'), { mode: 0o700 });
  mkdirSync(join(mcHomeDir, 'session-names'), { mode: 0o700 });
  for (let index = 1; index <= 1000; index += 1) {
    writeSessionFixture(mcHomeDir, index);
  }

  const started = performance.now();
  const listed = listSessionHomesSync({ mcHomeDir });
  const elapsed = performance.now() - started;
  assert.equal(listed.sessions.length, 1000);
  assert.deepEqual(listed.issues, []);
  assert.ok(elapsed < 5000, `1,000-session enumeration took ${Math.round(elapsed)}ms`);
});

function writeSessionFixture(mcHomeDir, index) {
  const mcSessionId = sessionId(index);
  const name = `s${index.toString().padStart(4, '0')}`;
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId, normalizedName: name });
  mkdirSync(paths.home, { mode: 0o700 });
  for (const directory of [
    paths.workspacesPath,
    paths.conversationsPath,
    paths.generationsPath,
    paths.resourcesPath,
  ]) mkdirSync(directory, { mode: 0o700 });
  const values = [
    [paths.identityPath, {
      schema: SESSION_IDENTITY_SCHEMA,
      version: SESSION_HOME_VERSION,
      mc_session_id: mcSessionId,
      owner: { kind: 'machine', source_id: 'machine_scale' },
      created_at: timestamp,
    }],
    [paths.metadataPath, {
      schema: SESSION_METADATA_SCHEMA,
      version: SESSION_HOME_VERSION,
      mc_session_id: mcSessionId,
      revision: 1,
      name_revision: 1,
      name,
      normalized_name: name,
      objective: null,
      preferred_launch_cwd: null,
      created_at: timestamp,
      updated_at: timestamp,
    }],
    [paths.projectionPath, {
      schema: SESSION_PROJECTION_SCHEMA,
      version: SESSION_HOME_VERSION,
      mc_session_id: mcSessionId,
      revision: 1,
      lifecycle: 'open',
      runtime_state: 'none',
      active_runtime_generation: null,
      tool: null,
      updated_at: timestamp,
    }],
    [paths.nameClaimPath, {
      schema: SESSION_NAME_CLAIM_SCHEMA,
      version: SESSION_HOME_VERSION,
      mc_session_id: mcSessionId,
      name,
      normalized_name: name,
      name_revision: 1,
      claimed_at: timestamp,
    }],
  ];
  for (const [path, value] of values) {
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}
