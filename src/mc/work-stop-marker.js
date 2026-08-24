/**
 * The mark `mc work stop` leaves behind: stopped on purpose, by whom, when.
 *
 * The guard's `dead` — alive last round, gone this round, last turn never
 * finished — is arithmetic, and it is right. It is also exactly what a
 * session looks like after PM has stopped it on purpose, and the guard
 * knocked PM three times in one night about sessions PM had just stopped
 * (KP-09, 2026-08-24: `grindvarv-review`, `mc-repo`, `msr-track-2`). The
 * flag was not wrong; it was indistinguishable. A guard whose alarm one
 * learns to ignore is a guard that is not there.
 *
 * So the stop says so, in the area it stopped: one small file, `.mc-stopped`,
 * beside `.mc-role` — who asked and when. The guard reads it and says
 * `stopped by pm 03:16` instead of `dead`; the board shows the same line
 * under the area. Opening the area again (`mc work <name>`, in the terminal
 * or in the background) removes it, so the next disappearance is judged on
 * its own.
 *
 * The mark is only trusted for a stop that fits: at or after the moment the
 * conversation last moved, less a minute for the tool's own exit hooks —
 * `/exit` writes a last line after the stop was asked. A mark older than the
 * conversation's last movement is a stop before a restart mc did not see,
 * and a later death is a death.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STOP_MARK = '.mc-stopped';

/** The exit hooks' grace: a last transcript line written after the stop. */
export const STOP_GRACE_MS = 60_000;

export function stopMarkPath(areaPath) {
  return join(areaPath, STOP_MARK);
}

export function markStopped(areaPath, { by, now = new Date() } = {}) {
  const record = { at: now.toISOString(), by: by || 'someone' };
  writeFileSync(stopMarkPath(areaPath), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

export function readStopMark(areaPath) {
  try {
    const record = JSON.parse(readFileSync(stopMarkPath(areaPath), 'utf8'));
    if (!record || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return null;
    return { at: record.at, by: typeof record.by === 'string' && record.by ? record.by : 'someone' };
  } catch { return null; }
}

export function clearStopMark(areaPath) {
  try { rmSync(stopMarkPath(areaPath), { force: true }); } catch { /* absent, or not ours to remove */ }
}

/**
 * Does this mark account for a conversation that has stopped moving?
 *
 * `updatedMs` is when the conversation's transcript last moved. A stop asked
 * at or after that — less the exit hooks' grace — is the stop that ended it.
 */
export function explainsStop(mark, updatedMs, { graceMs = STOP_GRACE_MS } = {}) {
  if (!mark) return false;
  const at = Date.parse(mark.at);
  if (!Number.isFinite(at)) return false;
  return at >= (updatedMs || 0) - graceMs;
}
