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
import { isAbsolute, relative } from 'node:path';
import { readRegistry, removeEntry } from '../registry.js';
import { git, tryGit, primaryWorktree, isDirty, branchExists, commitsAhead } from '../git.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { detectSquashPhantom } from '../squash-phantom.js';
import { removeBrokerSessionForEntry } from '../broker/session-cleanup.js';

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

export async function run(rawArgv, runOpts = {}) {
  const stdout = runOpts.stdout || process.stdout;
  const stderr = runOpts.stderr || process.stderr;
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }

  const cwd = runOpts.cwd || process.cwd();
  const reg = readRegistry();
  const names = opts.names.length > 0 ? opts.names : ['.'];
  const targets = [];
  for (const name of names) {
    const entry = name === '.'
      ? resolveImplicitEntry(reg.entries, cwd)
      : reg.entries.find((e) => e.name === name) || null;
    if (!entry) {
      if (name === '.') {
        stderr.write('mc: could not infer which session to end from this directory\n');
        stderr.write('mc: usage — `mc end [<name>…] [--force] [--keep-branch] [--dry-run]`\n');
        return 2;
      }
      stderr.write(`mc: unknown session "${name}"\n`);
      return 1;
    }
    targets.push(entry);
  }

  // For each target compute the verdict first (so dry-run gets it cheap
  // and the real run can short-circuit phantoms).
  const plans = [];
  for (const entry of targets) {
    const primary = resolvePrimaryForEntry(entry, cwd);
    if (!primary) {
      stderr.write(`mc: "${entry.name}" has no resolvable primary worktree\n`);
      return 1;
    }
    const verdict = await computeVerdict(entry, primary);
    plans.push({ entry, primary, verdict });
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
    if (opts.json) stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      for (const t of out.targets) {
        stdout.write(`${t.name.padEnd(20)} → ${t.verdict}${t.reason ? `  (${t.reason})` : ''}\n`);
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
      const confirmed = await confirmActiveEnd({
        entry,
        opts,
        stdin: runOpts.stdin || process.stdin,
        stdout,
        stderr,
        deps: runOpts.deps || {},
      });
      if (confirmed) continue;
      return 1;
    }
    if (verdict.value === 'NEEDS_REVIEW' || verdict.value === 'HAS_UNMERGED_WORK') {
      const why = verdict.reason || 'unsafe';
      stderr.write(`mc: "${entry.name}" not safe to end (${why}) — pass --force to override\n`);
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
    entry.worktree_path && isInsidePath(cwdReal, safeRealpath(entry.worktree_path)),
  );
  if (insideTarget) {
    // Emit the path-as-the-user-knows-it, not git's realpath'd form.
    emitCd(unprivateMac(insideTarget.primary), { enabled: emitDirectives || undefined });
  }

  const results = [];
  for (const { entry, primary, verdict } of plans) {
    try {
      const brokerCleanup = await removeBrokerSessionForEntry(entry, {
        requestBroker: runOpts.deps?.requestBroker,
      });
      if (!brokerCleanup.ok && !brokerCleanup.skipped) {
        stderr.write(`mc: warning — broker cleanup for "${entry.name}" failed (${brokerCleanup.error || brokerCleanup.reason})\n`);
      }
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
    if (opts.json) stdout.write(`${JSON.stringify(single, null, 2)}\n`);
    else if (r0.ok) stdout.write(`mc: ended ${r0.name}\n`);
    else stderr.write(`mc: failed to end ${r0.name}: ${r0.error}\n`);
    return r0.ok ? 0 : 1;
  }

  // Bulk
  const allOk = results.every((r) => r.ok);
  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: allOk, results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      stdout.write(`${r.ok ? '✓' : '✗'} ${r.name}${r.error ? ` — ${r.error}` : ''}\n`);
    }
  }
  return allOk ? 0 : 1;
}

function findEntryForCwd(entries, cwd) {
  const cwdReal = safeRealpath(cwd);
  return (entries || [])
    .filter((entry) => entry?.worktree_path)
    .map((entry) => ({ entry, worktreeReal: safeRealpath(entry.worktree_path) }))
    .filter(({ worktreeReal }) => isInsidePath(cwdReal, worktreeReal))
    .sort((a, b) => b.worktreeReal.length - a.worktreeReal.length)[0]?.entry || null;
}

function resolveImplicitEntry(entries, cwd) {
  const current = findEntryForCwd(entries, cwd);
  if (current) return current;

  const primary = primaryWorktree(cwd);
  if (!primary) return null;

  const primaryReal = safeRealpath(primary);
  const candidates = (entries || [])
    .filter((entry) => entry && entry.worktree_path)
    .filter((entry) => entryMatchesPrimary(entry, primaryReal))
    .map((entry) => ({ entry, openedAt: timestampMs(entry.last_opened_at) }))
    .filter((item) => Number.isFinite(item.openedAt))
    .sort((a, b) => b.openedAt - a.openedAt);

  return candidates[0]?.entry || null;
}

function entryMatchesPrimary(entry, primaryReal) {
  if (!entry || !primaryReal) return false;
  if (entry.primary_worktree && samePath(safeRealpath(entry.primary_worktree), primaryReal)) {
    return true;
  }
  if (entry.worktree_path && existsSync(entry.worktree_path)) {
    const entryPrimary = primaryWorktree(entry.worktree_path);
    return entryPrimary ? samePath(safeRealpath(entryPrimary), primaryReal) : false;
  }
  return false;
}

function isInsidePath(candidate, parent) {
  if (!candidate || !parent) return false;
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolvePrimaryForEntry(entry, cwd) {
  if (entry?.primary_worktree) {
    const primary = primaryWorktree(entry.primary_worktree);
    if (primary) return primary;
  }

  if (entry?.worktree_path && existsSync(entry.worktree_path)) {
    const primary = primaryWorktree(entry.worktree_path);
    if (primary) return primary;
  }

  const cwdPrimary = primaryWorktree(cwd);
  if (cwdPrimary && (!entry?.worktree_path || worktreeBelongsToPrimary(cwdPrimary, entry.worktree_path))) {
    return cwdPrimary;
  }

  return null;
}

function worktreeBelongsToPrimary(primary, worktreePathValue) {
  if (!primary || !worktreePathValue) return false;
  const out = tryGit(primary, ['worktree', 'list', '--porcelain']);
  if (!out) return false;
  const needle = safeRealpath(worktreePathValue);
  return out
    .split('\n\n')
    .some((block) => {
      const m = block.match(/^worktree\s+(.+)$/m);
      return m && samePath(safeRealpath(m[1].trim()), needle);
    });
}

function samePath(a, b) {
  return a === b || isInsidePath(a, b) && isInsidePath(b, a);
}

function timestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : NaN;
}

async function confirmActiveEnd({
  entry,
  opts,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  deps = {},
} = {}) {
  const isInteractive = deps.isTTY ?? (stdin?.isTTY && stdout?.isTTY);
  if (opts?.json || !isInteractive) {
    stderr.write(`mc: "${entry.name}" is live — pass --force to end anyway\n`);
    return false;
  }
  const answer = await promptYesNo({
    prompt: 'Sessionen är aktiv. Vill du avsluta ändå? y/n ',
    stdin,
    stdout,
    deps,
  });
  return answer.trim().toLowerCase() === 'y';
}

async function promptYesNo({ prompt, stdin, stdout, deps = {} } = {}) {
  if (typeof deps.readLine === 'function') {
    stdout.write(prompt);
    return deps.readLine({ stdin, stdout, prompt });
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
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
