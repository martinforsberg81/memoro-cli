/**
 * Who is measuring a repository's main right now: one record per full run in
 * flight, so that a second starter of the same measurement follows the first
 * instead of starting another.
 *
 * Three doors start a full run — `mc deploy` (its preparation), `mc test
 * <repo> --full`, and the runner's full run — and a full run is a suite's
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
 * is another tree, and waits its turn: a repository has one checkout for its
 * full run (`<slug>/full`), and a second run preparing it under the first would
 * pull the tree from under the measurement. Waiting deploys reserve the next
 * available turn in arrival order. The file lives with the history it points
 * to, in mc's home.
 *
 * A claim also records `groups`: the process group of each test batch and
 * command gate group its run starts, added as each starts (`addClaimGroup`).
 * A starter can be gone while its suite still runs in the full-run checkout (a
 * stopped deploy preparation, a killed `mc test --full`), and a second run
 * there would pull the tree from under it. So a claim is live while its pid or
 * any recorded group lives (`claimLive`), at every read and write here; one
 * with all of them gone is a run that died, and is no claim: it is dropped at
 * the next write and ignored at every read. A claim given back while a group
 * of it still lives stays, `released`, until the group is gone.
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

/** The stored claims `pid` started, live or not — what a stop of that starter reads its groups from. */
export function claimsOf(pid, { root = mcHome() } = {}) {
  return readAll(root).filter((claim) => claim.pid === pid);
}

/** Whether the process group `pgid` has a process left: `kill(-pgid, 0)`, EPERM counting as alive. */
export function groupAlive(pgid, { kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** The recorded group of `claim` that still lives, or null. */
function livingGroup(claim, groupLives) {
  return (Array.isArray(claim.groups) ? claim.groups : []).find((pgid) => groupLives(pgid)) ?? null;
}

/** Whether `claim` still holds its run: its starter lives (and has not given it back), or one of its recorded groups does. */
export function claimLive(claim, { alive = processAlive, groupAlive: groupLives = groupAlive } = {}) {
  if (!claim.released && alive(claim.pid)) return true;
  return livingGroup(claim, groupLives) !== null;
}

/**
 * Who holds `claim`, as the wait lines say it: `pid <pid>` while its starter
 * lives, `the suite of a stopped starter (group <pgid>)` while only a group of
 * it does. Read from the stored claim, whose groups grow as its run starts them.
 */
export function claimHolder(claim, { root = mcHome(), alive = processAlive, groupAlive: groupLives = groupAlive } = {}) {
  const stored = readAll(root).find((other) => sameClaim(other, claim)) || claim;
  if (!stored.released && alive(stored.pid)) return `pid ${stored.pid}`;
  const group = livingGroup(stored, groupLives);
  return group === null ? `pid ${stored.pid}` : `the suite of a stopped starter (group ${group})`;
}

/** The full runs in flight: claims whose process, or a group of whose run, is alive. */
export function liveClaims({ root = mcHome(), alive = processAlive, groupAlive: groupLives = groupAlive } = {}) {
  return readAll(root).filter((claim) => !claim.waiting && claimLive(claim, { alive, groupAlive: groupLives }));
}

/** Whether a run claimed as `claim` is the measurement a starter of `repo` at `sha` wants. */
export function overlaps(claim, { repo, sha = null, ref = null }) {
  if (claim.repo !== repo) return false;
  if (sha && claim.sha) return claim.sha === sha;
  return (claim.ref || null) === ref;
}

/**
 * Claim a full run, or find the one already in flight that measures the same
 * thing. `{ claimed: true, claim }` when this process now holds the claim,
 * `{ claimed: false, joined }` when a live claim overlaps it and nothing was
 * written, `{ claimed: false, waitFor }` when the repository's run is of
 * another sha — wait for it (`awaitClaim`), then claim again. Decided under a lock so two starters cannot both find
 * the repository free.
 */
export function claimFullRun({
  repo, sha = null, ref = null, verb = 'full run', root = mcHome(), alive = processAlive,
  groupAlive: groupLives = groupAlive, lock = realLock, pid = process.pid, now = () => new Date(), deploy = false,
}) {
  return lock(root, () => {
    const live = readAll(root).filter((claim) => claimLive(claim, { alive, groupAlive: groupLives }));
    const reservation = deploy && live.find((claim) => claim.waiting && claim.repo === repo && claim.pid === pid && claim.sha === sha && (claim.ref || null) === ref);
    const active = live.find((claim) => !claim.waiting && claim.repo === repo);
    const firstDeploy = live.find((claim) => claim.waiting && claim.repo === repo);
    const write = (claims) => writeJsonAtomic(claimsPath(root), { schema: CLAIMS_SCHEMA, claims }, { mode: 0o600 });
    const others = live.filter((claim) => claim !== reservation);

    const entry = () => ({ repo, sha, pid, started: now().toISOString(), verb, ...(ref ? { ref } : {}) });
    if (active && overlaps(active, { repo, sha, ref })) {
      if (reservation) write(others);
      return { claimed: false, joined: active };
    }

    const waitFor = active || (firstDeploy !== reservation && firstDeploy);
    if (waitFor) {
      if (deploy && !reservation) {
        const queued = { ...entry(), waiting: true };
        write([...live, queued]);
        return { claimed: false, waitFor, reservation: queued };
      }
      return { claimed: false, waitFor, ...(reservation ? { reservation } : {}) };
    }

    const claim = entry();
    write([...others, claim]);
    return { claimed: true, claim };
  }, { name: 'full-run-claim' });
}

function sameClaim(a, b) {
  return a.repo === b.repo && a.pid === b.pid && a.sha === b.sha && a.ref === b.ref
    && a.started === b.started && a.waiting === b.waiting;
}

/**
 * Record that `claim`'s run started process group `pgid` (a test batch, a
 * command gate group), so the claim stays live while it does. Nothing when the
 * claim is no longer stored.
 */
export function addClaimGroup(claim, pgid, { root = mcHome(), lock = realLock } = {}) {
  if (!claim || !Number.isInteger(pgid) || pgid <= 0) return;
  lock(root, () => {
    const claims = readAll(root);
    const own = claims.find((other) => sameClaim(other, claim));
    if (!own) return;
    const groups = Array.isArray(own.groups) ? own.groups : [];
    if (groups.includes(pgid)) return;
    own.groups = [...groups, pgid];
    writeJsonAtomic(claimsPath(root), { schema: CLAIMS_SCHEMA, claims }, { mode: 0o600 });
  }, { name: 'full-run-claim' });
}

/**
 * Give the claim back — the run has ended, whatever it found. A recorded group
 * of it that still lives keeps it, marked `released`, until that group is gone.
 */
export function releaseClaim(claim, { root = mcHome(), lock = realLock, alive = processAlive, groupAlive: groupLives = groupAlive } = {}) {
  if (!claim) return;
  lock(root, () => {
    const rest = [];
    for (const other of readAll(root)) {
      if (sameClaim(other, claim)) {
        if (livingGroup(other, groupLives) !== null) rest.push({ ...other, released: true });
      } else if (claimLive(other, { alive, groupAlive: groupLives })) {
        rest.push(other);
      }
    }
    try { writeJsonAtomic(claimsPath(root), { schema: CLAIMS_SCHEMA, claims: rest }, { mode: 0o600 }); } catch { /* the pid's death releases it anyway */ }
  }, { name: 'full-run-claim' });
}

/**
 * Wait until the run `claim` names has ended: its process and every recorded
 * group of it are gone, or it gave the claim back with none of them left. A wait is not silent: `onWait(elapsedMs)` is called once a
 * minute (`everyMs`), so whoever waits can say it is still waiting.
 *
 * `signal` is optional: a wait whose signal fires returns at once, with the
 * claim still live, and the caller reads the signal to know why it returned
 * (the runner's handover, `fullRun`). Without one the wait ends only with the
 * claim, as the deploy's preparation needs.
 */
export async function awaitClaim(claim, {
  root = mcHome(), alive = processAlive, groupAlive: groupLives = groupAlive, pollMs = CLAIM_POLL_MS,
  sleep = null,
  onWait = null, everyMs = 60_000, clock = () => Date.now(), signal = null,
} = {}) {
  const began = clock();
  let told = began;
  // A sleep the signal cuts short, and removes its timer and listener behind it.
  const nap = (ms) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let timer = null;
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    signal?.addEventListener('abort', done, { once: true });
    if (sleep) { Promise.resolve(sleep(ms)).then(done, done); } else { timer = setTimeout(done, ms); }
  });
  for (;;) {
    if (signal?.aborted) return;
    const stored = readAll(root).find((other) => sameClaim(other, claim));
    if (!stored || !claimLive(stored, { alive, groupAlive: groupLives })) return;
    await nap(pollMs);
    if (signal?.aborted) return;
    if (onWait && clock() - told >= everyMs) { told = clock(); onWait(told - began); }
  }
}
