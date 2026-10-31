/**
 * The runner's awake clock: time that excludes machine suspend and keeps
 * counting across reboots.
 *
 * Measured on this Mac on 2026-10-31 over 47 real sleeps: process.hrtime and
 * os.uptime INCLUDE suspend; CLOCK_UPTIME_RAW (id 8 on Darwin) EXCLUDES it. So the
 * only clock read here is CLOCK_UPTIME_RAW, through perl's Time::HiRes, which
 * needs no native dependency. Nothing falls back to a clock that counts suspend:
 * when the probe fails the clock refuses to exist (there is no degraded mode).
 *
 * A sample is `{ at_ms, awake_ms }`, both integers. session-control.js throws
 * when wall < 0, awake < 0 or awake > wall between two samples, so:
 *   - awake_ms = base_ms + uptime_ms, and base_ms absorbs a reboot (the stored
 *     last awake value becomes the new base), so awake never moves backwards;
 *   - at_ms is Date.now() held at no less than the last at_ms, so a backward
 *     wall-clock step never shows as negative wall time;
 *   - awake_ms is capped at last_awake_ms + (at_ms - last_at_ms): the two clocks
 *     are read at different moments and rounded separately, so an uncapped
 *     short interval could show more awake time than wall time.
 *
 * State lives in `statePath` and is rewritten whole on every sample. Unreadable
 * or malformed state throws; it is never reset silently.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from './atomic-write.js';

const UPTIME_ARGS = ['-MTime::HiRes=clock_gettime', '-e', 'printf q(%.3f), clock_gettime(8)'];

/** Uptime in milliseconds from CLOCK_UPTIME_RAW (suspend excluded). Throws if perl fails or prints no number. */
export function readAwakeMs() {
  const result = spawnSync('/usr/bin/perl', UPTIME_ARGS, { encoding: 'utf8', timeout: 5000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`perl exited ${result.status}: ${String(result.stderr).trim()}`);
  if (!/^\d+(\.\d+)?$/.test(result.stdout)) throw new Error(`perl printed ${JSON.stringify(result.stdout)}`);
  return Number(result.stdout) * 1000;
}

let bootSessionCache = null;

/** The kernel's boot session id, read once per process. A reboot always changes it. */
export function readBootSession() {
  if (bootSessionCache === null) {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 5000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`sysctl exited ${result.status}: ${String(result.stderr).trim()}`);
    const value = result.stdout.trim();
    if (value === '') throw new Error('sysctl printed no boot session');
    bootSessionCache = value;
  }
  return bootSessionCache;
}

/**
 * `{ ok: true }` when the awake clock can be read here, else `{ ok: false, reason }`.
 * Never throws. The deps are injectable so tests never touch perl or sysctl.
 */
export function probeAwakeClock({ platform = process.platform, read = readAwakeMs, bootSession = readBootSession } = {}) {
  if (platform !== 'darwin') {
    return { ok: false, reason: `not Darwin (${platform}): CLOCK_UPTIME_RAW is only known to exclude suspend on Darwin` };
  }
  let uptime;
  try {
    uptime = read();
  } catch (error) {
    return { ok: false, reason: `uptime read failed: ${error.message}` };
  }
  if (!(Number.isFinite(uptime) && uptime > 0)) {
    return { ok: false, reason: `uptime is not a positive finite number: ${String(uptime)}` };
  }
  try {
    const session = bootSession();
    if (typeof session !== 'string' || session === '') return { ok: false, reason: 'boot session is empty' };
  } catch (error) {
    return { ok: false, reason: `boot session read failed: ${error.message}` };
  }
  return { ok: true };
}

/** A stored state as written by this module, or null when there is none. Anything else throws. */
function checkStored(stored, statePath) {
  if (stored === null || stored === undefined) return null;
  const valid = typeof stored === 'object' && !Array.isArray(stored)
    && typeof stored.boot_session === 'string' && stored.boot_session !== ''
    && [stored.base_ms, stored.last_awake_ms, stored.last_at_ms].every((value) => Number.isSafeInteger(value) && value >= 0)
    && stored.last_awake_ms >= stored.base_ms;
  if (!valid) throw new Error(`awake clock state is corrupt: ${statePath}`);
  return stored;
}

function readStoredState(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let stored = null;
  try {
    stored = JSON.parse(text);
  } catch {
    // Reported below: only a missing file means there is no state.
  }
  if (stored === null) throw new Error(`awake clock state is corrupt: ${path}`);
  return stored;
}

/** A finite, non-negative clock reading rounded to whole milliseconds. */
function wholeMs(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`awake clock ${label} is not a non-negative number: ${String(value)}`);
  return Math.round(value);
}

/**
 * Builds `sample()`, which returns `{ at_ms, awake_ms }`. Throws when the probe
 * fails, so a caller never holds a clock that counts suspend. Deps: `read`
 * (uptime ms), `bootSession`, `now` (wall ms), `load` (stored state or null),
 * `save` (state), and `platform` (for the probe). Defaults are the real ones.
 */
export function createAwakeClock({ statePath, ...deps } = {}) {
  if (typeof statePath !== 'string' || statePath === '') throw new Error('awake clock needs a statePath');
  const probe = probeAwakeClock(deps);
  if (!probe.ok) throw new Error(`awake clock unavailable: ${probe.reason}`);
  const read = deps.read ?? readAwakeMs;
  const bootSession = deps.bootSession ?? readBootSession;
  const now = deps.now ?? Date.now;
  const load = deps.load ?? (() => readStoredState(statePath));
  const save = deps.save ?? ((state) => writeJsonAtomic(statePath, state, { mode: 0o600 }));

  return function sample() {
    const stored = checkStored(load(), statePath);
    const uptimeMs = wholeMs(read(), 'uptime');
    const session = bootSession();
    if (typeof session !== 'string' || session === '') throw new Error('awake clock boot session is empty');
    const wallMs = wholeMs(now(), 'wall time');

    const atMs = stored ? Math.max(wallMs, stored.last_at_ms) : wallMs;
    let base = 0;
    if (stored) base = stored.boot_session === session ? stored.base_ms : stored.last_awake_ms;
    const raw = base + uptimeMs;
    let awake = raw;
    if (stored) {
      if (raw < stored.last_awake_ms) {
        throw new Error(`awake clock went backwards within one boot session (${raw} < ${stored.last_awake_ms})`);
      }
      awake = Math.min(raw, stored.last_awake_ms + (atMs - stored.last_at_ms));
    }

    save({ boot_session: session, base_ms: base, last_awake_ms: awake, last_at_ms: atMs });
    return { at_ms: atMs, awake_ms: awake };
  };
}
