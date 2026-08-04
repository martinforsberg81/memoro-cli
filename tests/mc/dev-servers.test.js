import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  controlDevServer,
  inspectDevServer,
  inspectV1DevServerRegistrySync,
  readDevServerInventorySync,
  readDevServerLog,
  readDevServerManifests,
  registerDevServerManifest,
  removeDevServerRegistryManifest,
  resolveDevServer,
  summarizeDevServers,
  teardownSessionDevServers,
  teardownV1SessionDevServers,
  unregisterDevServerManifest,
  verifyDevServerIdentity,
} from '../../src/mc/dev-servers.js';

describe('mc dev server registry', () => {
  let root;
  let worktree;
  let sourcePath;
  let previousHome;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-dev-servers-'));
    worktree = join(root, 'worktree');
    mkdirSync(join(worktree, '.runtime'), { recursive: true });
    sourcePath = join(worktree, '.runtime', 'mc-dev.json');
    previousHome = process.env.MC_HOME;
    process.env.MC_HOME = join(root, 'mc-home');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  test('registers a normalized, machine-local copy atomically', () => {
    const input = writeSourceManifest({ worktree, sourcePath });
    const registered = registerDevServerManifest(sourcePath, {
      now: () => new Date('2026-07-22T10:00:00.000Z'),
    });

    assert.equal(registered.instance_id, input.instance_id);
    assert.equal(registered.source_manifest_path, realpathSync(sourcePath));
    assert.equal(registered.registered_at, '2026-07-22T10:00:00.000Z');
    assert.deepEqual(readDevServerManifests().map((item) => item.instance_id), [input.instance_id]);
    assert.match(readFileSync(join(process.env.MC_HOME, 'dev-servers', `${input.instance_id}.json`), 'utf8'), /memoro-worker/);
  });

  test('doctor inventory binds dev servers to exact V1 session homes', () => {
    writeSourceManifest({ worktree, sourcePath });
    const manifest = registerDevServerManifest(sourcePath);
    const known = inspectV1DevServerRegistrySync({
      mcHomeDir: process.env.MC_HOME,
      deps: {
        listSessions: () => ({
          sessions: [{ mc_session_id: manifest.mc_session_id }],
          issues: [],
        }),
      },
    });
    assert.equal(known.ok, true);
    assert.equal(known.summary.bound, 1);
    assert.equal(Object.hasOwn(known, 'manifests'), false);

    const absent = inspectV1DevServerRegistrySync({
      mcHomeDir: process.env.MC_HOME,
      deps: { listSessions: () => ({ sessions: [], issues: [] }) },
    });
    assert.equal(absent.ok, false);
    assert.equal(absent.issues[0].reason, 'dev-server-session-absent');
  });

  test('doctor inventory reports corrupt manifests instead of hiding them', () => {
    mkdirSync(join(process.env.MC_HOME, 'dev-servers'), { recursive: true });
    writeFileSync(join(process.env.MC_HOME, 'dev-servers', 'broken.json'), '{broken');
    const inventory = inspectV1DevServerRegistrySync({
      mcHomeDir: process.env.MC_HOME,
      deps: { listSessions: () => ({ sessions: [], issues: [] }) },
    });
    assert.equal(inventory.ok, false);
    assert.equal(inventory.issues[0].reason, 'invalid-dev-server-entry');
  });

  test('inventory binds each manifest identity to its exact registry filename', async () => {
    const registry = join(process.env.MC_HOME, 'dev-servers');
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, 'forged.json'), JSON.stringify({
      schema_version: 1,
      instance_id: 'victim',
      mc_session_id: 'mcs_000000000000000000000001',
    }));
    writeFileSync(join(registry, 'victim.json'), JSON.stringify({
      schema_version: 1,
      instance_id: 'victim',
      mc_session_id: 'mcs_000000000000000000000002',
    }));

    const inventory = readDevServerInventorySync({ mcHomeDir: process.env.MC_HOME });
    assert.equal(inventory.issues[0].reason, 'invalid-dev-server-entry');
    const result = await teardownV1SessionDevServers({
      mcHomeDir: process.env.MC_HOME,
      mcSessionId: 'mcs_000000000000000000000001',
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(registry, 'victim.json')), true);
  });

  test('registry removal never follows a manifest symlink', () => {
    const registry = join(process.env.MC_HOME, 'dev-servers');
    const outside = join(root, 'outside.json');
    mkdirSync(registry, { recursive: true });
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(registry, 'linked.json'));

    assert.throws(
      () => removeDevServerRegistryManifest('linked', { mcHomeDir: process.env.MC_HOME }),
      /manifest is unsafe/u,
    );
    assert.equal(existsSync(outside), true);
  });

  test('rejects paths and controls that escape the owning worktree', () => {
    writeSourceManifest({
      worktree,
      sourcePath,
      log_path: join(root, 'outside.log'),
    });
    assert.throws(
      () => registerDevServerManifest(sourcePath),
      /log_path must be inside worktree_path/,
    );
  });

  test('preserves declarative plan identity used by exact ensure reuse', () => {
    const definitionFingerprint = `sha256:${'b'.repeat(64)}`;
    writeSourceManifest({
      worktree,
      sourcePath,
      profile: 'agent',
      definition_fingerprint: definitionFingerprint,
      start_argv: ['npm', 'run', 'dev', '--', '--skip-containers'],
      resource_class: 'standard',
    });
    const registered = registerDevServerManifest(sourcePath);
    assert.equal(registered.profile, 'agent');
    assert.equal(registered.definition_fingerprint, definitionFingerprint);
    assert.deepEqual(registered.start_argv, ['npm', 'run', 'dev', '--', '--skip-containers']);
    assert.equal(registered.resource_class, 'standard');
  });

  test('classifies verified healthy, unhealthy, and orphaned servers', async () => {
    writeSourceManifest({ worktree, sourcePath });
    const manifest = registerDevServerManifest(sourcePath);
    const verified = {
      isAlive: () => true,
      processInfo: () => ({ cwd: worktree, process_group_id: 4242 }),
    };

    const ready = await inspectDevServer(manifest, {
      ...verified,
      probeHealth: async () => ({ ok: true, status: 200 }),
      now: () => new Date('2026-07-22T10:05:00.000Z'),
    });
    assert.equal(ready.state, 'ready');
    assert.equal(ready.identity.status, 'verified');
    assert.equal(ready.health.status, 'healthy');

    const unhealthy = await inspectDevServer(manifest, {
      ...verified,
      probeHealth: async () => ({ ok: false, error: 'connection refused' }),
      now: () => new Date('2026-07-22T10:05:00.000Z'),
    });
    assert.equal(unhealthy.state, 'unhealthy');
    assert.equal(unhealthy.health.error, 'connection refused');

    const orphan = await inspectDevServer(manifest, {
      isAlive: () => false,
      processInfo: () => null,
      probeHealth: async () => ({ ok: true }),
    });
    assert.equal(orphan.state, 'orphan');
    assert.equal(orphan.identity.reason, 'process-not-running');
  });

  test('requires source manifest, worktree, and process group identity to match', () => {
    writeSourceManifest({ worktree, sourcePath });
    const manifest = registerDevServerManifest(sourcePath);

    assert.deepEqual(verifyDevServerIdentity(manifest, {
      isAlive: () => true,
      processInfo: () => ({ cwd: worktree, process_group_id: 4242 }),
    }), { ok: true, status: 'verified', reason: null });

    assert.equal(verifyDevServerIdentity(manifest, {
      isAlive: () => true,
      processInfo: () => ({ cwd: worktree, process_group_id: 9999 }),
    }).reason, 'process-group-mismatch');

    const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    writeFileSync(sourcePath, JSON.stringify({ ...source, instance_id: 'replacement-instance' }));
    assert.equal(verifyDevServerIdentity(manifest, {
      isAlive: () => true,
      processInfo: () => ({ cwd: worktree, process_group_id: 4242 }),
    }).reason, 'source-manifest-mismatch');
  });

  test('never runs a control command when identity verification fails', async () => {
    writeSourceManifest({ worktree, sourcePath });
    const manifest = registerDevServerManifest(sourcePath);
    let spawned = false;

    const result = await controlDevServer(manifest, 'stop', {
      isAlive: () => true,
      processInfo: () => ({ cwd: '/tmp/unrelated', process_group_id: 4242 }),
      spawnSync: () => { spawned = true; return { status: 0 }; },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'worktree-mismatch');
    assert.equal(spawned, false);
  });

  test('runs verified controls without shell expansion', async () => {
    writeSourceManifest({ worktree, sourcePath });
    const manifest = registerDevServerManifest(sourcePath);
    const calls = [];

    const result = await controlDevServer(manifest, 'stop', {
      isAlive: () => true,
      processInfo: () => ({ cwd: worktree, process_group_id: 4242 }),
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: 'stopped\n', stderr: '' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls[0].command, 'npm');
    assert.deepEqual(calls[0].args, ['run', 'dev', '--', '--stop']);
    assert.equal(calls[0].options.cwd, realpathSync(worktree));
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.env.MC_SESSION_NAME, 'home-actions-v4');
    assert.equal(calls[0].options.env.MC_SESSION_ID, 'mcs_000000000000000000000001');
    assert.equal(calls[0].options.env.MC_CODING_SESSION_ID, 'sess_example');
  });

  test('resolves exact instance ids and rejects ambiguous session selectors', () => {
    const one = { instance_id: 'one', session_name: 'home', service: 'worker' };
    const two = { instance_id: 'two', session_name: 'home', service: 'assets' };
    assert.equal(resolveDevServer([one, two], 'one').server, one);
    assert.match(resolveDevServer([one, two], 'home').error, /matches 2 dev servers/);
  });

  test('tails bounded logs and summarizes health states', () => {
    const logPath = join(worktree, '.runtime', 'dev.log');
    writeFileSync(logPath, 'one\ntwo\nthree\n');
    writeSourceManifest({ worktree, sourcePath, log_path: logPath });
    const manifest = registerDevServerManifest(sourcePath);

    assert.equal(readDevServerLog(manifest, { lines: 2 }), 'two\nthree\n');
    assert.deepEqual(summarizeDevServers([
      { state: 'ready' },
      { state: 'unhealthy' },
      { state: 'orphan' },
    ]), { total: 3, ready: 1, starting: 0, unhealthy: 1, orphan: 1 });
  });

  test('unregisters only the matching source manifest identity', () => {
    writeSourceManifest({ worktree, sourcePath });
    registerDevServerManifest(sourcePath);
    assert.equal(unregisterDevServerManifest(sourcePath), true);
    assert.deepEqual(readDevServerManifests(), []);
  });
});

describe('mc dev server session teardown', () => {
  let root;
  let worktree;
  let sourcePath;
  let previousHome;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-dev-teardown-'));
    worktree = join(root, 'worktree');
    mkdirSync(join(worktree, '.runtime'), { recursive: true });
    sourcePath = join(worktree, '.runtime', 'mc-dev.json');
    previousHome = process.env.MC_HOME;
    process.env.MC_HOME = join(root, 'mc-home');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  test('removeDevServerRegistryManifest works without the source manifest', () => {
    writeSourceManifest({ worktree, sourcePath });
    const registered = registerDevServerManifest(sourcePath);
    rmSync(sourcePath);
    assert.equal(removeDevServerRegistryManifest(registered.instance_id), true);
    assert.deepEqual(readDevServerManifests(), []);
    assert.equal(removeDevServerRegistryManifest(registered.instance_id), false);
  });

  test('teardown stops a verified running server and unregisters it', async () => {
    writeSourceManifest({ worktree, sourcePath });
    registerDevServerManifest(sourcePath);
    const controls = [];
    const result = await teardownSessionDevServers({
      sessionName: 'home-actions-v4',
      worktreePath: null,
    }, {
      isAlive: () => true,
      processInfo: () => ({ cwd: worktree, process_group_id: 4242 }),
      spawnSync: (command, args) => {
        controls.push([command, ...args]);
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].stopped, true);
    assert.equal(result.results[0].unregistered, true);
    assert.deepEqual(controls, [['npm', 'run', 'dev', '--', '--stop']]);
    assert.deepEqual(readDevServerManifests(), []);
  });

  test('teardown unregisters a dead server without running any control', async () => {
    writeSourceManifest({ worktree, sourcePath });
    registerDevServerManifest(sourcePath);
    const result = await teardownSessionDevServers({
      sessionName: null,
      worktreePath: worktree,
    }, {
      isAlive: () => false,
      spawnSync: () => { throw new Error('must not run controls for dead servers'); },
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].was_running, false);
    assert.equal(result.results[0].stopped, false);
    assert.equal(result.results[0].unregistered, true);
    assert.deepEqual(readDevServerManifests(), []);
  });

  test('teardown never touches another session\'s server', async () => {
    writeSourceManifest({ worktree, sourcePath });
    registerDevServerManifest(sourcePath);
    const result = await teardownSessionDevServers({
      sessionName: 'some-other-session',
      worktreePath: join(root, 'elsewhere'),
    }, {
      isAlive: () => true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results, []);
    assert.equal(readDevServerManifests().length, 1);
  });

  test('teardown does not use a shared human name across worktrees', async () => {
    writeSourceManifest({ worktree, sourcePath });
    registerDevServerManifest(sourcePath);
    const result = await teardownSessionDevServers({
      sessionName: 'home-actions-v4',
      codingSessionId: 'sess_other',
      worktreePath: join(root, 'other-repo', 'home-actions-v4'),
    }, {
      isAlive: () => true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results, []);
    assert.equal(readDevServerManifests().length, 1);
  });

  test('V1 teardown selects only the exact mc session id', async () => {
    writeSourceManifest({ worktree, sourcePath });
    registerDevServerManifest(sourcePath);
    const untouched = await teardownV1SessionDevServers({
      mcSessionId: 'mcs_000000000000000000000002',
    }, { isAlive: () => true });
    assert.deepEqual(untouched.results, []);
    assert.equal(readDevServerManifests().length, 1);

    const removed = await teardownV1SessionDevServers({
      mcSessionId: 'mcs_000000000000000000000001',
    }, {
      isAlive: () => false,
      spawnSync: () => assert.fail('a dead server must not run controls'),
    });
    assert.equal(removed.ok, true);
    assert.equal(removed.results.length, 1);
    assert.deepEqual(readDevServerManifests(), []);
  });
});

function writeSourceManifest({ worktree, sourcePath, ...overrides }) {
  const logPath = overrides.log_path || join(worktree, '.runtime', 'dev.log');
  if (!overrides.log_path) writeFileSync(logPath, 'ready\n');
  const manifest = {
    schema_version: 1,
    instance_id: 'dev-01HZY8Q0M9A2B3C4D5E6F7G8H9',
    service: 'memoro-worker',
    session_name: 'home-actions-v4',
    mc_session_id: 'mcs_000000000000000000000001',
    coding_session_id: 'sess_example',
    worktree_path: worktree,
    pid: 4242,
    process_group_id: 4242,
    url: 'http://127.0.0.1:8787',
    port: 8787,
    health_url: 'http://127.0.0.1:8787/api/version',
    log_path: logPath,
    started_at: '2026-07-22T10:00:00.000Z',
    control: {
      stop: { argv: ['npm', 'run', 'dev', '--', '--stop'] },
      restart: { argv: ['npm', 'run', 'dev', '--', '--restart'], detached: true },
    },
    ...overrides,
  };
  writeFileSync(sourcePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
