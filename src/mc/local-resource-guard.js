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
  for (const command of GUARDED_PYTHON_COMMANDS) {
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
  if (!GUARDED_PYTHON_COMMANDS.includes(invoked)) {
    stderr.write('mc: local resource guard invoked under an unexpected command name.\n');
    return 127;
  }

  const real = findRealExecutable(invoked, selfDir, env.PATH || '', deps.existsSync || existsSync);
  if (!real) {
    stderr.write(`mc: could not find the real ${invoked} binary after the local resource guard.\n`);
    return 127;
  }

  const childEnv = { ...env, PATH: pathWithoutSelfDir(env.PATH || '', selfDir) };
  if (!isLocalHeavyPythonCommand(argv)) {
    return passThrough(real, argv, { cwd, env: childEnv, stderr, spawnSyncFn: deps.spawnSync || spawnSync });
  }

  const preflight = evaluateLocalHeavyJobPreflight(profile, (deps.collectHostMetrics || collectHostMetrics)({ cwd }));
  if (!preflight.ok) {
    stderr.write(`mc: blocked local heavy job to protect this computer (${preflight.reason}).\n`);
    stderr.write('mc: choose another profile with `mc setup`, or free resources and retry.\n');
    return 75;
  }

  const lock = (deps.acquireHeavyJobSlot || acquireHeavyJobSlot)({
    lockRoot,
    maxConcurrent: profile.maxConcurrent,
    codingSessionId,
  });
  if (!lock) {
    stderr.write(`mc: blocked local heavy job because ${profile.maxConcurrent} protected job${profile.maxConcurrent === 1 ? ' is' : 's are'} already running.\n`);
    return 75;
  }

  stderr.write(`mc: local heavy-job guard active (${profile.profile}: ${profile.maxThreads} threads, ${profile.maxRssMb} MB memory guard).\n`);
  try {
    return await runProtectedChild(real, argv, {
      cwd,
      env: applyThreadLimits(childEnv, profile.maxThreads),
      profile,
      stderr,
      deps,
    });
  } finally {
    (deps.releaseHeavyJobSlot || releaseHeavyJobSlot)(lock);
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
