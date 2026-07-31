/**
 * `mc rename <old> <new> [--json]` (§2 + §3).
 *
 * Atomic-from-the-user's-pov: branch + dir + registry update. If the
 * dir move fails we attempt to roll back the branch rename so we don't
 * leave the world half-renamed.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  formatEntryResolutionError,
  renameEntry,
  resolveEntry,
} from '../registry.js';
import { git, primaryWorktree, branchExists } from '../git.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }
  if (!opts.oldName || !opts.newName) {
    console.error('mc: usage — `mc rename <old> <new>` (two args required)');
    return 2;
  }
  if (!NAME_RE.test(opts.newName)) {
    console.error(`mc: invalid new name "${opts.newName}"`);
    return 2;
  }

  const resolved = resolveEntry(opts.oldName);
  if (!resolved.ok) {
    console.error(`mc: ${formatEntryResolutionError(opts.oldName, resolved)}`);
    return 1;
  }
  const entry = resolved.entry;
  if (!entry.session_id || !entry.repository_id) {
    console.error(`mc: session "${entry.name}" has unresolved legacy identity; registry state was preserved`);
    return 1;
  }
  const replacement = resolveEntry(opts.newName, {
    repositoryId: entry.repository_id,
  });
  if (replacement.ok) {
    console.error(`mc: a session named "${opts.newName}" already exists`);
    return 1;
  }
  if (['ambiguous-session-name', 'ambiguous-legacy-session'].includes(replacement.reason)) {
    console.error(`mc: ${formatEntryResolutionError(opts.newName, replacement)}`);
    return 1;
  }

  const primary = primaryWorktree(process.cwd()) || primaryWorktree(entry.worktree_path);
  if (!primary) {
    console.error('mc: could not resolve primary worktree');
    return 1;
  }

  const oldBranch = entry.branch;
  // Keep the existing prefix (sess/ → sess/, fix/ → fix/) so power users
  // who renamed off the default prefix don't get reset.
  const newBranch = oldBranch && oldBranch.includes('/')
    ? `${oldBranch.split('/')[0]}/${opts.newName}`
    : `sess/${opts.newName}`;
  if (oldBranch && newBranch !== oldBranch) {
    if (branchExists(primary, newBranch)) {
      console.error(`mc: branch "${newBranch}" already exists`);
      return 1;
    }
    git(primary, ['branch', '-m', oldBranch, newBranch]);
  }

  const newWt = entry.worktree_path
    ? join(dirname(entry.worktree_path), opts.newName)
    : null;
  let dirMoved = false;
  if (newWt && entry.worktree_path && existsSync(entry.worktree_path) && entry.worktree_path !== newWt) {
    try {
      mkdirSync(dirname(newWt), { recursive: true });
      // Use `git worktree move` so git's internal worktree records
      // follow the rename. `mv` would leave git's admin dir pointing at
      // the old path.
      git(primary, ['worktree', 'move', entry.worktree_path, newWt]);
      dirMoved = true;
    } catch (err) {
      // Roll back the branch rename if the dir move failed.
      if (oldBranch && newBranch !== oldBranch) {
        try { git(primary, ['branch', '-m', newBranch, oldBranch]); } catch {}
      }
      console.error(`mc: failed to move worktree: ${err.message}`);
      return 1;
    }
  }

  renameEntry(entry.session_id || opts.oldName, opts.newName, {
    branch: newBranch,
    worktree_path: dirMoved ? newWt : entry.worktree_path,
  });

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      old_name: opts.oldName,
      new_name: opts.newName,
      old_branch: oldBranch,
      new_branch: newBranch,
      worktree_path: dirMoved ? newWt : entry.worktree_path,
    }, null, 2));
  } else {
    console.log(`mc: renamed ${opts.oldName} → ${opts.newName}`);
  }
  return 0;
}

function parseArgs(argv) {
  const opts = { oldName: null, newName: null, json: false };
  for (const a of argv) {
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    if (!opts.oldName) opts.oldName = a;
    else if (!opts.newName) opts.newName = a;
    else return { error: `unexpected arg: ${a}` };
  }
  return opts;
}
