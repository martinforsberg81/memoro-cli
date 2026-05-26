/**
 * `mc gc [--dry-run] [--json]` (§2).
 *
 * Reaps worktrees where session is dead AND branch is fully merged AND
 * the worktree is clean. Live sessions, dirty worktrees, and unmerged
 * work are all preserved — the user opted into one of those states.
 *
 * Decision matrix:
 *   session_state=dead  && ahead=0 && dirty_files=0 → eligible
 *   (any other combo)                                → skip
 *
 * Branch deletion is best-effort and follows the same logic as `mc end`:
 * delete with `-d` (refuses if not merged) so we never lose work.
 */
import { existsSync } from 'node:fs';
import { readRegistry, removeEntry } from '../registry.js';
import { git, tryGit, primaryWorktree, branchExists } from '../git.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  const reg = readRegistry();
  const candidates = reg.entries.filter(isEligible);

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      candidates: candidates.map((c) => ({
        name: c.name,
        branch: c.branch,
        worktree_path: c.worktree_path,
      })),
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      for (const c of out.candidates) {
        process.stdout.write(`${c.name}  ${c.branch}\n`);
      }
      if (candidates.length === 0) process.stdout.write('(no candidates)\n');
    }
    return 0;
  }

  const primary = primaryWorktree(process.cwd()) || (candidates[0] && primaryWorktree(candidates[0].worktree_path));
  const removed = [];
  const errors = [];
  for (const c of candidates) {
    try {
      if (c.worktree_path && existsSync(c.worktree_path)) {
        git(primary, ['worktree', 'remove', '--force', c.worktree_path]);
      } else {
        tryGit(primary, ['worktree', 'prune']);
      }
      if (c.branch && branchExists(primary, c.branch)) {
        tryGit(primary, ['branch', '-d', c.branch]);
      }
      removeEntry(c.name);
      removed.push({ name: c.name, branch: c.branch });
    } catch (err) {
      errors.push({ name: c.name, error: err.message });
    }
  }

  const result = { ok: errors.length === 0, removed, ...(errors.length ? { errors } : {}) };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const r of removed) process.stdout.write(`✓ removed ${r.name}\n`);
    for (const e of errors) process.stdout.write(`✗ ${e.name} — ${e.error}\n`);
  }
  return result.ok ? 0 : 1;
}

function isEligible(entry) {
  if (entry.session_state !== 'dead') return false;
  if ((entry.dirty_files || 0) > 0) return false;
  if ((entry.ahead || 0) > 0) return false;
  return true;
}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false };
  for (const a of argv) {
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
}
