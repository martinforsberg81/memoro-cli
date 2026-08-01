import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

import { runMc, parseJsonOrNull } from '../../mc/_helpers/cli.js';
import { computeDependencyFingerprint } from '../../../src/mc/dependencies.js';
import { resolveDevPlan } from '../../../src/mc/dev-definition.js';

describe('mc dev CLI', () => {
  let root;
  let mcHome;
  let worktree;
  let sourcePath;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-dev-cli-'));
    mcHome = join(root, 'mc-home');
    worktree = join(root, 'worktree');
    mkdirSync(join(worktree, '.runtime'), { recursive: true });
    sourcePath = join(worktree, '.runtime', 'mc-dev.json');
    writeFileSync(join(worktree, '.runtime', 'dev.log'), 'line one\nline two\n');
    writeFileSync(sourcePath, JSON.stringify({
      schema_version: 1,
      instance_id: 'dev-cli-example',
      service: 'memoro-worker',
      session_name: 'ios-app',
      worktree_path: worktree,
      pid: 999999,
      process_group_id: 999999,
      url: 'http://127.0.0.1:8787',
      port: 8787,
      health_url: 'http://127.0.0.1:8787/api/version',
      log_path: join(worktree, '.runtime', 'dev.log'),
      started_at: '2026-07-22T10:00:00.000Z',
      control: {
        stop: { argv: ['npm', 'run', 'dev', '--', '--stop'] },
        restart: { argv: ['npm', 'run', 'dev', '--', '--restart'], detached: true },
      },
    }, null, 2));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('register, list, status, logs, and unregister share one protocol', () => {
    const env = { MC_HOME: mcHome };
    const registered = runMc(['dev', 'register', sourcePath, '--json'], { env });
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(parseJsonOrNull(registered.stdout).instance_id, 'dev-cli-example');

    const listed = runMc(['dev', 'list', '--json'], { env });
    assert.equal(listed.status, 0, listed.stderr);
    const inventory = parseJsonOrNull(listed.stdout);
    assert.equal(inventory.summary.total, 1);
    assert.equal(inventory.servers[0].state, 'orphan');
    assert.equal(inventory.servers[0].session_name, 'ios-app');

    const status = runMc(['dev', 'status', 'ios-app', '--json'], { env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(parseJsonOrNull(status.stdout).instance_id, 'dev-cli-example');

    const logs = runMc(['dev', 'logs', 'ios-app', '--lines', '1'], { env });
    assert.equal(logs.status, 0, logs.stderr);
    assert.equal(logs.stdout, 'line two\n');

    const stopped = runMc(['dev', 'stop', 'ios-app'], { env });
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /refusing stop.*process-not-running/i);

    const unregistered = runMc(['dev', 'unregister', sourcePath, '--json'], { env });
    assert.equal(unregistered.status, 0, unregistered.stderr);
    assert.equal(parseJsonOrNull(unregistered.stdout).removed, true);
  });

  test('human-readable errors are explicit', () => {
    const result = runMc(['dev', 'status', 'missing'], { env: { MC_HOME: mcHome } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no dev server matches "missing"/);
  });

  test('human list includes the operational fields needed for triage', () => {
    const env = { MC_HOME: mcHome };
    assert.equal(runMc(['dev', 'register', sourcePath], { env }).status, 0);
    const result = runMc(['dev', 'list'], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ios-app\/memoro-worker/);
    assert.match(result.stdout, /health=unknown/);
    assert.match(result.stdout, /worktree=.*worktree/);
    assert.match(result.stdout, /log=.*dev\.log/);
  });

  test('plan validates and prints the selected worktree-local dev profile without side effects', () => {
    mkdirSync(join(worktree, '.mc'), { recursive: true });
    writeFileSync(join(worktree, '.mc', 'dev.json'), JSON.stringify({
      schema_version: 1,
      default_service: 'web',
      services: {
        web: {
          default_profile: 'agent',
          profiles: {
            agent: {
              start: { argv: ['npm', 'run', 'dev', '--', '--skip-containers'] },
              readiness: { kind: 'runtime-manifest', path: '.runtime/mc-dev.json', timeout_ms: 90_000 },
              resource_class: 'standard',
            },
            full: {
              start: { argv: ['npm', 'run', 'dev'] },
              readiness: { kind: 'runtime-manifest', path: '.runtime/mc-dev.json', timeout_ms: 120_000 },
              resource_class: 'heavy',
            },
          },
          dependencies: {
            manager: 'npm',
            fingerprint_files: ['package.json', 'package-lock.json'],
            install: { argv: ['npm', 'ci'] },
          },
          managed_argv_prefixes: [['npm', 'run', 'dev']],
        },
      },
    }));
    writeFileSync(join(worktree, '.mc', 'local.json'), JSON.stringify({ dev: { profile: 'full' } }));
    const git = spawnSync('git', ['init', '-q'], { cwd: worktree, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);

    const json = runMc(['dev', 'plan', '--json'], { cwd: worktree, env: { MC_HOME: mcHome } });
    assert.equal(json.status, 0, json.stderr);
    const plan = parseJsonOrNull(json.stdout);
    assert.deepEqual(plan.profile, { name: 'full', source: '.mc/local.json' });
    assert.deepEqual(plan.start.argv, ['npm', 'run', 'dev']);
    assert.equal(plan.worktree_path, realpathSync(worktree));
    assert.match(plan.definition_fingerprint, /^sha256:[a-f0-9]{64}$/);

    const human = runMc(['dev', 'plan', 'web', '--profile', 'agent'], {
      cwd: worktree,
      env: { MC_HOME: mcHome },
    });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /web\/agent/);
    assert.match(human.stdout, /npm run dev -- --skip-containers/);
    assert.match(human.stdout, /source=cli/);
    assert.match(human.stdout, /deps mode\s+auto \(source=package-defaults\)/);

    const ensure = runMc(['dev', 'ensure', 'web', '--profile', 'agent', '--json'], {
      cwd: worktree,
      env: { MC_HOME: mcHome },
    });
    assert.equal(ensure.status, 1, ensure.stderr);
    assert.equal(parseJsonOrNull(ensure.stdout).reason, 'missing-session-identity');
    assert.equal(existsSync(join(worktree, 'node_modules')), false);
  });

  test('plan reports malformed definitions and never falls through to runtime inventory', () => {
    mkdirSync(join(worktree, '.mc'), { recursive: true });
    writeFileSync(join(worktree, '.mc', 'dev.json'), '{bad json');
    const git = spawnSync('git', ['init', '-q'], { cwd: worktree, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);

    const result = runMc(['dev', 'plan'], { cwd: worktree, env: { MC_HOME: mcHome } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.mc\/dev\.json contains invalid JSON/);
  });

  test('ensure starts exact argv and waits for a verified healthy runtime manifest', async (t) => {
    if (!await supportsLoopbackListen()) {
      t.skip('loopback listeners are unavailable in this sandbox');
      return;
    }
    const runtimeDir = join(worktree, '.runtime');
    const definitionDir = join(worktree, '.mc');
    const startScript = join(worktree, 'start-fixture.mjs');
    const manifestPath = join(runtimeDir, 'mc-dev.json');
    let launchedPid = null;
    mkdirSync(definitionDir, { recursive: true });
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'dev-ensure-fixture', version: '1.0.0' }));
    writeFileSync(join(worktree, 'package-lock.json'), JSON.stringify({
      name: 'dev-ensure-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'dev-ensure-fixture', version: '1.0.0' } },
    }));
    writeFileSync(startScript, `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const manifestPath = process.env.MC_DEV_MANIFEST_PATH;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true }));
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(join(dirname(manifestPath), 'fixture.log'), 'ready\\n');
  writeFileSync(join(dirname(manifestPath), 'fixture.pid'), String(process.pid));
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1,
    instance_id: 'dev-e2e-' + process.pid,
    service: process.env.MC_DEV_SERVICE,
    profile: process.env.MC_DEV_PROFILE,
    definition_fingerprint: process.env.MC_DEV_DEFINITION_FINGERPRINT,
    start_argv: JSON.parse(process.env.MC_DEV_START_ARGV_JSON),
    resource_class: process.env.MC_DEV_RESOURCE_CLASS,
    session_name: process.env.MC_SESSION_NAME,
    coding_session_id: process.env.MC_CODING_SESSION_ID,
    worktree_path: process.cwd(),
    pid: process.pid,
    process_group_id: process.pid,
    url: 'http://127.0.0.1:' + port,
    port,
    health_url: 'http://127.0.0.1:' + port + '/health',
    log_path: join(dirname(manifestPath), 'fixture.log'),
    started_at: new Date().toISOString(),
    control: {
      stop: { argv: [process.execPath, '-e', 'process.exit(0)'] },
      restart: { argv: [process.execPath, '-e', 'process.exit(0)'], detached: true }
    }
  }, null, 2));
});
`);
    writeFileSync(join(definitionDir, 'dev.json'), JSON.stringify({
      schema_version: 1,
      default_service: 'web',
      services: {
        web: {
          default_profile: 'agent',
          profiles: {
            agent: {
              start: { argv: [process.execPath, startScript] },
              readiness: { kind: 'runtime-manifest', path: '.runtime/mc-dev.json', timeout_ms: 10_000 },
              resource_class: 'standard',
            },
          },
          dependencies: {
            manager: 'npm',
            fingerprint_files: ['package.json', 'package-lock.json'],
            install: { argv: ['npm', 'ci'] },
          },
          managed_argv_prefixes: [[process.execPath, startScript]],
        },
      },
    }));
    const git = spawnSync('git', ['init', '-q'], { cwd: worktree, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);

    const plan = await resolveDevPlan({ worktreePath: realpathSync(worktree), globalConfig: {} });
    const fingerprint = await computeDependencyFingerprint(plan);
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', '.mc-dependency-snapshot.json'), JSON.stringify({
      schema_version: 1,
      fingerprint: fingerprint.value,
    }));

    try {
      const ensured = runMc(['dev', 'ensure', '--json'], {
        cwd: worktree,
        timeoutMs: 15_000,
        env: {
          MC_HOME: mcHome,
          MC_SESSION_NAME: 'e2e-session',
          MC_CODING_SESSION_ID: 'sess_e2e',
          PATH: process.env.PATH,
        },
      });
      const launchLog = join(runtimeDir, 'mc-dev-ensure.log');
      const failureDetail = [
        ensured.stderr || ensured.stdout,
        existsSync(launchLog) ? readFileSync(launchLog, 'utf8') : '',
      ].filter(Boolean).join('\n');
      assert.equal(ensured.status, 0, failureDetail);
      const result = parseJsonOrNull(ensured.stdout);
      assert.equal(result.action, 'started');
      assert.equal(result.server.state, 'ready');
      assert.equal(result.server.health.status, 'healthy');
      assert.equal(result.launch.shell, false);
      assert.deepEqual(result.launch.argv, [process.execPath, startScript]);
      launchedPid = Number(readFileSync(join(runtimeDir, 'fixture.pid'), 'utf8'));

      const reused = runMc(['dev', 'ensure', '--json'], {
        cwd: worktree,
        timeoutMs: 10_000,
        env: {
          MC_HOME: mcHome,
          MC_SESSION_NAME: 'another-session',
          PATH: process.env.PATH,
        },
      });
      assert.equal(reused.status, 0, reused.stderr);
      assert.equal(parseJsonOrNull(reused.stdout).action, 'reused');
    } finally {
      if (existsSync(manifestPath)) {
        runMc(['dev', 'unregister', manifestPath], { env: { MC_HOME: mcHome } });
      }
      if (Number.isInteger(launchedPid) && launchedPid > 0) {
        try { process.kill(launchedPid, 'SIGTERM'); } catch {}
      }
    }
  });
});

function supportsLoopbackListen() {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
