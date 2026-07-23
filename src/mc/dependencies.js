import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { mcHome } from './paths.js';

const DEPENDENCY_SCHEMA_VERSION = 1;
const MARKER_FILE = '.mc-dependency-snapshot.json';
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const DEAD_LOCK_OWNER_GRACE_MS = 1_000;
const MAX_CAPTURE_BYTES = 256 * 1024;

export async function computeDependencyFingerprint(plan, {
  nodeAbi = process.versions.modules,
  platform = process.platform,
  arch = process.arch,
  npmVersion = null,
  readFile = readFileSync,
  runProcess = defaultRunProcess,
} = {}) {
  const dependencies = plan?.dependencies;
  const worktreePath = plan?.worktree_path;
  if (!worktreePath || dependencies?.manager !== 'npm') {
    throw new Error('an npm dev dependency plan with worktree_path is required');
  }
  const resolvedNpmVersion = npmVersion || await readNpmVersion({
    cwd: worktreePath,
    runProcess,
  });
  const files = [...dependencies.fingerprint_files].sort().map((relativePath) => {
    let contents;
    try {
      contents = readFile(join(worktreePath, relativePath));
    } catch (error) {
      throw new Error(`dependency fingerprint input is unreadable: ${relativePath} (${error.message})`);
    }
    return {
      path: relativePath,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  });
  const payload = {
    schema_version: DEPENDENCY_SCHEMA_VERSION,
    manager: 'npm',
    install_argv: [...dependencies.install.argv],
    files,
    runtime: {
      node_abi: String(nodeAbi || ''),
      platform: String(platform || ''),
      arch: String(arch || ''),
      npm_version: String(resolvedNpmVersion || ''),
    },
  };
  for (const [key, value] of Object.entries(payload.runtime)) {
    if (!value) throw new Error(`dependency fingerprint runtime field is missing: ${key}`);
  }
  return {
    ...payload,
    value: `sha256:${createHash('sha256').update(stableStringify(payload)).digest('hex')}`,
  };
}

export async function dependencyStatus(plan, {
  mcDir = mcHome(),
  fingerprint = null,
  fingerprintOptions = {},
} = {}) {
  const resolvedFingerprint = fingerprint || await computeDependencyFingerprint(plan, fingerprintOptions);
  const worktreePath = plan.worktree_path;
  const nodeModulesPath = join(worktreePath, 'node_modules');
  const snapshotPath = dependencySnapshotPath(resolvedFingerprint.value, { mcDir });
  const worktree = inspectWorktreeDependencies(nodeModulesPath, resolvedFingerprint.value);
  const snapshot = inspectSnapshot(snapshotPath, resolvedFingerprint.value);
  const mode = plan?.dependency_mode?.name || 'auto';
  return {
    schema_version: DEPENDENCY_SCHEMA_VERSION,
    worktree_path: worktreePath,
    service: plan.service,
    profile: plan.profile,
    mode: {
      name: mode,
      source: plan?.dependency_mode?.source || 'package-defaults',
    },
    fingerprint: resolvedFingerprint,
    worktree,
    snapshot,
    ready: worktree.state === 'ready',
    recommended_action: recommendedAction({ mode, worktree, snapshot }),
  };
}

export async function hydrateDependencies(plan, {
  mcDir = mcHome(),
  replace = false,
  fingerprintOptions = {},
  deps = {},
} = {}) {
  const fingerprint = await computeDependencyFingerprint(plan, {
    ...fingerprintOptions,
    runProcess: fingerprintOptions.runProcess || deps.runProcess || defaultRunProcess,
  });
  let status = await dependencyStatus(plan, { mcDir, fingerprint });
  const mode = status.mode.name;
  if (mode === 'off') {
    return { ok: false, changed: false, reason: 'dependency-management-off', status };
  }
  if (status.ready && (mode !== 'auto' || status.snapshot.state === 'ready')) {
    return { ok: true, changed: false, source: 'existing', status };
  }
  if (isUnmanaged(status.worktree.state) && !replace) {
    return {
      ok: false,
      changed: false,
      reason: 'existing-unmanaged-node-modules',
      hint: 'Re-run with --replace only if mc may replace the existing node_modules directory.',
      status,
    };
  }

  const worktreeLock = await acquireDependencyLock(
    dependencyWorktreeLockPath(plan.worktree_path, { mcDir }),
    deps.lockOptions,
  );
  try {
    if (!await dependencyInputsMatch(plan, fingerprint, fingerprintOptions)) {
      return dependencyInputsChanged(status);
    }
    status = await dependencyStatus(plan, { mcDir, fingerprint });
    if (status.ready && (mode !== 'auto' || status.snapshot.state === 'ready')) {
      return { ok: true, changed: false, source: 'existing', status };
    }
    if (isUnmanaged(status.worktree.state) && !replace) {
      return {
        ok: false,
        changed: false,
        reason: 'existing-unmanaged-node-modules',
        hint: 'Re-run with --replace only if mc may replace the existing node_modules directory.',
        status,
      };
    }

    if (mode === 'isolated') {
      const installed = await installIntoWorktree(plan, fingerprint, {
        replace,
        source: 'install-isolated',
        fingerprintOptions,
        deps,
      });
      if (!installed.ok) return { ...installed, status };
      status = await dependencyStatus(plan, { mcDir, fingerprint });
      return { ok: true, changed: true, source: 'install-isolated', status };
    }

    const snapshotLock = await acquireDependencyLock(
      dependencySnapshotLockPath(fingerprint.value, { mcDir }),
      deps.lockOptions,
    );
    try {
      if (!await dependencyInputsMatch(plan, fingerprint, fingerprintOptions)) {
        return dependencyInputsChanged(status);
      }
      status = await dependencyStatus(plan, { mcDir, fingerprint });
      if (status.ready) {
        if (status.snapshot.state === 'ready') {
          return { ok: true, changed: false, source: 'existing', status };
        }
        let published;
        try {
          published = await publishSnapshot(plan, fingerprint, {
            mcDir,
            deps,
            fingerprintOptions,
          });
        } catch (error) {
          if (error?.code === 'DEPENDENCY_INPUTS_CHANGED') return dependencyInputsChanged(status);
          throw error;
        }
        status = await dependencyStatus(plan, { mcDir, fingerprint });
        return {
          ok: true,
          changed: true,
          source: 'existing',
          snapshot_published: true,
          snapshot_method: published.method,
          status,
        };
      }
      if (status.snapshot.state === 'ready') {
        let cloned;
        try {
          cloned = await hydrateFromSnapshot(plan, fingerprint, status.snapshot.path, {
            replace,
            deps,
            fingerprintOptions,
          });
        } catch (error) {
          if (error?.code === 'DEPENDENCY_INPUTS_CHANGED') return dependencyInputsChanged(status);
          throw error;
        }
        touchSnapshotMetadata(status.snapshot.path, fingerprint.value, { now: deps.now });
        status = await dependencyStatus(plan, { mcDir, fingerprint });
        return {
          ok: true,
          changed: true,
          source: 'snapshot',
          clone_method: cloned.method,
          status,
        };
      }

      const installed = await installIntoWorktree(plan, fingerprint, {
        replace,
        source: 'install',
        fingerprintOptions,
        deps,
      });
      if (!installed.ok) return { ...installed, status };

      const warnings = [];
      let snapshotMethod = null;
      try {
        const published = await publishSnapshot(plan, fingerprint, {
          mcDir,
          deps,
          fingerprintOptions,
        });
        snapshotMethod = published.method;
      } catch (error) {
        if (error?.code === 'DEPENDENCY_INPUTS_CHANGED') return dependencyInputsChanged(status);
        warnings.push({ code: 'snapshot-publish-failed', message: error.message });
      }
      status = await dependencyStatus(plan, { mcDir, fingerprint });
      return {
        ok: true,
        changed: true,
        source: 'install',
        snapshot_method: snapshotMethod,
        warnings,
        status,
      };
    } finally {
      snapshotLock.release();
    }
  } finally {
    worktreeLock.release();
  }
}

export function dependencySnapshotPath(fingerprint, { mcDir = mcHome() } = {}) {
  const digest = fingerprintDigest(fingerprint);
  return join(mcDir, 'dependency-snapshots', 'v1', 'npm', digest);
}

export async function cloneDependencyDirectory(source, target, {
  platform = process.platform,
  runProcess = defaultRunProcess,
  copy = cpSync,
} = {}) {
  if (platform === 'darwin') {
    const cloned = await runProcess(['/bin/cp', '-cR', source, target], {
      cwd: dirname(target),
      env: process.env,
    });
    if (cloned?.ok || cloned?.code === 0) return { method: 'apfs-clone' };
    rmSync(target, { recursive: true, force: true });
  }
  copy(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  return { method: 'copy' };
}

export async function acquireDependencyLock(path, {
  timeoutMs = LOCK_TIMEOUT_MS,
  staleMs = LOCK_STALE_MS,
  pollMs = 100,
  now = () => Date.now(),
  wait = sleep,
  isAlive = processIsAlive,
} = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const startedAt = Number(now());
  const token = randomUUID();
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({
        schema_version: DEPENDENCY_SCHEMA_VERSION,
        token,
        pid: process.pid,
        acquired_at: new Date(Number(now())).toISOString(),
      }), { flag: 'wx', mode: 0o600 });
      return {
        acquired: true,
        path,
        release: () => releaseLock(path, token),
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    if (recoverStaleLock(path, { now: Number(now()), staleMs, isAlive })) continue;
    if (Number(now()) - startedAt >= timeoutMs) {
      throw new Error(`timed out waiting for dependency lock: ${path}`);
    }
    await wait(pollMs);
  }
}

async function installIntoWorktree(plan, fingerprint, {
  replace,
  source,
  fingerprintOptions,
  deps,
}) {
  const target = join(plan.worktree_path, 'node_modules');
  if (replace && existsSync(target)) rmSync(target, { recursive: true, force: true });
  const runProcess = deps.runProcess || defaultRunProcess;
  const result = await runProcess(plan.dependencies.install.argv, {
    cwd: plan.worktree_path,
    env: {
      ...process.env,
      npm_config_prefer_offline: 'true',
    },
    onOutput: deps.onOutput,
  });
  if (!result?.ok && result?.code !== 0) {
    return {
      ok: false,
      changed: false,
      reason: 'install-failed',
      exit_code: result?.code ?? null,
    };
  }
  if (!isRegularDirectory(target)) {
    return {
      ok: false,
      changed: false,
      reason: 'install-produced-no-node-modules',
    };
  }
  if (!await dependencyInputsMatch(plan, fingerprint, fingerprintOptions)) {
    return dependencyInputsChanged();
  }
  writeDependencyMarker(target, fingerprint, { source, now: deps.now });
  return { ok: true };
}

async function publishSnapshot(plan, fingerprint, { mcDir, deps, fingerprintOptions }) {
  const target = dependencySnapshotPath(fingerprint.value, { mcDir });
  if (inspectSnapshot(target, fingerprint.value).state === 'ready') {
    return { method: 'existing' };
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${randomUUID()}`;
  mkdirSync(temp, { recursive: false, mode: 0o700 });
  try {
    const cloned = await cloneDependencyDirectory(
      join(plan.worktree_path, 'node_modules'),
      join(temp, 'node_modules'),
      {
        platform: deps.platform || process.platform,
        runProcess: deps.copyProcess || defaultRunProcess,
        copy: deps.copy || cpSync,
      },
    );
    if (!await dependencyInputsMatch(plan, fingerprint, fingerprintOptions)) {
      throw dependencyInputsChangedError();
    }
    const timestamp = isoNow(deps.now);
    writeFileSync(join(temp, 'metadata.json'), JSON.stringify({
      schema_version: DEPENDENCY_SCHEMA_VERSION,
      fingerprint: fingerprint.value,
      manager: fingerprint.manager,
      runtime: fingerprint.runtime,
      files: fingerprint.files,
      created_at: timestamp,
      last_used_at: timestamp,
    }, null, 2), { mode: 0o600 });
    renameSync(temp, target);
    return cloned;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (inspectSnapshot(target, fingerprint.value).state === 'ready') {
      return { method: 'existing' };
    }
    throw error;
  }
}

function touchSnapshotMetadata(snapshotPath, fingerprint, { now } = {}) {
  const path = join(snapshotPath, 'metadata.json');
  const metadata = readJson(path);
  if (metadata?.schema_version !== DEPENDENCY_SCHEMA_VERSION
    || metadata?.fingerprint !== fingerprint) return false;
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, JSON.stringify({
      ...metadata,
      last_used_at: isoNow(now),
    }, null, 2), { mode: 0o600 });
    renameSync(temp, path);
    return true;
  } catch {
    try { unlinkSync(temp); } catch {}
    return false;
  }
}

async function hydrateFromSnapshot(plan, fingerprint, snapshotPath, {
  replace,
  deps,
  fingerprintOptions,
}) {
  const target = join(plan.worktree_path, 'node_modules');
  const temp = join(plan.worktree_path, `.node_modules.mc-hydrate-${randomUUID()}`);
  const backup = join(plan.worktree_path, `.node_modules.mc-backup-${randomUUID()}`);
  let movedExisting = false;
  try {
    const cloned = await cloneDependencyDirectory(join(snapshotPath, 'node_modules'), temp, {
      platform: deps.platform || process.platform,
      runProcess: deps.copyProcess || defaultRunProcess,
      copy: deps.copy || cpSync,
    });
    if (!await dependencyInputsMatch(plan, fingerprint, fingerprintOptions)) {
      throw dependencyInputsChangedError();
    }
    writeDependencyMarker(temp, fingerprint, { source: 'snapshot', now: deps.now });
    if (existsSync(target)) {
      if (!replace) {
        const current = inspectWorktreeDependencies(target, fingerprint.value);
        if (isUnmanaged(current.state)) {
          throw new Error('refusing to replace unmanaged node_modules without --replace');
        }
      }
      renameSync(target, backup);
      movedExisting = true;
    }
    renameSync(temp, target);
    if (movedExisting) {
      try { rmSync(backup, { recursive: true, force: true }); } catch {}
    }
    return cloned;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (movedExisting && !existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

function inspectWorktreeDependencies(path, fingerprint) {
  const kind = pathKind(path);
  if (kind === 'missing') return { state: 'missing', path, managed: false, fingerprint: null };
  if (kind === 'symlink') return { state: 'unsafe-symlink', path, managed: false, fingerprint: null };
  if (kind !== 'directory') return { state: 'unmanaged', path, managed: false, fingerprint: null };
  const marker = readJson(join(path, MARKER_FILE));
  if (!validMarker(marker)) {
    return { state: 'unmanaged', path, managed: false, fingerprint: null };
  }
  return {
    state: marker.fingerprint === fingerprint ? 'ready' : 'stale',
    path,
    managed: true,
    fingerprint: marker.fingerprint,
    source: marker.source || null,
    created_at: marker.created_at || null,
  };
}

function inspectSnapshot(path, fingerprint) {
  const metadata = readJson(join(path, 'metadata.json'));
  const nodeModulesKind = pathKind(join(path, 'node_modules'));
  if (!existsSync(path)) return { state: 'missing', path, fingerprint: null };
  if (nodeModulesKind !== 'directory'
    || metadata?.schema_version !== DEPENDENCY_SCHEMA_VERSION
    || metadata?.fingerprint !== fingerprint) {
    return { state: 'invalid', path, fingerprint: metadata?.fingerprint || null };
  }
  return {
    state: 'ready',
    path,
    fingerprint: metadata.fingerprint,
    created_at: metadata.created_at || null,
  };
}

function writeDependencyMarker(nodeModulesPath, fingerprint, {
  source,
  now,
} = {}) {
  const path = join(nodeModulesPath, MARKER_FILE);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify({
    schema_version: DEPENDENCY_SCHEMA_VERSION,
    fingerprint: fingerprint.value,
    manager: fingerprint.manager,
    source,
    node_abi: fingerprint.runtime.node_abi,
    platform: fingerprint.runtime.platform,
    arch: fingerprint.runtime.arch,
    npm_version: fingerprint.runtime.npm_version,
    created_at: isoNow(now),
  }, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

function dependencySnapshotLockPath(fingerprint, { mcDir }) {
  return join(mcDir, 'dependency-snapshots', 'v1', 'locks', `${fingerprintDigest(fingerprint)}.lock`);
}

function dependencyWorktreeLockPath(worktreePath, { mcDir }) {
  const digest = createHash('sha256').update(worktreePath).digest('hex');
  return join(mcDir, 'dependency-snapshots', 'v1', 'locks', `worktree-${digest}.lock`);
}

function fingerprintDigest(fingerprint) {
  const match = String(fingerprint || '').match(/^sha256:([a-f0-9]{64})$/);
  if (!match) throw new Error('invalid dependency fingerprint');
  return match[1];
}

function recommendedAction({ mode, worktree, snapshot }) {
  if (mode === 'off') return 'disabled';
  if (worktree.state === 'ready') {
    return mode === 'auto' && snapshot.state !== 'ready' ? 'publish-snapshot' : 'none';
  }
  if (isUnmanaged(worktree.state)) return 'replace-explicitly';
  if (mode === 'isolated') return 'install-isolated';
  if (snapshot.state === 'ready') return 'hydrate-from-snapshot';
  return 'install-and-publish-snapshot';
}

async function dependencyInputsMatch(plan, fingerprint, options = {}) {
  const current = await computeDependencyFingerprint(plan, {
    nodeAbi: fingerprint.runtime.node_abi,
    platform: fingerprint.runtime.platform,
    arch: fingerprint.runtime.arch,
    npmVersion: fingerprint.runtime.npm_version,
    readFile: options.readFile || readFileSync,
  });
  return current.value === fingerprint.value;
}

function dependencyInputsChanged(status = null) {
  return {
    ok: false,
    changed: false,
    reason: 'dependency-inputs-changed',
    hint: 'package or lockfile inputs changed during hydration; re-run mc deps hydrate.',
    ...(status ? { status } : {}),
  };
}

function dependencyInputsChangedError() {
  const error = new Error('package or lockfile inputs changed during dependency copy');
  error.code = 'DEPENDENCY_INPUTS_CHANGED';
  return error;
}

function isUnmanaged(state) {
  return state === 'unmanaged' || state === 'unsafe-symlink';
}

function pathKind(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return 'other';
  }
}

function isRegularDirectory(path) {
  return pathKind(path) === 'directory';
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function validMarker(marker) {
  return marker?.schema_version === DEPENDENCY_SCHEMA_VERSION
    && typeof marker.fingerprint === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(marker.fingerprint);
}

function recoverStaleLock(path, { now, staleMs, isAlive }) {
  try {
    const age = now - statSync(path).mtimeMs;
    if (!Number.isFinite(age)) return false;
    const owner = readJson(path);
    if (Number.isInteger(owner?.pid)) {
      if (isAlive(owner.pid)) return false;
      if (age < DEAD_LOCK_OWNER_GRACE_MS) return false;
    } else if (age < staleMs) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(path, token) {
  try {
    if (readJson(path)?.token === token) unlinkSync(path);
  } catch {}
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readNpmVersion({ cwd, runProcess }) {
  const result = await runProcess(['npm', '--version'], { cwd, env: process.env });
  if (!result?.ok && result?.code !== 0) {
    throw new Error(`failed to read npm version${result?.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  const version = String(result.stdout || '').trim().split(/\s+/)[0];
  if (!version) throw new Error('npm --version returned no version');
  return version;
}

function defaultRunProcess(argv, {
  cwd,
  env = process.env,
  onOutput = null,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk.toString('utf8'));
      onOutput?.('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'));
      onOutput?.('stderr', chunk);
    });
    child.on('error', (error) => resolve({ ok: false, code: null, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

function appendBounded(current, next) {
  const combined = current + next;
  return combined.length <= MAX_CAPTURE_BYTES ? combined : combined.slice(-MAX_CAPTURE_BYTES);
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : (now ?? Date.now());
  return new Date(value).toISOString();
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
