import { createHash } from 'node:crypto';
import { spawn as defaultSpawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEV_SERVER_LOCKS_DIRECTORY } from './dev-servers.js';
import { setTimeout as sleep } from 'node:timers/promises';

import { readConfig } from '../lib/config.js';
import {
  dependencyStatus,
  hydrateDependencies,
  acquireDependencyLock,
} from './dependencies.js';
import {
  controlDevServer,
  listDevServers,
  registerDevServerManifest,
} from './dev-servers.js';
import {
  collectHostMetrics,
  evaluateLocalHeavyJobPreflight,
} from './local-resource-guard.js';
import { resolveLocalResourceProfile } from './local-resource-profile.js';
import { mcHome } from './paths.js';

const ENSURE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

export async function ensureDevServer(plan, {
  restart = false,
  sessionName = process.env.MC_SESSION_NAME,
  mcSessionId = process.env.MC_SESSION_ID,
  codingSessionId = process.env.MC_CODING_SESSION_ID,
  mcDir = mcHome(),
  deps = {},
} = {}) {
  if (!plan?.worktree_path || !plan?.service?.name || !plan?.profile?.name) {
    throw new Error('a resolved dev plan is required');
  }
  if (!sessionName) {
    return refusal(
      'missing-session-identity',
      'mc dev ensure must run inside an mc session with MC_SESSION_NAME set',
    );
  }

  const acquireLock = deps.acquireLock || acquireDependencyLock;
  const lock = await acquireLock(devEnsureLockPath(plan, { mcDir }), {
    timeoutMs: ENSURE_LOCK_TIMEOUT_MS,
    ...(deps.lockOptions || {}),
  });
  let resourceLock = null;
  try {
    const list = deps.listDevServers || listDevServers;
    let servers = await list(deps.devServerOptions || {});
    const live = liveServersForPlan(servers, plan);
    if (live.length > 1) {
      return refusal(
        'multiple-live-servers',
        `${live.length} verified dev servers already claim this worktree and service`,
        { servers: live.map(serverIdentity) },
      );
    }

    const existing = live[0] || null;
    if (existing) {
      const comparison = compareDevServerToPlan(existing, plan);
      if (comparison.exact && existing.state === 'ready') {
        return {
          ok: true,
          changed: false,
          action: 'reused',
          server: existing,
          comparison,
          dependencies: { action: 'unchanged-running-server' },
        };
      }
      if (comparison.exact && existing.state === 'starting') {
        const waited = await waitForExistingReady(plan, existing, {
          list,
          deps,
        });
        if (waited.ok) {
          return {
            ok: true,
            changed: false,
            action: 'reused',
            server: waited.server,
            comparison,
            dependencies: { action: 'unchanged-running-server' },
          };
        }
      }
      if (!restart) {
        const reason = comparison.exact ? 'server-not-ready' : 'server-plan-mismatch';
        return refusal(
          reason,
          comparison.exact
            ? `the verified server is ${existing.state}; pass --restart to replace it`
            : `the verified server does not match the requested plan (${comparison.mismatches.join(', ')}); pass --restart to replace it`,
          { server: serverIdentity(existing), comparison },
        );
      }
    }

    let resourceGate = await evaluateDevResourceGate(plan, {
      servers,
      excludingInstanceId: existing?.instance_id || null,
      deps,
    });
    if (!resourceGate.ok) {
      return refusal('resource-gate-blocked', resourceGate.reason, { resource_gate: resourceGate });
    }
    if (plan.resource_class === 'heavy' && resourceGate.profile !== 'unlimited') {
      resourceLock = await acquireLock(devHeavyResourceLockPath({ mcDir }), {
        timeoutMs: ENSURE_LOCK_TIMEOUT_MS,
        ...(deps.lockOptions || {}),
      });
      servers = await list(deps.devServerOptions || {});
      resourceGate = await evaluateDevResourceGate(plan, {
        servers,
        excludingInstanceId: existing?.instance_id || null,
        deps,
      });
      if (!resourceGate.ok) {
        return refusal('resource-gate-blocked', resourceGate.reason, { resource_gate: resourceGate });
      }
    }

    if (existing) {
      const control = deps.controlDevServer || controlDevServer;
      const stopped = await control(existing, 'stop', deps.devServerOptions || {});
      if (!stopped.ok) {
        return refusal('restart-stop-failed', stopped.error || 'project stop command failed', {
          server: serverIdentity(existing),
          control: stopped,
        });
      }
      const stoppedCleanly = await waitForServerStop(plan, existing.instance_id, {
        list,
        deps,
      });
      if (!stoppedCleanly.ok) return stoppedCleanly;
      servers = stoppedCleanly.servers;
    }

    const prepare = await prepareDependencies(plan, { mcDir, deps });
    if (!prepare.ok) return prepare;

    const startedAt = Date.now();
    const launch = deps.launchPlan || launchDevPlan;
    const launched = await launch(plan, {
      sessionName,
      mcSessionId,
      codingSessionId,
      deps,
    });
    if (!launched.ok) {
      return refusal('start-failed', launched.error || 'failed to launch declared start argv', {
        dependencies: prepare.dependencies,
      });
    }

    const ready = await waitForStartedReady(plan, {
      startedAt,
      child: launched.child || null,
      list,
      deps,
    });
    const launchInfo = {
      argv: [...plan.start.argv],
      shell: false,
      pid: launched.child?.pid ?? null,
      log_path: launched.log_path || null,
    };
    if (!ready.ok) {
      return {
        ...ready,
        dependencies: prepare.dependencies,
        resource_gate: resourceGate,
        launch: launchInfo,
      };
    }
    return {
      ok: true,
      changed: true,
      action: existing ? 'restarted' : 'started',
      server: ready.server,
      comparison: compareDevServerToPlan(ready.server, plan),
      dependencies: prepare.dependencies,
      resource_gate: resourceGate,
      launch: launchInfo,
    };
  } finally {
    resourceLock?.release();
    lock.release();
  }
}

export function compareDevServerToPlan(server, plan) {
  const checks = {
    worktree: resolve(server?.worktree_path || '') === resolve(plan.worktree_path),
    service: server?.service === plan.service.name,
    profile: server?.profile === plan.profile.name,
    definition: server?.definition_fingerprint === plan.definition_fingerprint,
    start_argv: sameArgv(server?.start_argv, plan.start.argv),
    resource_class: server?.resource_class === plan.resource_class,
  };
  return {
    exact: Object.values(checks).every(Boolean),
    checks,
    mismatches: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key),
  };
}

export async function evaluateDevResourceGate(plan, {
  servers = [],
  excludingInstanceId = null,
  deps = {},
} = {}) {
  const config = await (deps.readConfig || readConfig)();
  const profile = resolveLocalResourceProfile(config);
  if (plan.resource_class !== 'heavy' || !profile.enabled) {
    return { ok: true, resource_class: plan.resource_class, profile: profile.profile, reason: null };
  }
  const metrics = (deps.collectHostMetrics || collectHostMetrics)({ cwd: plan.worktree_path });
  const preflight = evaluateLocalHeavyJobPreflight(profile, metrics);
  if (!preflight.ok) {
    return {
      ok: false,
      resource_class: plan.resource_class,
      profile: profile.profile,
      metrics,
      reason: preflight.reason,
    };
  }
  const activeHeavy = servers.filter((server) => (
    server.instance_id !== excludingInstanceId
    && server.resource_class === 'heavy'
    && server.identity?.ok
    && ['starting', 'ready', 'unhealthy'].includes(server.state)
  ));
  if (activeHeavy.length >= profile.maxConcurrent) {
    return {
      ok: false,
      resource_class: plan.resource_class,
      profile: profile.profile,
      active_heavy_servers: activeHeavy.map(serverIdentity),
      reason: `${activeHeavy.length} heavy dev server${activeHeavy.length === 1 ? ' is' : 's are'} already running; profile ${profile.profile} allows ${profile.maxConcurrent}`,
    };
  }
  return {
    ok: true,
    resource_class: plan.resource_class,
    profile: profile.profile,
    metrics,
    active_heavy_servers: activeHeavy.map(serverIdentity),
    reason: null,
  };
}

export function devEnsureEnvironment(plan, {
  sessionName,
  mcSessionId = null,
  codingSessionId = null,
  baseEnv = process.env,
} = {}) {
  const manifestPath = join(plan.worktree_path, plan.readiness.path);
  return {
    ...baseEnv,
    MC_DEV_ENSURE_LAUNCH: '1',
    MC_DEV_CONTROLLED_BY: 'mc',
    MC_DEV_MANIFEST_PATH: manifestPath,
    MC_DEV_SERVICE: plan.service.name,
    MC_DEV_PROFILE: plan.profile.name,
    MC_DEV_DEFINITION_FINGERPRINT: plan.definition_fingerprint,
    MC_DEV_START_ARGV_JSON: JSON.stringify(plan.start.argv),
    MC_DEV_RESOURCE_CLASS: plan.resource_class,
    MC_SESSION_NAME: sessionName,
    ...(mcSessionId ? { MC_SESSION_ID: mcSessionId } : {}),
    ...(codingSessionId ? { MC_CODING_SESSION_ID: codingSessionId } : {}),
  };
}

async function prepareDependencies(plan, { mcDir, deps }) {
  const status = await (deps.dependencyStatus || dependencyStatus)(plan, {
    mcDir,
    ...(deps.dependencyOptions || {}),
  });
  if (status.ready) {
    return { ok: true, dependencies: { action: 'existing', status } };
  }
  const hydrate = deps.hydrateDependencies || hydrateDependencies;
  const result = await hydrate(plan, {
    mcDir,
    ...(deps.dependencyOptions || {}),
    deps: {
      ...(deps.dependencyOptions?.deps || {}),
      onOutput: deps.onDependencyOutput || null,
    },
  });
  if (!result.ok) {
    return refusal(
      'dependencies-not-ready',
      `dependency preparation refused (${result.reason || 'unknown'})`,
      { dependencies: result },
    );
  }
  return { ok: true, dependencies: { action: result.source, result } };
}

export async function launchDevPlan(plan, {
  sessionName,
  mcSessionId,
  codingSessionId,
  deps = {},
}) {
  const manifestPath = join(plan.worktree_path, plan.readiness.path);
  const runtimeDir = dirname(manifestPath);
  const logPath = join(runtimeDir, 'mc-dev-ensure.log');
  const mkdir = deps.mkdirSync || mkdirSync;
  const open = deps.openSync || openSync;
  const close = deps.closeSync || closeSync;
  const spawn = deps.spawn || defaultSpawn;
  mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = open(logPath, 'a', 0o600);
    const child = spawn(plan.start.argv[0], plan.start.argv.slice(1), {
      cwd: plan.worktree_path,
      env: devEnsureEnvironment(plan, { sessionName, mcSessionId, codingSessionId }),
      detached: true,
      stdio: ['ignore', fd, fd],
      shell: false,
    });
    await waitForSpawn(child);
    child.unref?.();
    return { ok: true, child, log_path: logPath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (fd != null) {
      try { close(fd); } catch {}
    }
  }
}

async function waitForExistingReady(plan, existing, { list, deps }) {
  const timeoutMs = Math.min(plan.readiness.timeout_ms, 30_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const servers = await list(deps.devServerOptions || {});
    const current = servers.find((server) => server.instance_id === existing.instance_id);
    if (!current?.identity?.ok) return { ok: false, reason: 'server-stopped-while-waiting' };
    if (compareDevServerToPlan(current, plan).exact && current.state === 'ready') {
      return { ok: true, server: current };
    }
    await (deps.wait || sleep)(deps.pollMs || POLL_MS);
  }
  return { ok: false, reason: 'readiness-timeout' };
}

async function waitForServerStop(plan, instanceId, { list, deps }) {
  const deadline = Date.now() + (deps.stopTimeoutMs || STOP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const servers = await list(deps.devServerOptions || {});
    const current = servers.find((server) => server.instance_id === instanceId);
    if (!current?.identity?.ok) return { ok: true, servers };
    await (deps.wait || sleep)(deps.pollMs || POLL_MS);
  }
  return refusal('restart-stop-timeout', `project stop command did not stop ${plan.service.name} within ${deps.stopTimeoutMs || STOP_TIMEOUT_MS}ms`);
}

async function waitForStartedReady(plan, { startedAt, child, list, deps }) {
  const manifestPath = join(plan.worktree_path, plan.readiness.path);
  const deadline = Date.now() + plan.readiness.timeout_ms;
  let lastManifest = null;
  let manifestError = null;
  let childExit = null;
  child?.once?.('exit', (code, signal) => { childExit = { code, signal }; });

  while (Date.now() < deadline) {
    if (!childExit && child?.exitCode != null) {
      childExit = { code: child.exitCode, signal: child.signalCode || null };
    }
    if ((deps.existsSync || existsSync)(manifestPath)) {
      try {
        const contents = (deps.readFileSync || readFileSync)(manifestPath, 'utf8');
        if (contents !== lastManifest) {
          (deps.registerManifest || registerDevServerManifest)(manifestPath, deps.devServerOptions || {});
          lastManifest = contents;
          manifestError = null;
        }
      } catch (error) {
        manifestError = error?.message || String(error);
      }
    }

    const servers = await list(deps.devServerOptions || {});
    const live = liveServersForPlan(servers, plan);
    const exact = live.find((server) => (
      compareDevServerToPlan(server, plan).exact
      && Date.parse(server.started_at) >= startedAt - 1_000
    ));
    if (exact?.state === 'ready') return { ok: true, server: exact };
    const mismatch = live.find((server) => !compareDevServerToPlan(server, plan).exact);
    if (mismatch) {
      const comparison = compareDevServerToPlan(mismatch, plan);
      return refusal(
        'started-manifest-plan-mismatch',
        `the started server manifest does not match the requested plan (${comparison.mismatches.join(', ')})`,
        { server: serverIdentity(mismatch), comparison },
      );
    }
    if (childExit && childExit.code !== 0) {
      return refusal(
        'start-exited',
        `declared start command exited before readiness (code=${childExit.code ?? 'none'}, signal=${childExit.signal || 'none'})`,
      );
    }
    await (deps.wait || sleep)(deps.pollMs || POLL_MS);
  }
  return refusal(
    'readiness-timeout',
    `dev server did not become healthy within ${plan.readiness.timeout_ms}ms`,
    { manifest_path: manifestPath, manifest_error: manifestError },
  );
}

function liveServersForPlan(servers, plan) {
  return servers.filter((server) => (
    resolve(server.worktree_path) === resolve(plan.worktree_path)
    && server.service === plan.service.name
    && server.identity?.ok
  ));
}

function devEnsureLockPath(plan, { mcDir }) {
  const key = createHash('sha256')
    .update(`${resolve(plan.worktree_path)}\0${plan.service.name}`)
    .digest('hex');
  return join(mcDir, 'dev-servers', DEV_SERVER_LOCKS_DIRECTORY, `${key}.lock`);
}

function devHeavyResourceLockPath({ mcDir }) {
  return join(mcDir, 'dev-servers', DEV_SERVER_LOCKS_DIRECTORY, 'heavy-resource.lock');
}

function sameArgv(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function serverIdentity(server) {
  return {
    instance_id: server.instance_id,
    session_name: server.session_name,
    service: server.service,
    profile: server.profile || null,
    state: server.state,
    worktree_path: server.worktree_path,
  };
}

function refusal(reason, error, extra = {}) {
  return { ok: false, changed: false, reason, error, ...extra };
}

function waitForSpawn(child) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
}
