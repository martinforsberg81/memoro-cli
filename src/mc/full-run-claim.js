/**
 * Who is measuring a repository's main right now: one record per full run in
 * flight, so that a second starter of the same measurement follows the first
 * instead of starting another.
 *
 * Three doors start a full run — `mc deploy` (its preparation), `mc test
 * <repo> --full`, and the runner's daily run — and a full run is a suite's
 * worth of cores for tens of minutes. Two of them on one `main` measured the
 * same tree twice (2026-11-14: a deploy's run and a hand-typed `--full` were
 * the same suite twice, and the second was lost to the merger's lease).
 * Every starter now claims here first, under a lock of the history's own root, held
 * for milliseconds; a starter that finds a live claim it overlaps waits
 * for it and reads its answer from the history the run writes.
 *
 * A claim is `{ repo, sha, pid, started, verb }`. `sha` is the commit the
 * starter expects to measure, or null when it does not know (a hand-typed
 * `--full` measures what the fetch finds). Two claims overlap when the repo is
 * the same and the shas are equal or either is unknown; a known, different sha
 * is another tree and is measured on its own. A claim whose pid is gone is a
 * run that died, and is no claim: it is dropped at the next write and ignored
 * at every read. The file lives with the history it points to, in mc's home.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { processAlive } from './lease-owner.js';
import { mcHome } from './paths.js';
import { realLock } from './runner-lock.js';

export const CLAIMS_SCHEMA = 'mc-full-run-claims';

/** How often a follower looks again at the run it waits for. */
export const CLAIM_POLL_MS = 5000;

export function claimsPath(root = mcHome()) {
  return join(root, 'full-runs.json');
}

function readAll(root) {
  try {
    const raw = JSON.parse(readFileSync(claimsPath(root), 'utf8'));
    return raw?.schema === CLAIMS_SCHEMA && Array.isArray(raw.claims) ? raw.claims.filter((claim) => claim && claim.pid) : [];
  } catch {
    return [];
  }
}

/** The full runs in flight: claims whose process is alive. */
export function liveClaims({ root = mcHome(), alive = processAlive } = {}) {
  return readAll(root).filter((claim) => alive(claim.pid));
}

/** Whether a run claimed as `claim` is the measurement a starter of `repo` at `sha` wants. */
export function overlaps(claim, { repo, sha = null }) {
  if (claim.repo !== repo) return false;
  return !sha || !claim.sha || claim.sha === sha;
}

/**
 * Claim a full run, or find the one already in flight that measures the same
 * thing. `{ claimed: true, claim }` when this process now holds the claim,
 * `{ claimed: false, joined }` when a live claim overlaps it and nothing was
 * written. Decided under a lock so two starters cannot both find
 * the repository free.
 */
export function claimFullRun({
  repo, sha = null, verb = 'full run', root = mcHome(), alive = processAlive,
  lock = realLock, pid = process.pid, now = () => new Date(),
}) {
  return lock(root, () => {
    const live = readAll(root).filter((claim) => alive(claim.pid));
    const joined = live.find((claim) => overlaps(claim, { repo, sha }));
    if (joined) return { claimed: false, joined };
    const claim = { repo, sha: sha || null, pid, started: now().toISOString(), verb };
    try { writeJsonAtomic(claimsPath(root), { schema: CLAIMS_SCHEMA, claims: [...live, claim] }, { mode: 0o600 }); } catch { /* a claim that cannot be written leaves the run unclaimed, not unrun */ }
    return { claimed: true, claim };
  }, { name: 'full-run-claim' });
}

/** Give the claim back — the run has ended, whatever it found. */
export function releaseClaim(claim, { root = mcHome(), lock = realLock, alive = processAlive } = {}) {
  if (!claim) return;
  lock(root, () => {
    const rest = readAll(root).filter((other) => other.pid !== claim.pid || other.started !== claim.started)
      .filter((other) => alive(other.pid));
    try { writeJsonAtomic(claimsPath(root), { schema: CLAIMS_SCHEMA, claims: rest }, { mode: 0o600 }); } catch { /* the pid's death releases it anyway */ }
  }, { name: 'full-run-claim' });
}

/** Wait until the run `claim` names has ended: its process is gone or it gave the claim back. */
export async function awaitClaim(claim, {
  root = mcHome(), alive = processAlive, pollMs = CLAIM_POLL_MS,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  for (;;) {
    const held = readAll(root).some((other) => other.pid === claim.pid && other.started === claim.started);
    if (!held || !alive(claim.pid)) return;
    await sleep(pollMs);
  }
}
