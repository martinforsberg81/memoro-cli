/**
 * Orphan heartbeat-loop daemon detection (§9j).
 *
 * The Claude Code / Codex hook spawns `memoro-cli heartbeat-loop` as a
 * detached child and writes `~/.memoro/heartbeat-<llmSessionId>.pid`.
 * When the parent tool dies without the daemon noticing, the daemon
 * keeps ticking forever — eating API quota at ~1 req/min and producing
 * the WebSocket ping-pong observed on 2026-05-26.
 *
 * Orphan criterion (canonical Unix definition): the daemon's parent
 * process has died and the kernel has reparented it to PID 1
 * (launchd / init). A heartbeat-loop whose ppid is 1 is by definition
 * outliving its owner.
 *
 * Output buckets:
 *   - `stale`  — pidfile points at a dead PID. Safe to `unlink` the
 *                pidfile; no signal needed.
 *   - `orphan` — pidfile alive, ppid == 1 (or any reaper sentinel),
 *                pidfile mtime older than `minAgeMs`. Eligible for
 *                SIGTERM by callers.
 *   - `live`   — pidfile alive with a real ancestor; left alone.
 *
 * Pure helper: all syscalls (alive check, ppid lookup, fs reads) are
 * injectable so tests can drive every branch with no real processes.
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_MIN_AGE_MS = 5 * 60 * 1000;

/**
 * Default pid dir is `${HOME}/.memoro` to match `pidFilePath()` in
 * heartbeat-loop.js. Override via `MC_ORPHAN_PID_DIR` for tests and
 * isolated environments.
 */
export function defaultPidDir() {
  return process.env.MC_ORPHAN_PID_DIR || join(homedir(), '.memoro');
}

// Backwards-compat for any caller that imported the constant.
export const DEFAULT_PID_DIR = join(homedir(), '.memoro');
const PID_FILE_RE = /^heartbeat-(.+)\.pid$/;
/**
 * PIDs treated as "process has no living parent". 1 is launchd / init
 * everywhere we care about (macOS, Linux). On macOS launchd may also
 * delegate to a sub-reaper; if a daemon's reported ppid is below 100
 * and isn't its own original parent that's a strong orphan signal too,
 * but we keep the default tight to avoid false positives.
 */
const REPARENT_PIDS = new Set([1]);

export function defaultListPidFiles(pidDir = defaultPidDir()) {
  if (!existsSync(pidDir)) return [];
  try {
    return readdirSync(pidDir)
      .filter((name) => PID_FILE_RE.test(name))
      .map((name) => join(pidDir, name));
  } catch {
    return [];
  }
}

export function parseLlmSessionId(pidFile) {
  const m = PID_FILE_RE.exec(pidFile.split('/').pop() || '');
  return m ? m[1] : null;
}

export function defaultReadPidFile(pidFile) {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const mtimeMs = statSync(pidFile).mtimeMs;
    return { pid, mtimeMs };
  } catch {
    return null;
  }
}

export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we don't own it — still alive.
    return err && err.code === 'EPERM';
  }
}

/**
 * Look up a pid's parent pid via `ps -o ppid= -p <pid>`. Available on
 * macOS + Linux; returns null when ps is missing or the pid is gone.
 */
export function defaultGetPpid(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  if (!out) return null;
  const n = Number(out.split(/\s+/)[0]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Scan the pidfile directory and categorise each daemon. Pure given its
 * dependencies; tests inject `listPidFiles`, `readPidFile`, `isAlive`,
 * `getPpid` and `now`.
 */
export function scanDaemons({
  pidDir = defaultPidDir(),
  listPidFiles = defaultListPidFiles,
  readPidFile = defaultReadPidFile,
  isAlive = defaultIsAlive,
  getPpid = defaultGetPpid,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  now = Date.now(),
} = {}) {
  const stale = [];
  const orphan = [];
  const live = [];

  for (const pidFile of listPidFiles(pidDir)) {
    const llmSessionId = parseLlmSessionId(pidFile);
    const info = readPidFile(pidFile);
    if (!info) {
      // Unreadable pidfile: still "stale" — caller will unlink.
      stale.push({ pidFile, llmSessionId, pid: null, reason: 'unreadable' });
      continue;
    }
    if (!isAlive(info.pid)) {
      stale.push({ pidFile, llmSessionId, pid: info.pid, reason: 'dead-pid' });
      continue;
    }

    const ageMs = Math.max(0, now - info.mtimeMs);
    const ppid = getPpid(info.pid);
    const reparented = ppid != null && REPARENT_PIDS.has(ppid);

    if (reparented && ageMs >= minAgeMs) {
      orphan.push({ pidFile, llmSessionId, pid: info.pid, ppid, ageMs });
    } else {
      live.push({ pidFile, llmSessionId, pid: info.pid, ppid, ageMs });
    }
  }

  return { stale, orphan, live };
}

/**
 * SIGTERM the given orphan entries and return per-entry outcomes.
 * Stale pidfiles are unlinked (no signal). Live entries are skipped.
 * `kill` and `unlink` are injectable for tests.
 */
export function reapOrphans(
  scan,
  {
    kill = (pid) => { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } },
    unlinkFile = (file) => {
      try { unlinkSync(file); return true; } catch { return false; }
    },
  } = {},
) {
  const reaped = [];
  const unlinked = [];
  for (const e of scan.orphan) {
    const ok = kill(e.pid);
    reaped.push({ pidFile: e.pidFile, pid: e.pid, llmSessionId: e.llmSessionId, signaled: ok });
  }
  for (const e of scan.stale) {
    const ok = unlinkFile(e.pidFile);
    unlinked.push({ pidFile: e.pidFile, llmSessionId: e.llmSessionId, removed: ok });
  }
  return { reaped, unlinked };
}
