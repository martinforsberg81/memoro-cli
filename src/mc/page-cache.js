/**
 * The file that makes the page instant: `~/mc/runner/prs.json`, the open PRs
 * as GitHub last gave them. Plans are not cached: they are read from
 * `~/mc/programs/` on every call (`loadPlans`), which is a directory read.
 *
 * **prs.json** has no key — an open PR closes without moving any sha — so it
 * is stamped instead, written by `--fresh`, by every runner round
 * that asked GitHub and by a page at a terminal whose copy is five minutes old
 * (`mergePrs`), and trimmed by the merger the moment a pull request lands
 * (`dropPr`). The page says how old it is.
 *
 * These are the page's only writes. They are a read-through cache of things
 * the page already reads, not state anything else depends on: delete the file
 * and the next `--fresh` fills it again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { listPlans } from './brief-collect.js';
import { programsPlans } from './plan-source.js';

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
 * Every plan of every repository, as `listPlans` gives them: the plans under
 * `~/mc/programs/` (ruling 48). Nothing is cached: `~/mc/programs/` changes
 * without any sha moving, and reading it is a directory read. `sources` says
 * one line a repository, never cached. `ref`, `now`, `git`, `batch`, `read`
 * and `write` are accepted and not used.
 */
export function loadPlans({ repos, programs = programsPlans } = {}) {
  const plans = repos.flatMap((repo) => listPlans(repo, { programs }));
  const sources = repos.map((repo) => ({ repo: repo.name, sha: null, cached: false }));
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
  try { write(cachePath(root, PRS_FILE), { fetched, prs }); } catch { /* a cache that cannot be written is still a page */ }
  return { prs, fetched, age_seconds: 0 };
}

/**
 * What a runner round has just been told, put into the cache for the page: the
 * repositories it asked replace their own entries and every other one stays as
 * it was. The round asks GitHub anyway, a lane at a time and sometimes one
 * repository only, so the page's pull requests were hours old while the
 * runner held answers seconds old (2026-10-09: 2.5 h, with four pull requests
 * missing from it).
 */
export function mergePrs({
  root, repos = [], prs = [], now = new Date(), read = readFileSync, write = writeJsonAtomic,
} = {}) {
  if (!repos.length) return null;
  const cache = readJson(cachePath(root, PRS_FILE), read);
  const kept = Array.isArray(cache?.prs) ? cache.prs.filter((pr) => !repos.includes(pr.repo)) : [];
  return savePrs({ root, prs: [...kept, ...prs], now, write });
}

/**
 * How old the PR cache may be before a page at a terminal asks GitHub itself
 * (page-collect.js, `fresh: 'stale'`). Until 2026-10-10 only `--fresh`,
 * `mc prs` and a runner lane's pick refilled it, so with the runner stopped —
 * or every lane an hour into a step — PULL REQUESTS said `as of 55 min ago`
 * and nothing was going to change that.
 */
export const PRS_STALE_SECONDS = 300;

/**
 * A pull request taken off the cached list the moment it has landed (the
 * merger), so the page stops drawing it as open. `fetched` is kept: the rest
 * of the list is no fresher than it was.
 */
export function dropPr({
  root, repo, number, read = readFileSync, write = writeJsonAtomic,
} = {}) {
  const cache = readJson(cachePath(root, PRS_FILE), read);
  if (!cache || !Array.isArray(cache.prs)) return false;
  const prs = cache.prs.filter((pr) => !(pr.repo === repo && Number(pr.number) === Number(number)));
  if (prs.length === cache.prs.length) return false;
  try { write(cachePath(root, PRS_FILE), { ...cache, prs }); } catch { return false; }
  return true;
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
