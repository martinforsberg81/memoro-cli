/**
 * The two files that make the page instant: `~/mc/runner/plans.json` and
 * `~/mc/runner/prs.json`.
 *
 * The page reads plans from `origin/main` and open PRs from GitHub. Neither
 * changes between two prints a second apart, and one of them needs the
 * network, so the page reads them once and remembers.
 *
 * **plans.json** is keyed by the `origin/main` sha, per repository. A cache
 * hit costs one `git rev-parse` — the sha *is* the question "did anything
 * change?", so there is no staleness to reason about and no age to print: a
 * hit is exactly what a fresh read would have returned. A miss reads the
 * plans with one `cat-file --batch` and rewrites the entry.
 *
 * **prs.json** has no such key — an open PR closes without moving any sha —
 * so it is stamped instead, written only by `--fresh`, and the page says how
 * old it is. That is the whole difference between the two files.
 *
 * These are the page's only writes. They are a read-through cache of things
 * the page already reads, not state anything else depends on: delete both
 * and the next `--fresh` fills them again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { catFileBatch, listPlans } from './brief-collect.js';

export const PLANS_FILE = 'plans.json';
export const PRS_FILE = 'prs.json';

export function cachePath(root, file) {
  return join(root, 'runner', file);
}

function readJson(path, read) {
  try { return JSON.parse(read(path, 'utf8')); } catch { return null; }
}

const seconds = (iso, now) => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((now.getTime() - at) / 1000));
};

/**
 * Every plan of every repository, from the cache where the sha still matches
 * and from git where it does not.
 *
 * A repository whose `rev-parse` fails — no checkout, no origin/main — is
 * read straight through and not cached: there is no key to file it under.
 */
export function loadPlans({
  root,
  repos,
  ref = 'origin/main',
  now = new Date(),
  git,
  batch = catFileBatch,
  read = readFileSync,
  write = writeJsonAtomic,
} = {}) {
  const path = cachePath(root, PLANS_FILE);
  const cache = readJson(path, read) || {};
  const plans = [];
  const sources = [];
  let dirty = false;
  for (const repo of repos) {
    const sha = git(repo.path, ['rev-parse', ref]);
    const entry = sha ? cache[repo.name] : null;
    if (entry && entry.sha === sha && Array.isArray(entry.plans)) {
      plans.push(...entry.plans);
      sources.push({ repo: repo.name, sha, cached: true });
      continue;
    }
    const fresh = listPlans(repo, { ref, git, batch });
    plans.push(...fresh);
    sources.push({ repo: repo.name, sha, cached: false });
    if (sha) { cache[repo.name] = { sha, read: now.toISOString(), plans: fresh }; dirty = true; }
  }
  if (dirty) { try { write(path, cache); } catch { /* a cache that cannot be written is still a page */ } }
  return { plans, sources };
}

/** The open PRs as they were when `--fresh` last asked, with their age. */
export function loadPrs({ root, now = new Date(), read = readFileSync } = {}) {
  const cache = readJson(cachePath(root, PRS_FILE), read);
  if (!cache || !Array.isArray(cache.prs)) return { prs: [], fetched: null, age_seconds: null };
  return { prs: cache.prs, fetched: cache.fetched || null, age_seconds: seconds(cache.fetched, now) };
}

export function savePrs({ root, prs, now = new Date(), write = writeJsonAtomic } = {}) {
  const fetched = now.toISOString();
  try { write(cachePath(root, PRS_FILE), { fetched, prs }); } catch { /* see loadPlans */ }
  return { prs, fetched, age_seconds: 0 };
}

/** "3 min", "2 h", "4 d" — how old a cache is, in the page's own voice. */
export function ageWords(secs) {
  if (secs == null) return 'unknown age';
  if (secs < 90) return `${secs}s`;
  const minutes = Math.round(secs / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
