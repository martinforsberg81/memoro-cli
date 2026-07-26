import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

import { guardBinDir } from './cloudflare-guard.js';
import { mcHome as defaultMcHome } from './paths.js';
import { resolveLocalResourceProfile } from './local-resource-profile.js';

export const LOCAL_RESOURCE_GUARD_ENV = 'MC_LOCAL_RESOURCE_PROFILE';
// Set in a protected job's environment so nested guarded commands (npm test
// spawning node --test, python spawning python) don't take a second slot —
// with maxConcurrent 1 that would deadlock the job against itself.
export const LOCAL_HEAVY_JOB_ACTIVE_ENV = 'MC_LOCAL_HEAVY_JOB_ACTIVE';
export const LOCAL_HEAVY_JOB_THREADS_ENV = 'MC_LOCAL_RESOURCE_MAX_THREADS';
export const GUARDED_PYTHON_COMMANDS = Object.freeze([
  'python',
  'python3',
  'python3.9',
  'python3.10',
  'python3.11',
  'python3.12',
  'python3.13',
  'python3.14',
]);
export const GUARDED_NODE_COMMANDS = Object.freeze([
  'node',
  'npm',
]);
const GUARDED_COMMANDS = Object.freeze([
  ...GUARDED_PYTHON_COMMANDS,
  ...GUARDED_NODE_COMMANDS,
]);

// How long a queued test run waits for a protected slot before giving up.
// A full suite here runs ~7 minutes; two queued suites fit comfortably.
const HEAVY_SLOT_WAIT_MS = 20 * 60 * 1000;
const HEAVY_SLOT_POLL_MS = 2_000;
const HEAVY_SLOT_NAG_MS = 30_000;

const HEAVY_COMMAND_RE = /(?:liveportrait|portrait[-_]?motion|avatar[._-]motion|stable[-_]?diffusion|txt2img|img2img|comfyui)/i;
const WATCH_INTERVAL_MS = 1_000;
const TERMINATE_GRACE_MS = 3_000;

export function prepareLocalResourceGuardEnv({
  baseEnv = process.env,
  config = {},
  mcDir = defaultMcHome(),
  codingSessionId = 'session',
  deps = {},
} = {}) {
  const profile = resolveLocalResourceProfile(config);
  if (!profile.enabled) {
    return { installed: false, profile, env: { ...baseEnv }, dir: null };
  }

  const dir = deps.guardBinDir || localResourceGuardBinDir({ mcDir, codingSessionId });
  const mkdir = deps.mkdirSync || mkdirSync;
  const writeFile = deps.writeFileSync || writeFileSync;
  const chmod = deps.chmodSync || chmodSync;
  const script = renderLocalResourceGuardScript({
    profile,
    lockRoot: join(mcDir, 'resource-locks', 'local-heavy-jobs'),
    codingSessionId,
  });

  mkdir(dir, { recursive: true, mode: 0o700 });
  for (const command of GUARDED_COMMANDS) {
    const target = join(dir, command);
    writeFile(target, script, { mode: 0o700 });
    try { chmod(target, 0o700); } catch { /* best effort on non-posix fs */ }
  }

  return {
    installed: true,
    profile,
    dir,
    env: {
      ...baseEnv,
      PATH: prependPath(dir, baseEnv.PATH),
      [LOCAL_RESOURCE_GUARD_ENV]: profile.profile,
    },
  };
}

export function localResourceGuardBinDir({ mcDir = defaultMcHome(), codingSessionId = 'session' } = {}) {
  return join(guardBinDir({ mcDir, codingSessionId }), 'resources');
}

export function renderLocalResourceGuardScript({ profile, lockRoot, codingSessionId = 'session' } = {}) {
  return `#!${process.execPath}\nimport { runLocalResourceGuardShim } from ${JSON.stringify(import.meta.url)};\nprocess.exit(await runLocalResourceGuardShim({\n  invokedPath: process.argv[1],\n  argv: process.argv.slice(2),\n  profile: ${JSON.stringify(profile)},\n  lockRoot: ${JSON.stringify(lockRoot)},\n  codingSessionId: ${JSON.stringify(codingSessionId)},\n}));\n`;
}

export async function runLocalResourceGuardShim({
  invokedPath = process.argv[1],
  argv = process.argv.slice(2),
  profile,
  lockRoot,
  codingSessionId = 'session',
  env = process.env,
  cwd = process.cwd(),
  stderr = process.stderr,
  deps = {},
} = {}) {
  const invoked = basename(invokedPath || '');
  const selfDir = resolve(dirname(invokedPath || '.'));
  if (!GUARDED_COMMANDS.includes(invoked)) {
    stderr.write('mc: local resource guard invoked under an unexpected command name.\n');
    return 127;
  }

  const real = findRealExecutable(invoked, selfDir, env.PATH || '', deps.existsSync || existsSync);
  if (!real) {
    stderr.write(`mc: could not find the real ${invoked} binary after the local resource guard.\n`);
    return 127;
  }

  const childEnv = { ...env, PATH: pathWithoutSelfDir(env.PATH || '', selfDir) };

  // Nested guarded command inside an already-protected job: never take a
  // second slot (deadlock against ourselves at maxConcurrent 1). Priority
  // and thread env are inherited; for a direct nested `node --test`, still
  // cap the runner's worker count.
  if (env[LOCAL_HEAVY_JOB_ACTIVE_ENV] === '1') {
    const nestedArgv = invoked === 'node'
      ? withTestConcurrencyCap(argv, env[LOCAL_HEAVY_JOB_THREADS_ENV])
      : argv;
    return passThrough(real, nestedArgv, { cwd, env: childEnv, stderr, spawnSyncFn: deps.spawnSync || spawnSync });
  }

  const nodeInvocation = GUARDED_NODE_COMMANDS.includes(invoked);
  const heavy = nodeInvocation
    ? isLocalHeavyNodeCommand(invoked, argv)
    : isLocalHeavyPythonCommand(argv);
  if (!heavy) {
    return passThrough(real, argv, { cwd, env: childEnv, stderr, spawnSyncFn: deps.spawnSync || spawnSync });
  }

  const preflight = evaluateLocalHeavyJobPreflight(profile, (deps.collectHostMetrics || collectHostMetrics)({ cwd }));
  if (!preflight.ok) {
    stderr.write(`mc: blocked local heavy job to protect this computer (${preflight.reason}).\n`);
    stderr.write('mc: choose another profile with `mc setup`, or free resources and retry.\n');
    return 75;
  }

  // Test runs queue for a slot instead of failing outright — sessions
  // should serialise, not break. Python heavy jobs keep the original
  // fail-fast contract (they are typically retried by an orchestrator).
  const lock = nodeInvocation
    ? await (deps.waitForHeavyJobSlot || waitForHeavyJobSlot)({
      lockRoot,
      maxConcurrent: profile.maxConcurrent,
      codingSessionId,
      stderr,
      deps,
    })
    : (deps.acquireHeavyJobSlot || acquireHeavyJobSlot)({
      lockRoot,
      maxConcurrent: profile.maxConcurrent,
      codingSessionId,
    });
  if (!lock) {
    stderr.write(`mc: blocked local heavy job because ${profile.maxConcurrent} protected job${profile.maxConcurrent === 1 ? ' is' : 's are'} already running.\n`);
    return 75;
  }

  stderr.write(`mc: local heavy-job guard active (${profile.profile}: ${profile.maxThreads} threads, ${profile.maxRssMb} MB memory guard).\n`);
  const protectedArgv = invoked === 'node'
    ? withTestConcurrencyCap(argv, profile.maxThreads)
    : argv;
  try {
    return await runProtectedChild(real, protectedArgv, {
      cwd,
      env: {
        ...applyThreadLimits(childEnv, profile.maxThreads),
        UV_THREADPOOL_SIZE: String(Math.max(1, Number(profile.maxThreads) || 1)),
        [LOCAL_HEAVY_JOB_ACTIVE_ENV]: '1',
        [LOCAL_HEAVY_JOB_THREADS_ENV]: String(Math.max(1, Number(profile.maxThreads) || 1)),
      },
      profile,
      stderr,
      deps,
    });
  } finally {
    (deps.releaseHeavyJobSlot || releaseHeavyJobSlot)(lock);
  }
}

/**
 * Heavy Node work = test runs. `node --test` fans out one worker per CPU
 * by default, and parallel sessions each doing that is exactly what
 * drowns the machine. Regular `node script.js`, `npm ci`, `npm run dev`
 * etc. pass through untouched.
 */
export function isLocalHeavyNodeCommand(invoked, argv = []) {
  const args = argv.map((arg) => String(arg));
  if (invoked === 'node') {
    return args.includes('--test');
  }
  if (invoked === 'npm') {
    const words = args.filter((arg) => !arg.startsWith('-'));
    const sub = words[0] || '';
    if (sub === 'test' || sub === 't' || sub === 'tst') return true;
    if (sub === 'run' || sub === 'run-script') return /test/i.test(words[1] || '');
    return false;
  }
  return false;
}

function withTestConcurrencyCap(argv, maxThreads) {
  const cap = Math.max(1, Number(maxThreads) || 1);
  const args = argv.map((arg) => String(arg));
  if (!args.includes('--test')) return argv;
  if (args.some((arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='))) {
    return argv;
  }
  const index = args.indexOf('--test');
  return [...args.slice(0, index + 1), `--test-concurrency=${cap}`, ...args.slice(index + 1)];
}

export async function waitForHeavyJobSlot({
  lockRoot,
  maxConcurrent = 1,
  codingSessionId = 'session',
  stderr = process.stderr,
  waitMs = HEAVY_SLOT_WAIT_MS,
  pollMs = HEAVY_SLOT_POLL_MS,
  nagMs = HEAVY_SLOT_NAG_MS,
  deps = {},
} = {}) {
  const acquire = deps.acquireHeavyJobSlot || acquireHeavyJobSlot;
  const sleep = deps.sleep || ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const now = deps.now || Date.now;
  const started = now();
  let lastNag = 0;
  for (;;) {
    const lock = acquire({ lockRoot, maxConcurrent, codingSessionId });
    if (lock) return lock;
    const elapsed = now() - started;
    if (elapsed >= waitMs) return null;
    if (elapsed - lastNag >= nagMs) {
      lastNag = elapsed;
      stderr.write(`mc: waiting for a protected job slot (${maxConcurrent} allowed, queued ${Math.round(elapsed / 1000)}s)...\n`);
    }
    await sleep(pollMs);
  }
}

export function isLocalHeavyPythonCommand(argv = []) {
  const args = argv.map((arg) => String(arg));
  const joined = args.join(' ');
  if (HEAVY_COMMAND_RE.test(joined)) return true;
  const forceCpu = args.some((arg) => arg === '--flag-force-cpu');
  const inference = args.some((arg) => /(?:^|\/)inference\.py$/i.test(arg));
  return forceCpu && inference;
}

export function applyThreadLimits(env = {}, maxThreads = 1) {
  const value = String(Math.max(1, Number(maxThreads) || 1));
  return {
    ...env,
    OMP_NUM_THREADS: value,
    MKL_NUM_THREADS: value,
    OPENBLAS_NUM_THREADS: value,
    VECLIB_MAXIMUM_THREADS: value,
    NUMEXPR_NUM_THREADS: value,
    TOKENIZERS_PARALLELISM: 'false',
  };
}

export function evaluateLocalHeavyJobPreflight(profile, metrics = {}) {
  if (!profile?.enabled) return { ok: true, reason: null };
  if (Number.isFinite(metrics.freeDiskGb) && metrics.freeDiskGb < profile.minFreeDiskGb) {
    return { ok: false, reason: `${metrics.freeDiskGb.toFixed(1)} GB disk free; ${profile.minFreeDiskGb} GB required` };
  }
  if (Number.isFinite(metrics.swapUsedMb) && metrics.swapUsedMb > profile.maxSwapMb) {
    return { ok: false, reason: `${Math.round(metrics.swapUsedMb)} MB swap already used; limit is ${profile.maxSwapMb} MB` };
  }
  return { ok: true, reason: null };
}

export function evaluateLocalHeavyJobRuntime(profile, metrics = {}) {
  const preflight = evaluateLocalHeavyJobPreflight(profile, metrics);
  if (!preflight.ok) return preflight;
  if (Number.isFinite(metrics.processTreeRssMb) && metrics.processTreeRssMb > profile.maxRssMb) {
    return { ok: false, reason: `${Math.round(metrics.processTreeRssMb)} MB job memory; limit is ${profile.maxRssMb} MB` };
  }
  return { ok: true, reason: null };
}

export function collectHostMetrics({ cwd = process.cwd() } = {}) {
  return {
    freeDiskGb: readFreeDiskGb(cwd),
    swapUsedMb: readSwapUsedMb(),
  };
}

export function acquireHeavyJobSlot({
  lockRoot,
  maxConcurrent = 1,
  codingSessionId = 'session',
  pid = process.pid,
  isAlive = isProcessAlive,
} = {}) {
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const token = `${pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  for (let index = 1; index <= maxConcurrent; index += 1) {
    const path = join(lockRoot, `slot-${index}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid, token, codingSessionId }));
        return { path, token };
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        const owner = readLockOwner(path);
        if (owner?.pid && isAlive(owner.pid)) break;
        try { rmSync(path, { recursive: true, force: true }); } catch { break; }
      }
    }
  }
  return null;
}

export function releaseHeavyJobSlot(lock) {
  if (!lock?.path || !lock?.token) return false;
  const owner = readLockOwner(lock.path);
  if (owner?.token !== lock.token) return false;
  try {
    rmSync(lock.path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function processTreeRssMb(rootPid, { ps = spawnSync } = {}) {
  const result = ps('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (result?.status !== 0 || !result?.stdout) return null;
  const rows = String(result.stdout).split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]) } : null;
  }).filter(Boolean);
  const descendants = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const rssKb = rows.reduce((sum, row) => descendants.has(row.pid) ? sum + row.rssKb : sum, 0);
  return rssKb / 1024;
}

async function runProtectedChild(real, argv, { cwd, env, profile, stderr, deps }) {
  const launch = backgroundLaunch(real, argv, {
    platform: deps.platform || process.platform,
    exists: deps.existsSync || existsSync,
  });
  const spawnFn = deps.spawn || spawn;
  const child = spawnFn(launch.bin, launch.args, {
    cwd,
    env,
    stdio: 'inherit',
    detached: (deps.platform || process.platform) !== 'win32',
  });

  return new Promise((resolveCode) => {
    let stoppedReason = null;
    let killTimer = null;
    let finished = false;
    const monitor = setInterval(() => {
      const host = (deps.collectHostMetrics || collectHostMetrics)({ cwd });
      const rss = (deps.processTreeRssMb || processTreeRssMb)(child.pid);
      const verdict = evaluateLocalHeavyJobRuntime(profile, { ...host, processTreeRssMb: rss });
      if (verdict.ok || stoppedReason) return;
      stoppedReason = verdict.reason;
      stderr.write(`mc: stopping local heavy job to protect this computer (${stoppedReason}).\n`);
      signalChild(child, 'SIGTERM', deps.platform || process.platform);
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL', deps.platform || process.platform), TERMINATE_GRACE_MS);
    }, deps.watchIntervalMs || WATCH_INTERVAL_MS);

    const forwardSignal = (signal) => signalChild(child, signal, deps.platform || process.platform);
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearInterval(monitor);
      if (killTimer) clearTimeout(killTimer);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (stoppedReason) return resolveCode(75);
      if (Number.isInteger(code)) return resolveCode(code);
      resolveCode(signal === 'SIGINT' ? 130 : 1);
    };
    child.once('error', (err) => {
      stderr.write(`mc: failed to start protected local job: ${err.message}\n`);
      finish(127, null);
    });
    child.once('close', finish);
  });
}

function backgroundLaunch(real, argv, { platform, exists }) {
  if (platform === 'darwin' && exists('/usr/sbin/taskpolicy')) {
    return { bin: '/usr/sbin/taskpolicy', args: ['-b', '-c', 'utility', real, ...argv] };
  }
  if (platform !== 'win32' && exists('/usr/bin/nice')) {
    return { bin: '/usr/bin/nice', args: ['-n', '10', real, ...argv] };
  }
  return { bin: real, args: argv };
}

function passThrough(real, argv, { cwd, env, stderr, spawnSyncFn }) {
  const result = spawnSyncFn(real, argv, { cwd, env, stdio: 'inherit' });
  if (result.error) {
    stderr.write(`mc: failed to execute real ${basename(real)}: ${result.error.message}\n`);
    return 127;
  }
  if (Number.isInteger(result.status)) return result.status;
  return result.signal === 'SIGINT' ? 130 : 1;
}

function findRealExecutable(command, skipDir, path, exists) {
  for (const dir of path.split(delimiter)) {
    if (!dir || sameDir(dir, skipDir)) continue;
    const candidate = join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function prependPath(dir, existingPath = '') {
  return existingPath ? `${dir}${delimiter}${existingPath}` : dir;
}

function pathWithoutSelfDir(path, skipDir) {
  return path.split(delimiter).filter((dir) => dir && !sameDir(dir, skipDir)).join(delimiter);
}

function sameDir(a, b) {
  try { return resolve(a) === resolve(b); } catch { return a === b; }
}

function readFreeDiskGb(cwd) {
  try {
    const stats = statfsSync(cwd);
    return (Number(stats.bavail) * Number(stats.bsize)) / (1024 ** 3);
  } catch {
    return null;
  }
}

function readSwapUsedMb() {
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
    const match = String(result.stdout || '').match(/used\s*=\s*([\d.]+)([MGT])/i);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = match[2].toUpperCase();
    return value * (unit === 'T' ? 1024 * 1024 : unit === 'G' ? 1024 : 1);
  }
  if (process.platform === 'linux') {
    try {
      const text = readFileSync('/proc/meminfo', 'utf8');
      const total = Number(text.match(/^SwapTotal:\s+(\d+)/m)?.[1]);
      const free = Number(text.match(/^SwapFree:\s+(\d+)/m)?.[1]);
      return Number.isFinite(total) && Number.isFinite(free) ? (total - free) / 1024 : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readLockOwner(path) {
  try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch { return null; }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function signalChild(child, signal, platform) {
  try {
    if (platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already exited */ }
}
