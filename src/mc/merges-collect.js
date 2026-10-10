/**
 * The running gate rounds — one per lane at most (ruling 34) — read from the
 * locks plus the lease beside each.
 *
 * `gate-lock.js` is a file and a pid and nothing else, on purpose (its own
 * header explains why) — it does not know a repository's name, only the slug
 * `repoFileSlug` hashed it under, and it does not know who is holding it,
 * because holding is the lease's fact, not the lock's. This module is the
 * join of the two, for a reader who wants a sentence rather than a slug: the
 * repository's name, matched back from the list mc already knows about, and
 * the holder and errand read off `repo-lease.js` for that same repository. It
 * lives outside `gate-lock.js` rather than inside it so the lock's own file
 * stays importing nothing about leases or a list of repositories — the
 * "whole surface is the round and its phase" that its own tests pin.
 */
import { runningRounds } from './gate-lock.js';
import { readLease } from './repo-lease.js';
import { repoFileSlug } from './repo-snapshot.js';
import { mcHome } from './paths.js';

/**
 * The round running right now, with a name a person can read — or null.
 *
 * `repos` is the list mc already keeps of what it watches (`{ name, path }`,
 * `defaultRepos` in `brief-collect.js`): the slug in the lock file is matched
 * back to one of them by re-hashing each candidate's path, and a slug that
 * matches nothing (a repository the lock was taken for but this list does not
 * carry) falls back to the slug itself rather than hiding the round.
 */
export function runningMerge(options = {}) {
  return runningMerges(options)[0] || null;
}

/**
 * Every round running right now, heavy lane first, each with a name a person
 * can read and its `lane` — an empty list when none is. Two when a memoro and
 * a memoro-cli round run side by side, and the page draws both.
 */
export function runningMerges({
  root = mcHome(), repos = [], alive = undefined, now = new Date(),
} = {}) {
  const rounds = runningRounds({ root, ...(alive ? { alive } : {}) });
  return Object.values(rounds).filter(Boolean).map((running) => named(running, { root, repos, now }));
}

function named(running, { root, repos, now }) {

  const match = repos.find((candidate) => repoFileSlug(candidate.path) === running.repo) || null;
  const lease = match ? readLease(match.path, { root, now: now.getTime() }) : null;

  const since = running.since ? Date.parse(running.since) : NaN;
  const phaseAt = running.phase_at ? Date.parse(running.phase_at) : NaN;

  return {
    repo: match ? match.name : running.repo,
    slug: running.repo,
    lane: running.lane || 'heavy',
    pr: running.pr ?? null,
    pid: running.pid,
    mode: running.mode || null,
    since: running.since || null,
    age_seconds: Number.isFinite(since) ? Math.max(0, Math.round((now.getTime() - since) / 1000)) : null,
    phase: running.phase || null,
    phase_at: running.phase_at || null,
    phase_age_seconds: Number.isFinite(phaseAt) ? Math.max(0, Math.round((now.getTime() - phaseAt) / 1000)) : null,
    holder: lease?.held ? lease.holder : null,
    errand: lease?.held ? lease.errand : null,
  };
}
