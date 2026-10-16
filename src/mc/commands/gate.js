/**
 * `mc gate` — run this worktree's own gate, and read only the verdict.
 *
 *   mc gate                   the repository's gate on the tree you stand in
 *   mc gate --base <ref>      measured against another base than origin/main
 *   mc gate --json            the summary as one object
 *   mc gate --budget <s>      answer after at most s seconds (default 540); the gate keeps running
 *   mc gate --wait            wait for the gate running here and print its verdict
 *
 * What runs is the repository's, read from its `package.json` (`gate-local.js`):
 * `npm run ci -- --base-ref origin/main` where there is a `ci` script, else
 * `npm test`. The gate is a detached child whose output goes to a file — under
 * `$MC_SCRATCH` in a runner session, the system temp directory otherwise — as
 * it is written, so the log is readable while the gate runs; when it ends it
 * writes its exit code beside the log. This verb answers within the budget:
 * GREEN or RED, the counts, the failing lines with their locations, and the
 * file's path, at most 2 KB. Past the budget it answers `RUNNING` and exits 3;
 * the gate runs on, and `mc gate --wait` (or a later call) prints the verdict
 * from the same log.
 *
 * One gate per worktree: a lock beside the git directory names the running
 * gate's pid and log, and a second `mc gate` there refuses while that pid lives.
 *
 * It is a meter, not a door: `mc merge` measures again in its own tree and
 * decides. This one answers "is my tree red?" before the push.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gateCommand, gateLines, summarizeGate } from '../gate-local.js';
import { tryGit } from '../git.js';
import { scanArgs } from './flags.js';

/** How long the answer waits for the gate, in seconds, unless `--budget` says otherwise. */
const DEFAULT_BUDGET = 540;
/** How often the answer looks for the gate's exit code. */
const POLL_MS = 2000;

/** The machine the verb runs on; a test hands in its own. */
const SYSTEM = {
  git: tryGit,
  read: readFileSync,
  write: writeFileSync,
  exists: existsSync,
  remove: (path) => rmSync(path, { force: true }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  open: (path) => openSync(path, 'a'),
  close: closeSync,
  spawn,
  alive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const io = { ...SYSTEM, ...deps };
  const scanned = scanArgs(argv, { booleans: ['--json', '--wait'], strictValues: ['--base', '--budget'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  if (scanned.positional.length) { stderr.write(`mc: mc gate takes no positional (${scanned.positional.join(' ')})\n${usage()}`); return 2; }
  const budget = scanned.flags.budget == null ? DEFAULT_BUDGET : Number(scanned.flags.budget);
  if (!(budget > 0)) { stderr.write(`mc: --budget takes seconds, a positive number (${scanned.flags.budget})\n${usage()}`); return 2; }

  const root = io.git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) { stderr.write('mc: not inside a git worktree — mc gate runs the gate of the tree you stand in\n'); return 2; }
  const gitDir = io.git(root, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) { stderr.write(`mc: cannot find the git directory of ${root}\n`); return 2; }
  const lockPath = join(gitDir, 'mc-gate.json');

  if (scanned.flags.wait) {
    const lock = readLock(io, lockPath);
    if (!lock) { stderr.write('mc: no gate running here — mc gate starts one\n'); return 2; }
    return answer(io, { lock, lockPath, budget, waitedFrom: io.now(), json: scanned.flags.json, stdout });
  }

  let manifest = null;
  try { manifest = JSON.parse(io.read(join(root, 'package.json'), 'utf8')); } catch { manifest = null; }
  const base = scanned.flags.base || 'origin/main';
  const command = gateCommand(manifest, { base });
  if (!command) { stderr.write(`mc: ${root} has no ci or test script in package.json — nothing to run\n`); return 2; }

  const held = readLock(io, lockPath);
  if (held && isRunning(io, held)) {
    stderr.write(`mc: a gate is already running here (pid ${held.pid}, since ${held.started}) — mc gate --wait\n`);
    return 2;
  }

  const startedAt = io.now();
  const stamp = startedAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const dir = env.MC_SCRATCH || join(tmpdir(), 'mc-gate');
  const logPath = join(dir, `gate-${stamp}.log`);
  let child;
  try {
    io.mkdir(dir);
    const fd = io.open(logPath);
    child = io.spawn('sh', ['-c', `${command.run}; echo $? > '${logPath}.exit'`], {
      cwd: root, env: { ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, detached: true, stdio: ['ignore', fd, fd],
    });
    io.close(fd);
  } catch (error) {
    stderr.write(`mc: could not start the gate, log ${logPath}: ${error.message}\n`);
    return 2;
  }
  child.unref();
  io.write(`${logPath}.pid`, `${child.pid}\n`);
  const lock = { pid: child.pid, log: logPath, started: startedAt.toISOString(), command: { ...command, base } };
  io.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return answer(io, { lock, lockPath, budget, waitedFrom: startedAt, json: scanned.flags.json, stdout });
}

/**
 * Waits for the gate to end or the budget to run out, then answers: the
 * verdict (and the lock goes), a red for a process that ended without an exit
 * code (and the lock goes), or RUNNING with exit 3 (and the lock stays).
 */
async function answer(io, { lock, lockPath, budget, waitedFrom, json, stdout }) {
  const outcome = await waitForExit(io, { log: lock.log, pid: lock.pid, since: waitedFrom, budget });
  const seconds = Math.round((io.now().getTime() - Date.parse(lock.started)) / 1000);
  if (outcome.budget) {
    stdout.write(`RUNNING — ${lock.command.run} — ${seconds}s so far, still running (pid ${lock.pid})\nlog: ${lock.log} — mc gate --wait waits for it and prints the verdict\n`);
    return 3;
  }
  io.remove(lockPath);
  if (outcome.dead) {
    stdout.write(`RED — the gate's process ended without an exit code — log: ${lock.log}\n`);
    return 1;
  }
  const summary = summarizeGate(readText(io, lock.log), { exitCode: outcome.code });
  if (json) {
    stdout.write(`${JSON.stringify({ ...summary, command: lock.command.run, script: lock.command.script, base: lock.command.base, seconds, log: lock.log, exit: outcome.code }, null, 2)}\n`);
  } else {
    stdout.write(`${gateLines(summary, { command: lock.command.run, seconds, logPath: lock.log })}\n`);
  }
  return summary.ok ? 0 : 1;
}

/** Polls for the exit code until it is written, the process is gone, or the budget is spent. */
async function waitForExit(io, { log, pid, since, budget }) {
  for (;;) {
    const code = exitCodeOf(io, log);
    if (code !== null) return { code };
    if (!io.alive(pid)) {
      // The process may have written its code just before it ended.
      const late = exitCodeOf(io, log);
      return late === null ? { dead: true } : { code: late };
    }
    const left = budget * 1000 - (io.now().getTime() - since.getTime());
    if (left <= 0) return { budget: true };
    await io.sleep(Math.min(POLL_MS, left));
  }
}

/** The gate's exit code, once its exit file has been written; null while it has not. */
function exitCodeOf(io, log) {
  const text = readText(io, `${log}.exit`).trim();
  return /^\d+$/u.test(text) ? Number(text) : null;
}

/** A lock whose pid lives and whose gate has not written its exit code. */
function isRunning(io, lock) {
  return io.alive(lock.pid) && !io.exists(`${lock.log}.exit`);
}

function readLock(io, lockPath) {
  if (!io.exists(lockPath)) return null;
  try { return JSON.parse(io.read(lockPath, 'utf8')); } catch { return null; }
}

function readText(io, path) {
  try { return io.read(path, 'utf8'); } catch { return ''; }
}

export function usage() {
  return [
    'usage — mc gate                       this worktree\'s own gate: npm run ci -- --base-ref origin/main, or npm test\n',
    '        mc gate --base <ref>          measured against another base\n',
    '        mc gate --json                the summary as one object\n',
    '        mc gate --budget <s>          answer after at most s seconds, default 540; the gate keeps running\n',
    '        mc gate --wait                wait for the gate running here and print its verdict\n',
    '\n',
    'Prints at most 2 KB — GREEN/RED, counts, the failing lines and their locations, and the path of the whole output.\n',
    'Exit 0 green, 1 red, 2 nothing to run or already running, 3 still running.\n',
  ].join('');
}
