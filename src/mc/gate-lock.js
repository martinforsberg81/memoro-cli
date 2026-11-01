/**
 * One gate round at a time on this machine.
 *
 * A full suite takes a minute and a half and pins the cores. Two of them at
 * once make both slower and both flakier, and the flakiness lands on whichever
 * pull request happened to be measured — which is the 55 → 57 → 55 the red
 * floor was invented to absorb. So one round runs, and the second is told to
 * wait.
 *
 * The lane is the repository (Martin, 2026-11-01: *"det ska finnas en merge-lane
 * för respektive repo så de inte körs samtidigt"*): two rounds of one repository
 * exclude each other and two repositories run side by side. There are no
 * classes of lane, because a class is a claim about a suite's cost, and the
 * one memoro-cli carried had gone unmeasured from 60 s to seventeen minutes.
 * A session's `mc gate` takes no lane at all (session-gate-run.js).
 *
 * Each lane uses an atomic directory claim owned by a live process, plus a
 * JSON status file for existing readers. Concurrent claimants cannot both
 * acquire it. A dead process's claim can be reclaimed; reservation errors
 * refuse the run. There is no expiry that could mistake a slow run for a
 * dead one.
 *
 * Code merges, documents' tests, the nightly run, a deploy and an iOS build
 * reserve a lane. A deploy and an iOS build reserve memoro's (`BUILD_LANE`).
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';
import { readClaim, releaseClaim, takeClaim } from './resource-claim.js';

/** The lane a deploy and an iOS build hold: they build memoro, and go between its rounds. */
export const BUILD_LANE = 'memoro';

const LOCK_NAME = /^gate-running-(.+)\.json$/u;

export function gateLockPath(root = mcHome(), lane) {
  if (!lane || /[/\\\0]/u.test(lane)) throw new Error(`a gate lane is a repository's name, not ${JSON.stringify(lane)}`);
  return join(root, `gate-running-${lane}.json`);
}

/** The round running right now in this lane, or null. A file that will not parse is nobody. */
export function runningRound({ root = mcHome(), alive = isAlive, lane } = {}) {
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

/** The round in each repository's lane, by name, for a reader that means any round. */
export function runningRounds({ root = mcHome(), alive = isAlive } = {}) {
  let names = [];
  try { names = readdirSync(root); } catch { /* no home, no rounds */ }
  const lanes = new Set(names.map((name) => LOCK_NAME.exec(name.replace(/\.claim$/u, ''))?.[1]).filter(Boolean));
  return Object.fromEntries([...lanes].map((lane) => [lane, runningRound({ root, alive, lane })]));
}

/**
 * Take it, or say who has it.
 *
 * `{ ok: true, took: true }` when this process now holds it. `{ ok: false,
 * running }` when somebody else does — `running` is what to tell the operator,
 * and it is the other round's own words rather than a guess.
 *
 * `pid` is the holder, this process unless said otherwise: a docs gate
 * hands in the worker that owns the lane while its tests run, and the lock is
 * litter once that worker is gone.
 */
export function takeGateLock({
  repo, pr, mode = null, root = mcHome(), alive = isAlive, now = new Date(), lane, pid = process.pid,
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
export function releaseGateLock({ root = mcHome(), lane, pid = process.pid } = {}) {
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
export function noteGatePhase({ root = mcHome(), message, now = new Date(), lane } = {}) {
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
    + `${running.since ? `, since ${running.since}` : ''}) — one at a time in each repository's lane`;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
