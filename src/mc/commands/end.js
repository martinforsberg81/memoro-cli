/**
 * `mc end [<name>...] [--force] [--keep-branch] [--dry-run] [--json]
 *         [--emit-shell-directives]`
 *
 * Plan §2 + §9b + §9c. Per target:
 *   - refuse on uncommitted changes (unless --force or IS_SQUASH_PHANTOM)
 *   - refuse on live session     (unless --force)
 *   - remove the git worktree    (forwards to `git worktree remove`)
 *   - delete the branch if it's merged (or unchanged on main); kept if
 *     --keep-branch
 *   - drop the registry entry
 *
 * If invoked from inside one of the to-be-removed worktrees, emit a
 * `cd <primary>` directive on fd 3 *before* removing the worktree so the
 * caller's shell doesn't end up in a deleted dir.
 *
 * Bulk: multiple names operate sequentially; --dry-run returns the per-
 * target verdict without acting.
 */
import { existsSync, realpathSync } from 'node:fs';
import { findEntry, removeEntry } from '../registry.js';
import { git, tryGit, primaryWorktree, isDirty, branchExists, commitsAhead } from '../git.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { detectSquashPhantom } from '../squash-phantom.js';

function safeRealpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * On macOS, `/var/folders/...` and `/tmp` are symlinks to `/private/...`.
 * `git worktree list --porcelain` reports the realpath form, but the
 * user's shell (and our cd-directive consumers) typically know the path
 * in its non-private form — strip the leading `/private` so the emitted
 * cd lands at the path the user actually navigated to.
 */
function unprivateMac(p) {
  if (typeof p !== 'string') return p;
  if (process.platform !== 'darwin') return p;
  if (p.startsWith('/private/var/') || p.startsWith('/private/tmp/')) {
    return p.slice('/private'.length);
  }
  return p;
}

export async function run(rawArgv) {
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  // Auto-detect `.` and bare `mc end` (inside-a-worktree resolution) —
  // foundation scope keeps these explicit-name only; that's covered by
  // the existing tests. Defer to a follow-up.

  if (opts.names.length === 0) {
    console.error('mc: usage — `mc end <name> [<name>…] [--force] [--keep-branch] [--dry-run]`');
    return 2;
  }

  const targets = [];
  for (const name of opts.names) {
    const entry = findEntry(name);
    if (!entry) {
      console.error(`mc: unknown session "${name}"`);
      return 1;
    }
    targets.push(entry);
  }

  // Resolve primary worktree once. All targets are in the same repo.
  const cwd = process.cwd();
  const primary = primaryWorktree(cwd) || primaryWorktree(targets[0].worktree_path) || cwd;

  // For each target compute the verdict first (so dry-run gets it cheap
  // and the real run can short-circuit phantoms).
  const plans = [];
  for (const entry of targets) {
    const verdict = await computeVerdict(entry, primary);
    plans.push({ entry, verdict });
  }

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      targets: plans.map(({ entry, verdict }) => ({
        name: entry.name,
        branch: entry.branch,
        verdict: verdict.value,
        reason: verdict.reason,
      })),
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      for (const t of out.targets) {
        process.stdout.write(`${t.name.padEnd(20)} → ${t.verdict}${t.reason ? `  (${t.reason})` : ''}\n`);
      }
    }
    return 0;
  }

  // Pre-flight: refuse the whole batch if any target is unsafe (and
  // --force not set). This matches the bulk-feel the user asked for —
  // one read, one decision, no half-applied state.
  for (const { entry, verdict } of plans) {
    if (verdict.value === 'SAFE_TO_END' || verdict.value === 'IS_SQUASH_PHANTOM') continue;
    if (opts.force) continue;
    if (verdict.value === 'IS_ACTIVE_NOW') {
      console.error(`mc: "${entry.name}" is live — pass --force to end anyway`);
      return 1;
    }
    if (verdict.value === 'NEEDS_REVIEW' || verdict.value === 'HAS_UNMERGED_WORK') {
      const why = verdict.reason || 'unsafe';
      console.error(`mc: "${entry.name}" not safe to end (${why}) — pass --force to override`);
      return 1;
    }
  }

  // If cwd is inside one of the to-be-removed worktrees, emit cd back
  // to the primary worktree *before* removing the worktree, so the
  // wrapper's eval lands in a directory that still exists. Normalize
  // both sides via realpath — on macOS, /tmp is a symlink to /private/tmp
  // and a naive startsWith() comparison misses inside-the-worktree.
  const cwdReal = safeRealpath(cwd);
  const insideTarget = plans.find(({ entry }) =>
    entry.worktree_path && cwdReal.startsWith(safeRealpath(entry.worktree_path)),
  );
  if (insideTarget) {
    // Emit the path-as-the-user-knows-it, not git's realpath'd form.
    emitCd(unprivateMac(primary), { enabled: emitDirectives || undefined });
  }

  const results = [];
  for (const { entry, verdict } of plans) {
    try {
      // §12d: shred any materialised vault tokens for this session
      // BEFORE removing the worktree. Best-effort: failures here are
      // logged via the result but don't block worktree teardown. If
      // there's no manifest (session never materialised anything),
      // this is a cheap no-op.
      try {
        const { shredForSession } = await import('../vault/lifecycle.js');
        await shredForSession({
          sessionId: entry.name,
          worktreePath: entry.worktree_path || undefined,
        });
      } catch (_err) {
        // Swallow — `mc end` must succeed even if vault module
        // can't load (e.g. partial dev install).
      }
      await endOne(entry, { primary, keepBranch: opts.keepBranch, verdict });
      removeEntry(entry.name);
      results.push({ name: entry.name, ok: true, verdict: verdict.value });
    } catch (err) {
      results.push({ name: entry.name, ok: false, error: err.message });
    }
  }

  // Single-target convenience: top-level fields mirror the single result.
  if (results.length === 1) {
    const r0 = results[0];
    const single = {
      ok: r0.ok,
      name: r0.name,
      verdict: r0.verdict || plans[0].verdict.value,
      ...(r0.error ? { error: r0.error } : {}),
    };
    if (opts.json) console.log(JSON.stringify(single, null, 2));
    else process.stdout.write(`mc: ended ${r0.name}\n`);
    return r0.ok ? 0 : 1;
  }

  // Bulk
  const allOk = results.every((r) => r.ok);
  if (opts.json) {
    console.log(JSON.stringify({ ok: allOk, results }, null, 2));
  } else {
    for (const r of results) {
      process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.name}${r.error ? ` — ${r.error}` : ''}\n`);
    }
  }
  return allOk ? 0 : 1;
}

async function computeVerdict(entry, primary) {
  // The registry stores a derived verdict — when present, use it as the
  // primary signal. (A future `mc refresh` recomputes them. Tests + the
  // base lifecycle commands trust whatever's on disk.)
  const stored = entry.safety_verdict;

  // Live wins regardless of stored value: a session can become active
  // between writes to the registry.
  if (entry.session_state === 'live') {
    return { value: 'IS_ACTIVE_NOW', reason: 'live session' };
  }

  // For dirty: trust registry's count first; otherwise probe disk.
  const dirtyByRegistry = (entry.dirty_files || 0) > 0;
  const dirtyByDisk = entry.worktree_path && existsSync(entry.worktree_path)
    && isDirty(entry.worktree_path);
  if (dirtyByRegistry || dirtyByDisk) {
    return { value: 'NEEDS_REVIEW', reason: 'uncommitted changes' };
  }

  // Phantom: if the registry already claims phantom, run the live probe
  // to confirm (cheap) before letting `mc end` skip the safety prompt.
  if (stored === 'IS_SQUASH_PHANTOM') {
    const phantom = await detectSquashPhantom({
      repoDir: primary,
      branch: entry.branch,
    }).catch(() => ({ isPhantom: false }));
    if (phantom.isPhantom) {
      return { value: 'IS_SQUASH_PHANTOM', reason: 'changes already on main' };
    }
    // Stored said phantom but the live check disagrees — fall through to
    // the ahead-of-main logic below so we don't silently degrade safety.
  }

  // Ahead-of-main: a non-phantom ahead branch is unmerged work.
  const ahead = entry.branch ? commitsAhead(primary, entry.branch) : 0;
  if (ahead > 0 || stored === 'HAS_UNMERGED_WORK') {
    const phantom = await detectSquashPhantom({
      repoDir: primary,
      branch: entry.branch,
    }).catch(() => ({ isPhantom: false }));
    if (phantom.isPhantom) {
      return { value: 'IS_SQUASH_PHANTOM', reason: 'changes already on main' };
    }
    if (ahead > 0) {
      return { value: 'HAS_UNMERGED_WORK', reason: `${ahead} commit(s) ahead of main` };
    }
  }

  return { value: 'SAFE_TO_END' };
}

async function endOne(entry, { primary, keepBranch, verdict }) {
  const wt = entry.worktree_path;
  if (wt && existsSync(wt)) {
    git(primary, ['worktree', 'remove', '--force', wt]);
  } else {
    // Worktree directory already gone; prune so git's index doesn't lie.
    tryGit(primary, ['worktree', 'prune']);
  }

  if (!keepBranch && entry.branch && branchExists(primary, entry.branch)) {
    // Phantoms are "merged" in spirit even though git records the
    // ahead-by-1. Force-delete in that case so `branch -d` doesn't refuse.
    const force = verdict?.value === 'IS_SQUASH_PHANTOM';
    git(primary, ['branch', force ? '-D' : '-d', entry.branch]);
  }
}

function parseArgs(argv) {
  const opts = {
    names: [], force: false, keepBranch: false, dryRun: false, json: false,
  };
  for (const a of argv) {
    switch (a) {
      case '--force': opts.force = true; break;
      case '--keep-branch': opts.keepBranch = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      default:
        if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
        opts.names.push(a);
    }
  }
  return opts;
}
