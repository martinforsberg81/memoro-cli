import { observeWorktree } from './git.js';
import { upsertEntry } from './registry.js';

export function observeEntryWorktree(entry, {
  observe = observeWorktree,
  upsert = upsertEntry,
} = {}) {
  if (!entry || typeof entry.name !== 'string') {
    return { entry, observation: { ok: false, reason: 'missing-entry' } };
  }
  const observation = observe(entry.worktree_path);
  if (!observation?.ok) return { entry, observation };

  const patch = observationPatch(entry, observation);
  const next = { ...entry, ...patch };
  if (typeof upsert === 'function') {
    upsert(patch);
  }
  return { entry: next, observation };
}

export function observationPatch(entry, observation) {
  const patch = {
    name: entry.name,
    original_branch: entry.original_branch || entry.branch || null,
    current_branch: observation.current_branch || null,
    observed_head: observation.head || null,
    observed_worktree_path: observation.worktree_path || entry.worktree_path || null,
    observed_git_root: observation.git_root || null,
    observed_detached: Boolean(observation.detached),
    observed_dirty_files: numberOrNull(observation.dirty_files),
    observed_ahead: numberOrNull(observation.ahead),
    observed_behind: numberOrNull(observation.behind),
    last_observed_at: observation.observed_at || new Date().toISOString(),
  };
  if (Number.isFinite(patch.observed_dirty_files)) {
    patch.dirty_files = patch.observed_dirty_files;
  }
  return patch;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
