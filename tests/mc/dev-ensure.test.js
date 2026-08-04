import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareDevServerToPlan,
  devEnsureEnvironment,
  ensureDevServer,
  evaluateDevResourceGate,
  launchDevPlan,
} from '../../src/mc/dev-ensure.js';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function makePlan(root, { profile = 'agent', resourceClass = 'standard' } = {}) {
  return {
    worktree_path: root,
    definition_fingerprint: FINGERPRINT,
    service: { name: 'web', source: '.mc/dev.json' },
    profile: { name: profile, source: '.mc/dev.json' },
    dependency_mode: { name: 'auto', source: 'package-defaults' },
    start: { argv: ['npm', 'run', 'dev', '--', '--skip-containers'] },
    readiness: { kind: 'runtime-manifest', path: '.runtime/mc-dev.json', timeout_ms: 5_000 },
    resource_class: resourceClass,
    dependencies: {
      manager: 'npm',
      fingerprint_files: ['package.json', 'package-lock.json'],
      install: { argv: ['npm', 'ci'] },
    },
  };
}

function makeServer(plan, overrides = {}) {
  return {
    schema_version: 1,
    instance_id: 'dev-exact',
    service: plan.service.name,
    profile: plan.profile.name,
    definition_fingerprint: plan.definition_fingerprint,
    start_argv: [...plan.start.argv],
    resource_class: plan.resource_class,
    session_name: 'original-session',
    coding_session_id: 'sess_original',
    worktree_path: plan.worktree_path,
    pid: 1234,
    process_group_id: 1234,
    url: 'http://127.0.0.1:8787',
    health_url: 'http://127.0.0.1:8787/health',
    state: 'ready',
    identity: { ok: true, status: 'verified', reason: null },
    health: { ok: true, status: 'healthy' },
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    acquireLock: async () => ({ release() {} }),
    readConfig: async () => ({}),
    dependencyStatus: async () => ({ ready: true }),
    ...overrides,
  };
}

describe('mc dev ensure', () => {
  test('reuses only an exact healthy server in the same worktree without touching dependencies', async () => {
    const plan = makePlan('/tmp/worktree-a');
    const server = makeServer(plan);
    const result = await ensureDevServer(plan, {
      sessionName: 'new-session',
      deps: baseDeps({
        listDevServers: async () => [server],
        dependencyStatus: async () => assert.fail('a running reused server must not be hydrated underneath'),
        launchPlan: async () => assert.fail('exact reuse must not launch'),
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'reused');
    assert.equal(result.changed, false);
    assert.equal(result.server.instance_id, 'dev-exact');
  });

  test('refuses plan mismatch unless restart is explicit', async () => {
    const plan = makePlan('/tmp/worktree-b');
    const server = makeServer(plan, { profile: 'full' });
    const result = await ensureDevServer(plan, {
      sessionName: 'new-session',
      deps: baseDeps({
        listDevServers: async () => [server],
        controlDevServer: async () => assert.fail('implicit mismatch must not stop a process'),
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'server-plan-mismatch');
    assert.deepEqual(result.comparison.mismatches, ['profile']);
  });

  test('explicit restart stops the verified server, prepares dependencies, launches, and waits for health', async () => {
    const plan = makePlan('/tmp/worktree-c');
    const old = makeServer(plan, { profile: 'full', instance_id: 'dev-old' });
    const fresh = makeServer(plan, { instance_id: 'dev-new', state: 'ready' });
    const lists = [[old], [], [fresh]];
    const controls = [];
    let launches = 0;
    const result = await ensureDevServer(plan, {
      restart: true,
      sessionName: 'new-session',
      deps: baseDeps({
        listDevServers: async () => lists.shift() || [fresh],
        controlDevServer: async (server, action) => {
          controls.push([server.instance_id, action]);
          return { ok: true, action };
        },
        launchPlan: async () => { launches += 1; return { ok: true, child: null }; },
        existsSync: () => false,
        wait: async () => {},
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'restarted');
    assert.deepEqual(controls, [['dev-old', 'stop']]);
    assert.equal(launches, 1);
    assert.equal(result.server.instance_id, 'dev-new');
  });

  test('waits through starting state before reporting a newly launched server ready', async () => {
    const plan = makePlan('/tmp/worktree-d');
    const starting = makeServer(plan, { state: 'starting', health: { ok: false, status: 'unhealthy' } });
    const ready = makeServer(plan);
    const lists = [[], [starting], [ready]];
    let waits = 0;
    const result = await ensureDevServer(plan, {
      sessionName: 'session-d',
      deps: baseDeps({
        listDevServers: async () => lists.shift() || [ready],
        launchPlan: async () => ({ ok: true, child: null }),
        existsSync: () => false,
        wait: async () => { waits += 1; },
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'started');
    assert.equal(waits, 1);
  });

  test('hydrates missing dependencies before launching the declared server', async () => {
    const plan = makePlan('/tmp/worktree-hydrate');
    const ready = makeServer(plan);
    const lists = [[], [ready]];
    const events = [];
    const result = await ensureDevServer(plan, {
      sessionName: 'hydrate-session',
      deps: baseDeps({
        listDevServers: async () => lists.shift() || [ready],
        dependencyStatus: async () => {
          events.push('status');
          return { ready: false, mode: { name: 'auto' } };
        },
        hydrateDependencies: async () => {
          events.push('hydrate');
          return { ok: true, source: 'snapshot', status: { ready: true } };
        },
        launchPlan: async () => {
          events.push('launch');
          return { ok: true, child: null };
        },
        existsSync: () => false,
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.dependencies.action, 'snapshot');
    assert.deepEqual(events, ['status', 'hydrate', 'launch']);
  });

  test('serializes constrained heavy starts across worktrees before rechecking concurrency', async () => {
    const plan = makePlan('/tmp/worktree-heavy-start', { profile: 'full', resourceClass: 'heavy' });
    const ready = makeServer(plan);
    const lists = [[], [], [ready]];
    const locks = [];
    const releases = [];
    const result = await ensureDevServer(plan, {
      sessionName: 'heavy-session',
      deps: baseDeps({
        acquireLock: async (path) => {
          locks.push(path);
          return { release: () => releases.push(path) };
        },
        listDevServers: async () => lists.shift() || [ready],
        readConfig: async () => ({ resources: { localHeavyJobs: { profile: 'conservative' } } }),
        collectHostMetrics: () => ({ freeDiskGb: 100, swapUsedMb: 0 }),
        launchPlan: async () => ({ ok: true, child: null }),
        existsSync: () => false,
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(locks.length, 2);
    assert.match(locks[1], /heavy-resource\.lock$/);
    assert.deepEqual(releases, [locks[1], locks[0]]);
  });

  test('never treats another worktree as a reuse candidate', () => {
    const plan = makePlan('/tmp/worktree-e');
    const other = makeServer({ ...plan, worktree_path: '/tmp/worktree-other' });
    const comparison = compareDevServerToPlan(other, plan);
    assert.equal(comparison.exact, false);
    assert.deepEqual(comparison.mismatches, ['worktree']);
  });
});

describe('dev ensure launch and resource contract', () => {
  test('launches the exact declared argv without a shell and with plan identity env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-dev-launch-'));
    const plan = makePlan(root);
    const calls = [];
    try {
      const result = await launchDevPlan(plan, {
        sessionName: 'launch-session',
        mcSessionId: 'mcs_000000000000000000000001',
        codingSessionId: 'sess_launch',
        deps: {
          spawn(command, args, options) {
            calls.push({ command, args, options });
            const child = new EventEmitter();
            child.pid = 4321;
            child.unref = () => {};
            queueMicrotask(() => child.emit('spawn'));
            return child;
          },
        },
      });

      assert.equal(result.ok, true);
      assert.equal(calls[0].command, 'npm');
      assert.deepEqual(calls[0].args, ['run', 'dev', '--', '--skip-containers']);
      assert.equal(calls[0].options.shell, false);
      assert.equal(calls[0].options.cwd, root);
      assert.equal(calls[0].options.env.MC_DEV_PROFILE, 'agent');
      assert.equal(calls[0].options.env.MC_DEV_DEFINITION_FINGERPRINT, FINGERPRINT);
      assert.equal(calls[0].options.env.MC_SESSION_NAME, 'launch-session');
      assert.equal(calls[0].options.env.MC_SESSION_ID, 'mcs_000000000000000000000001');
      assert.equal(calls[0].options.env.MC_CODING_SESSION_ID, 'sess_launch');
      assert.equal(existsSync(join(root, '.runtime', 'mc-dev-ensure.log')), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('heavy profiles respect the configured preflight and concurrency gate', async () => {
    const plan = makePlan('/tmp/heavy-worktree', { profile: 'full', resourceClass: 'heavy' });
    const blockedByDisk = await evaluateDevResourceGate(plan, {
      deps: {
        readConfig: async () => ({ resources: { localHeavyJobs: { profile: 'conservative' } } }),
        collectHostMetrics: () => ({ freeDiskGb: 2, swapUsedMb: 0 }),
      },
    });
    assert.equal(blockedByDisk.ok, false);
    assert.match(blockedByDisk.reason, /GB disk free/);

    const active = makeServer(plan, { instance_id: 'another-heavy' });
    const blockedByConcurrency = await evaluateDevResourceGate(plan, {
      servers: [active],
      deps: {
        readConfig: async () => ({ resources: { localHeavyJobs: { profile: 'conservative' } } }),
        collectHostMetrics: () => ({ freeDiskGb: 100, swapUsedMb: 0 }),
      },
    });
    assert.equal(blockedByConcurrency.ok, false);
    assert.match(blockedByConcurrency.reason, /already running/);
  });

  test('exports deterministic plan identity variables for project wrappers', () => {
    const plan = makePlan('/tmp/env-worktree');
    const env = devEnsureEnvironment(plan, {
      sessionName: 'env-session',
      baseEnv: { PATH: '/bin' },
    });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.MC_DEV_MANIFEST_PATH, '/tmp/env-worktree/.runtime/mc-dev.json');
    assert.equal(env.MC_DEV_START_ARGV_JSON, JSON.stringify(plan.start.argv));
    assert.equal(env.MC_DEV_RESOURCE_CLASS, 'standard');
  });
});
