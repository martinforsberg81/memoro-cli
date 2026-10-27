/**
 * One gate round at a time on this machine.
 *
 * A full suite takes a minute and a half and pins the cores. Two of them at
 * once make both slower and both flakier, and the flakiness lands on whichever
 * pull request happened to be measured — which is the 55 → 57 → 55 the red
 * floor was invented to absorb. So one round runs, and the second is told to
 * wait.
 *
 * Each lane uses an atomic directory claim owned by a live process, plus a
 * JSON status file for existing readers. Concurrent claimants cannot both
 * acquire it. A dead process's claim can be reclaimed; reservation errors
 * refuse the run. There is no expiry that could mistake a slow run for a
 * dead one.
 *
 * Code merges, documents' tests and local gates all reserve their declared
 * lane. Heavy and light rounds may run side by side, but two rounds in the
 * same lane exclude each other. The status files keep their previous names;
 * old workers should finish before an update starts new ones.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';
import { readClaim, releaseClaim, takeClaim } from './resource-claim.js';

/**
 * The lanes a gate round runs in, one round at a time in each. They exist
 * because a light round does not pin the cores the way memoro's seven-lane
 * suite does, and that pinning was the whole reason for one-at-a-time (see
 * above). `heavy` is memoro and any repository that declares nothing;
 * `light` is a repository whose declaration says `gate_lane: 'light'`.
 */
export const GATE_LANES = Object.freeze(['heavy', 'light']);

export function gateLockPath(root = mcHome(), lane = 'heavy') {
  return join(root, lane === 'light' ? 'gate-running-light.json' : 'gate-running.json');
}

/** The round running right now in this lane, or null. A file that will not parse is nobody. */
export function runningRound({ root = mcHome(), alive = isAlive, lane = 'heavy' } = {}) {
  const claim = readClaim(`${gateLockPath(root, lane)}.claim`);
  let raw = null;
  try { raw = JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8')); } catch { /* a claim may precede its status file */ }
  if (claim && alive(claim.pid)) raw = raw?.pid === claim.pid ? raw : claim;
  if (!Number.isFinite(raw?.pid)) return null;
  // A round that was killed left this behind. It is not a holder; it is
  // litter, and saying so is the whole of the reaping this needs.
  if (!alive(raw.pid)) return null;
  return { ...raw, lane };
}

/** The round in each lane, `{ heavy, light }`, for a reader that means any round. */
export function runningRounds({ root = mcHome(), alive = isAlive } = {}) {
  return Object.fromEntries(GATE_LANES.map((lane) => [lane, runningRound({ root, alive, lane })]));
}

/**
 * Take it, or say who has it.
 *
 * `{ ok: true, took: true }` when this process now holds it. `{ ok: false,
 * running }` when somebody else does — `running` is what to tell the operator,
 * and it is the other round's own words rather than a guess.
 *
 * `pid` is the holder, this process unless said otherwise: a session's `mc
 * gate` worker owns the lane while its tests run, and the lock is litter
 * once that worker is gone.
 */
export function takeGateLock({
  repo, pr, mode = null, root = mcHome(), alive = isAlive, now = new Date(), lane = 'heavy', pid = process.pid,
} = {}) {
  const mine = {
    pid, repo: repo || null, pr: pr ?? null, mode: mode || null, since: now.toISOString(),
  };
  const path = `${gateLockPath(root, lane)}.claim`;
  const claim = takeClaim(path, mine, { alive });
  if (!claim.ok) return { ...claim, ...(claim.running ? { running: { ...claim.running, lane } } : {}) };
  try {
    // Respect a round started by the previous mc version during an update.
    let legacy = null;
    try { legacy = JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8')); } catch { /* absent */ }
    if (Number.isInteger(legacy?.pid) && alive(legacy.pid)) {
      releaseClaim(path, claim.marker);
      return { ok: false, running: { ...legacy, lane } };
    }
    writeJsonAtomic(gateLockPath(root, lane), mine, { mode: 0o600 });
  } catch (error) {
    releaseClaim(path, claim.marker);
    return { ok: false, error: `cannot write gate reservation: ${error.message}` };
  }
  return { ok: true, took: true, mine };
}

/**
 * Give it back — but only if it is still ours.
 *
 * A round whose pid was reaped may have had the lock taken over while it was
 * dying. Deleting the file blindly would then release somebody else's round,
 * which is the one way a lock this simple could do real damage.
 */
export function releaseGateLock({ root = mcHome(), lane = 'heavy', pid = process.pid } = {}) {
  const path = `${gateLockPath(root, lane)}.claim`;
  const claim = readClaim(path);
  if (claim && claim.pid !== pid) return false;
  try {
    const raw = JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8'));
    if (raw?.pid !== pid) return false;
    rmSync(gateLockPath(root, lane), { force: true });
    return true;
  } catch { return Boolean(claim?.pid === pid); }
  finally { if (claim?.pid === pid) releaseClaim(path, claim.marker); }
}

/**
 * What the round's own narration last said, kept beside the pid that is
 * saying it.
 *
 * The same guard `releaseGateLock` uses, for the same reason: a round whose
 * pid was reaped may have had the lock taken over while it was dying, and a
 * phase written after that would be one round's words in another's file. A
 * write that throws returns false — the phase is a courtesy, like
 * `onProgress`, and a round must not stop because a status line could not be
 * saved.
 *
 * Thrown away rather than kept: a round narrates every line it runs (`say` in
 * `repo-gate.js` and `repo-merge.js`), tens of them a round, so a phase
 * within the last second of the one already on disk is not written again —
 * one write a second is plenty for a page nobody refreshes faster than that.
 */
export function noteGatePhase({ root = mcHome(), message, now = new Date(), lane = 'heavy' } = {}) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8')); } catch { return false; }
  if (raw?.pid !== process.pid) return false;
  if (raw.phase_at) {
    const last = Date.parse(raw.phase_at);
    if (Number.isFinite(last) && now.getTime() - last < 1000) return true;
  }
  try {
    writeJsonAtomic(gateLockPath(root, lane), {
      ...raw,
      phase: String(message).slice(0, 200),
      phase_at: now.toISOString(),
    }, { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** How a refusal reads to the operator: whose round, in which lane, on what, since when. */
export function describeRunning(running, lane = running?.lane) {
  const where = lane ? ` in the ${lane} lane` : '';
  if (!running) return `another gate round is running on this machine${where}`;
  const what = [running.repo, running.pr == null ? null : `#${running.pr}`].filter(Boolean).join(' ');
  return `another gate round is running on this machine${where} (pid ${running.pid}${what ? `, ${what}` : ''}`
    + `${running.since ? `, since ${running.since}` : ''}) — one at a time in each lane`;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
