/**
 * The candidate's result, carried forward as the next round's baseline (A1).
 *
 * After a green merge, main *is* the tree the candidate was just measured
 * on — and the next round's baseline run measures exactly that tree again.
 * Measured across 61 memoro rounds: 52 baselines were byte-for-byte the
 * previous round's already-measured candidate, and across 92 rounds the
 * baseline never once produced a red delta. So the result is saved, keyed
 * on everything that could make it wrong, and the next round reuses it
 * only when every key matches:
 *
 *   (merge-commit SHA, lockfile hash at that commit, suite command)
 *
 * The chain breaks on the smallest deviation — main is somebody else's
 * commit, the lockfile changed, another suite command, no saved entry —
 * and the baseline is run as before. A cache that guesses is worse than no
 * cache (the order's own words). The red comparison keeps its form either
 * way: it becomes free, not absent.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';
import { join } from 'node:path';

export const BASELINE_CACHE_SCHEMA = 'mc-gate-baseline';
export const BASELINE_CACHE_VERSION = 1;

export function baselineCachePath(root = mcHome()) {
  return join(root, 'gate-baseline.json');
}

/**
 * The lockfile's hash as of a commit, read from git rather than from a
 * worktree: the key must describe the tree the result was measured on, not
 * whatever happens to be on disk now. A repository with no lockfile at that
 * commit hashes the fact itself — two such commits still match each other
 * and never match one that has a lockfile.
 */
export function lockfileHashAt({ git, repoPath, commit }) {
  const shown = git(['show', `${commit}:package-lock.json`], { cwd: repoPath });
  const content = shown?.status === 0 ? String(shown.stdout || '') : 'no-lockfile-at-this-commit';
  return createHash('sha256').update(content).digest('hex');
}

/** Save the candidate's measured result as the baseline-in-waiting. */
export function saveBaseline({
  repoPath, commit, lockfileHash, command, red, totals, root = mcHome(), now = new Date(),
}) {
  const table = readTable(root);
  table[repoFileSlug(repoPath)] = {
    commit,
    lockfile_hash: lockfileHash,
    command,
    red: [...(red || [])],
    totals: totals || null,
    measured_at: now.toISOString(),
  };
  writeJsonAtomic(baselineCachePath(root), {
    schema: BASELINE_CACHE_SCHEMA, version: BASELINE_CACHE_VERSION, repos: table,
  });
  return table[repoFileSlug(repoPath)];
}

/**
 * The saved result — but only when every key matches exactly. Anything else
 * is null, and null means "run the baseline as before". No partial credit:
 * a near-miss reused is the guess this file exists to refuse.
 */
export function loadBaseline({ repoPath, commit, lockfileHash, command, root = mcHome() }) {
  const entry = readTable(root)[repoFileSlug(repoPath)];
  if (!entry) return null;
  if (entry.commit !== commit) return null;
  if (entry.lockfile_hash !== lockfileHash) return null;
  if (entry.command !== command) return null;
  if (!Array.isArray(entry.red)) return null;
  return entry;
}

function readTable(root) {
  try {
    const value = JSON.parse(readFileSync(baselineCachePath(root), 'utf8'));
    if (value?.schema !== BASELINE_CACHE_SCHEMA || value?.version !== BASELINE_CACHE_VERSION) return {};
    return value.repos && typeof value.repos === 'object' ? value.repos : {};
  } catch { return {}; }
}
