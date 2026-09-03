/**
 * The full run nobody asks for — the process, and its two buttons.
 *
 * `mc test <repo> --full` is the reading that is about the code rather than
 * about a change, and until now it happened when a person typed it. That is
 * the direct cause of memoro's #10529: four days of merges left 31 tests red
 * on `main` while every pull request's affected-selection passed, because
 * nothing ever looked at the whole. A reading that costs five minutes once a
 * day is not the expensive thing there; not having it is.
 *
 * So this is a second meter beside `repo-watch.js`, and deliberately not a
 * second loop inside it. The watcher's round is seconds and its cadence is a
 * minute; a full round is 300 s for memoro alone, and squeezing one into a
 * 60 s cadence is how a machine ends up running two at once. What is copied
 * is the *shape*: a detached node process, a pid file checked against the
 * process table and against the runner's own command line, a log capped at a
 * megabyte, everything written atomically and everything under mc's home.
 *
 * It is a meter, like the watcher: it never commits, never pushes, never
 * writes inside a repository, and never takes a branch. And it is entirely
 * optional — nothing in mc requires it to be running, and nothing it finds
 * refuses a merge or delays a round.
 *
 * "Nightly" is the trade's word for once a day, not a promise about the hour:
 * see `nightly-loop.js` for why the cadence is measured from the last
 * completed run rather than from a clock.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';

export const NIGHTLY_SCHEMA = 'mc-nightly';
export const NIGHTLY_VERSION = 1;

/**
 * Once a day.
 *
 * The cadence is Martin's day rather than a cron expression: one full reading
 * of every repository mc knows, which is about 400 s of this machine on the
 * two it knows today. The number is here beside the process that uses it, the
 * way `DEFAULT_INTERVAL_MS` sits beside the watcher's, and `--interval` on
 * `mc repo nightly start` is the same flag with the same unit as the
 * watcher's — one grammar, no second configuration surface.
 */
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const RUNNER = fileURLToPath(new URL('./nightly-run.js', import.meta.url));

/** A log this size has said everything useful twice. */
const LOG_LIMIT_BYTES = 1024 * 1024;

/**
 * How long a stop waits before insisting.
 *
 * Short on purpose, and it is not the watcher's reason. The watcher lets its
 * round finish because a round is a second and cutting one in half would tear
 * a snapshot; a full round is minutes, and nobody who typed `stop` means "in
 * five minutes". A round in flight ends the way any killed gate round ends —
 * `repo-gate.js` catches the signal itself and gives back the lease and the
 * round lock before it goes.
 */
const STOP_GRACE_MS = 3000;

export function nightlyRoot(root = mcHome()) {
  return join(root, 'nightly');
}

export function nightlyStatePath(root = mcHome()) {
  return join(nightlyRoot(root), 'nightly.json');
}

export function nightlyLogPath(root = mcHome()) {
  return join(nightlyRoot(root), 'nightly.log');
}

/**
 * Is it running, and on what cadence?
 *
 * The pid is checked against the process table rather than trusted — a pid
 * file outlives the machine's last reboot — and the command line has to be
 * this runner, because pids are reused. That second half is the part that is
 * easy to get wrong and the part that matters most here: a stale pid file
 * that happens to name a live unrelated process would report a scheduler that
 * is running when none is, and the whole value of this thing is that somebody
 * can believe the answer without checking.
 */
export function nightlyState({ root = mcHome() } = {}) {
  const record = readJson(nightlyStatePath(root));
  const pid = Number(record?.pid);
  const running = Number.isInteger(pid) && pid > 0 && alive(pid) && isRunner(pid);
  return {
    running,
    pid: running ? pid : null,
    started_at: running ? record?.started_at || null : null,
    interval_ms: Number(record?.interval_ms) || DEFAULT_INTERVAL_MS,
    // A pid file whose process is gone is the ordinary aftermath of a reboot
    // or a kill -9, and worth saying out loud: it is the difference between
    // "never started" and "stopped without telling anyone".
    abandoned: Boolean(record) && !running,
    log: nightlyLogPath(root),
  };
}

export function startNightly({ intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(), env = process.env } = {}) {
  const state = nightlyState({ root });
  if (state.running) return { ok: false, reason: 'already-running', pid: state.pid, interval_ms: state.interval_ms };

  mkdirSync(nightlyRoot(root), { recursive: true, mode: 0o700 });
  const log = nightlyLogPath(root);
  rotate(log);
  // The log is the child's own stdout and stderr, so a round that throws
  // leaves its stack there rather than nowhere — and so does everything the
  // gate round narrates on its way past.
  const fd = openSync(log, 'a', 0o600);
  let child = null;
  try {
    child = spawn(process.execPath, [RUNNER, '--interval-ms', String(intervalMs)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env },
    });
    child.unref();
  } catch (error) {
    closeSync(fd);
    return { ok: false, reason: error?.message || String(error) };
  }
  closeSync(fd);

  writeJsonAtomic(nightlyStatePath(root), {
    schema: NIGHTLY_SCHEMA,
    version: NIGHTLY_VERSION,
    pid: child.pid,
    started_at: new Date().toISOString(),
    interval_ms: intervalMs,
    runner: RUNNER,
  }, { mode: 0o600 });
  return { ok: true, pid: child.pid, interval_ms: intervalMs, log };
}

/**
 * Stop it, and leave nothing behind.
 *
 * The pid file goes whatever happened — including after a SIGKILL, which runs
 * nothing in the child. A scheduler that is asked to stop and leaves a file
 * saying it is running is the one failure this cannot have: the next reader
 * would believe a nightly is happening when none is, which is exactly the
 * false green the whole project exists to remove, arriving by a third road.
 *
 * ## Why the signal goes to the group and not to the pid
 *
 * The tick spends most of its life inside somebody else's suite: `npm run
 * test:full`, which is a shell, which is npm, which is `node --test`, which is
 * seven worker processes. Signalling only the scheduler kills the scheduler —
 * and on POSIX the workers are reparented to init and keep running. Measured
 * 2026-09-03: `mc test memoro-cli --full` killed 8 s into its suite left two
 * `node --test-concurrency=0` workers at `ppid 1`, still burning cores after
 * the round that started them was gone.
 *
 * That is the pre-existing behaviour of any killed gate round, and it is
 * survivable when a person killed it and can see what is left. It is not
 * survivable in a process that runs unattended every night. Because the
 * scheduler is spawned detached it is its own process-group leader, so its
 * whole descent — and nothing else — is reachable as `-pid`, which is exactly
 * "what the scheduler started".
 */
export async function stopNightly({ root = mcHome() } = {}) {
  const state = nightlyState({ root });
  if (!state.running) {
    if (state.abandoned) rmSync(nightlyStatePath(root), { force: true });
    return { ok: true, stopped: false, abandoned: state.abandoned };
  }
  const { pid } = state;
  // The group first, so the suite in flight goes with it; the pid alone as a
  // fallback, in case this pid is somehow not a group leader — a stop that
  // signalled nothing would be worse than one that left a worker behind.
  signal(pid, 'SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  let forced = false;
  if (alive(pid)) {
    forced = true;
    signal(pid, 'SIGKILL');
  }
  rmSync(nightlyStatePath(root), { force: true });
  return { ok: true, stopped: true, pid, forced };
}

function signal(pid, what) {
  try { process.kill(-pid, what); return; } catch { /* not a group leader */ }
  try { process.kill(pid, what); } catch { /* it went on its own */ }
}

function rotate(log) {
  try {
    if (statSync(log).size > LOG_LIMIT_BYTES) truncateSync(log, 0);
  } catch { /* no log yet */ }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function isRunner(pid) {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return command.includes('nightly-run');
  } catch { return false; }
}
