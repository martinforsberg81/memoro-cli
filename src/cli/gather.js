/**
 * `mc gather <plan-slug> [--dry-run] [--json]` (§10a MVP).
 *
 * Counterpart to `mc fanout`. Once phase agents have opened PRs, gather:
 *
 *   1. Looks up open PRs with head branch matching
 *      `fan/<plan-slug>/phase-*` through the Memoro GitHub App.
 *   2. Ensures the local collection branch `wip/<plan-slug>` exists
 *      (creates it from each fanout entry's stored default-branch identity,
 *      or resolves the repository default when legacy metadata is absent).
 *   3. Attempts to merge each phase PR's head branch into the local
 *      collection branch in phase-number order. On the first merge
 *      conflict, STOP — do not auto-resolve. Surface which files
 *      conflicted between which phases, plus the suggested action.
 *   4. If every phase merges cleanly, push `wip/<plan-slug>` and open
 *      one summary PR `wip/<plan-slug> → <default>` listing each phase + PR.
 *
 * `--dry-run` reports what would be merged + which conflicts would
 *  occur, without writing.
 *
 * Future-work (intentionally NOT here):
 *   - `--strategy serial-deps` (declared dependencies between phases)
 *   - auto-recovery on phase agent failure
 *   - cross-phase dependency detection
 *
 * Engineering shape: same dep-portal pattern as fanout. Git remains local;
 * GitHub access must be supplied by the typed Memoro GitHub App portal.
 */
import { spawnSync } from 'node:child_process';
import { readRegistry } from '../mc/registry.js';
import { git as gitShell, branchExists, resolveDefaultBranch } from '../mc/git.js';

/**
 * No host GitHub authority is a valid fallback. The command fails closed
 * until its caller supplies the typed Memoro GitHub App portal.
 */
export function defaultGh() {
  return {
    async prListByHeadPattern() { throw githubPortalRequired(); },
    async createSummaryPr() { throw githubPortalRequired(); },
  };
}

/**
 * Default git portal — write-heavy variant that fails loudly on
 * problems we can't recover from (network fetch errors, branch
 * creation, push). Merge attempts use `--no-commit --no-ff` so we
 * can roll back via `git merge --abort` on conflict without leaving
 * a half-committed state.
 */
export function defaultGitPortal() {
  return {
    branchExists,
    resolveDefaultBranch,
    fetch(repoDir, remote, ref) {
      // Shell out — never throw on a missing remote ref. The caller has
      // already resolved the exact remote and handles a false result safely.
      const r = spawnSync('git', ['-C', repoDir, 'fetch', remote, ref], { encoding: 'utf8' });
      return r.status === 0;
    },
    createCollectionBranch(repoDir, branch, fromRef) {
      gitShell(repoDir, ['branch', branch, fromRef]);
    },
    checkout(repoDir, branch) {
      gitShell(repoDir, ['checkout', branch]);
    },
    tryMerge(repoDir, branch) {
      // Returns { ok, conflicts } where conflicts is a list of paths.
      const r = spawnSync('git', ['-C', repoDir, 'merge', '--no-edit', '--no-ff', branch], { encoding: 'utf8' });
      if (r.status === 0) return { ok: true, conflicts: [] };
      // List unmerged paths.
      const ls = spawnSync('git', ['-C', repoDir, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' });
      const conflicts = (ls.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      // Roll back so we don't leave the worktree in a half-merged state.
      spawnSync('git', ['-C', repoDir, 'merge', '--abort'], { encoding: 'utf8' });
      return { ok: false, conflicts };
    },
    push(repoDir, remote, branch) {
      const r = spawnSync('git', ['-C', repoDir, 'push', '-u', remote, branch], { encoding: 'utf8' });
      return r.status === 0;
    },
  };
}

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    printUsage();
    return 2;
  }
  if (!opts.planSlug) {
    console.error('mc: usage — `mc gather <plan-slug> [--dry-run] [--json]`');
    return 2;
  }
  if (!/^[a-z0-9-]+$/.test(opts.planSlug)) {
    console.error(`mc: invalid plan-slug "${opts.planSlug}" — must match [a-z0-9-]+`);
    return 2;
  }

  return runWithDeps(opts, {
    gh: defaultGh(),
    git: defaultGitPortal(),
    registry: { read: readRegistry },
    cwd: process.cwd(),
  });
}

/**
 * Pure-ish gather core. Every external syscall comes from deps.
 * Surface side-effects via the portal so tests don't shell out.
 */
export async function runWithDeps(opts, { gh, git, registry, cwd }) {
  const planSlug = opts.planSlug;

  // Resolve the base from stored fanout metadata. Legacy entries may only
  // have from_ref; in that case use the current resolver only when it proves
  // the same branch. Never replace missing metadata with a conventional name.
  const reg = registry.read({ persistMigration: !opts.dryRun });
  const phaseEntries = (reg?.entries || [])
    .filter((e) => e.parent_plan === planSlug)
    .sort((a, b) => (a.phase_n || 0) - (b.phase_n || 0));
  const firstPhase = phaseEntries[0] || null;
  const resolvedDefault = git.resolveDefaultBranch(cwd);
  const fromRef = nonEmpty(firstPhase?.from_ref)
    || (resolvedDefault?.ok ? resolvedDefault.branch : null);
  if (!fromRef) {
    return emitError(
      opts,
      `default branch is unknown (${resolvedDefault?.reason || 'unavailable'}); re-run fanout with --from <ref> or run git config --local mc.defaultBranch <branch>`,
    );
  }
  const storedGitRef = nonEmpty(firstPhase?.from_git_ref);
  const fromGitRef = storedGitRef
    || (resolvedDefault?.ok && resolvedDefault.branch === fromRef ? resolvedDefault.ref : fromRef);
  const remote = nonEmpty(firstPhase?.from_remote)
    || (resolvedDefault?.ok ? resolvedDefault.remote : null);
  if (!remote) {
    return emitError(opts, 'repository remote is unknown; refusing to guess a remote for gather');
  }

  // Find phase PRs. The MVP contract is "open PRs with head matching
  // fan/<slug>/phase-*". If gh is unreachable, gather can't do
  // anything useful — surface and exit non-zero (don't soft-degrade
  // here; merging without knowing which PRs are open invites mistakes).
  const headPattern = `fan/${planSlug}/phase-`;
  let prs;
  try {
    prs = await gh.prListByHeadPattern(headPattern);
  } catch {
    return emitError(opts, 'Memoro GitHub App capability is required for gather');
  }
  if (!prs || prs.length === 0) {
    return emitError(opts, `no open PRs found for plan "${planSlug}" (expected head branches matching ${headPattern}*)`);
  }

  // Order PRs by phase number parsed from head ref.
  const ordered = prs
    .map((pr) => ({ pr, phaseN: parsePhaseN(pr.headRefName, planSlug) }))
    .filter((x) => x.phaseN != null)
    .sort((a, b) => a.phaseN - b.phaseN);

  if (ordered.length === 0) {
    return emitError(opts, `GitHub returned PRs but none had a parseable phase number for plan "${planSlug}"`);
  }

  const collectionBranch = `wip/${planSlug}`;

  if (opts.dryRun) {
    return emitDryRun(opts, { planSlug, collectionBranch, fromRef, ordered });
  }

  // We need a repo cwd to touch git. Determine primary worktree —
  // simplest correct: assume the caller is inside the repo whose
  // PRs they're gathering. (Pattern shared with `mc new`.)
  // No isInsideRepo check here because the git portal's fetch / merge
  // will surface its own errors with a clean message; surface early
  // anyway for the common foot-gun.

  // Ensure the collection branch exists locally. Fetch the from_ref
  // first so we have something to root it on.
  if (!git.branchExists(cwd, collectionBranch)) {
    if (!git.fetch(cwd, remote, fromRef)) {
      return emitError(opts, `failed to fetch ${fromRef} from ${remote}; refusing a stale base ref`);
    }
    try {
      git.createCollectionBranch(cwd, collectionBranch, fromGitRef);
    } catch (err) {
      // A legacy registry may name only the branch. A local branch with that
      // exact name is an explicit ref, not a guessed default.
      try {
        git.createCollectionBranch(cwd, collectionBranch, fromRef);
      } catch (err2) {
        return emitError(opts, `failed to create collection branch ${collectionBranch}: ${err2.message}`);
      }
    }
  }

  // Check out the collection branch so subsequent merges land there.
  try {
    git.checkout(cwd, collectionBranch);
  } catch (err) {
    return emitError(opts, `failed to checkout ${collectionBranch}: ${err.message}`);
  }

  // Merge each phase in order. Stop on first conflict.
  const merged = [];
  for (const { pr, phaseN } of ordered) {
    // Make sure we have the latest phase branch from the resolved remote.
    if (!git.fetch(cwd, remote, pr.headRefName)) {
      return emitError(
        opts,
        `failed to fetch ${pr.headRefName} from ${remote}; refusing to merge a stale phase ref`,
      );
    }
    const res = git.tryMerge(cwd, `refs/remotes/${remote}/${pr.headRefName}`);
    if (!res.ok) {
      return emitConflict(opts, {
        planSlug,
        collectionBranch,
        phaseN,
        pr,
        conflicts: res.conflicts,
        already_merged: merged,
      });
    }
    merged.push({ phaseN, pr });
  }

  // All merged cleanly — push + open summary PR.
  if (!git.push(cwd, remote, collectionBranch)) {
    return emitError(opts, `merged ${merged.length} phases cleanly but failed to push ${collectionBranch}`);
  }
  const summaryBody = buildSummaryBody({ planSlug, merged, fromRef });
  let create;
  try {
    create = await gh.createSummaryPr({
      head: collectionBranch,
      base: fromRef,
      title: `Fanout: ${planSlug} (${merged.length} phases)`,
      body: summaryBody,
    });
  } catch {
    return emitError(opts, 'merged + pushed, but the Memoro GitHub App capability is unavailable');
  }
  if (!create.ok) {
    return emitError(opts, `merged + pushed, but GitHub PR creation failed: ${create.error}`);
  }

  return emitSuccess(opts, { planSlug, collectionBranch, fromRef, merged, summaryUrl: create.url });
}

function parsePhaseN(headRef, planSlug) {
  if (typeof headRef !== 'string') return null;
  const prefix = `fan/${planSlug}/phase-`;
  if (!headRef.startsWith(prefix)) return null;
  const rest = headRef.slice(prefix.length);
  const n = Number(rest);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function githubPortalRequired() {
  const error = new Error('Memoro GitHub App capability is required');
  error.code = 'MC_GITHUB_APP_PORTAL_REQUIRED';
  return error;
}

function buildSummaryBody({ planSlug, merged, fromRef }) {
  const lines = [
    `Fanout collection PR for plan "${planSlug}".`,
    '',
    `Merged ${merged.length} phase${merged.length === 1 ? '' : 's'} into`,
    `\`wip/${planSlug}\` (from \`${fromRef}\`):`,
    '',
  ];
  for (const { phaseN, pr } of merged) {
    lines.push(`- phase ${phaseN}: #${pr.number} ${pr.title || ''}`.trimEnd());
  }
  lines.push('');
  lines.push(`Generated by \`mc gather ${planSlug}\`.`);
  return lines.join('\n');
}

function emitDryRun(opts, { planSlug, collectionBranch, fromRef, ordered }) {
  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      plan_slug: planSlug,
      collection_branch: collectionBranch,
      from: fromRef,
      phase_count: ordered.length,
      phases: ordered.map(({ pr, phaseN }) => ({
        phase_n: phaseN,
        pr_number: pr.number,
        head_ref: pr.headRefName,
        title: pr.title,
        url: pr.url,
      })),
    }, null, 2));
    return 0;
  }
  process.stdout.write(`mc gather — dry run (no merges performed)\n\n`);
  process.stdout.write(`Plan slug:         ${planSlug}\n`);
  process.stdout.write(`Collection branch: ${collectionBranch}\n`);
  process.stdout.write(`Would merge in order (from ${fromRef}):\n`);
  for (const { pr, phaseN } of ordered) {
    process.stdout.write(`  phase ${phaseN}: PR #${pr.number} ${pr.headRefName} — ${pr.title || ''}\n`);
  }
  process.stdout.write(`\nConflict detection is only run live; this dry-run lists order, not overlap.\n`);
  process.stdout.write(`(Future work: --strategy serial-deps for declared phase dependencies.)\n`);
  return 0;
}

function emitConflict(opts, { planSlug, collectionBranch, phaseN, pr, conflicts, already_merged }) {
  const previousPhases = already_merged.map((m) => `phase ${m.phaseN} (#${m.pr.number})`).join(', ');
  const summary = `merge conflict at phase ${phaseN} (PR #${pr.number}) into ${collectionBranch}`;
  if (opts.json) {
    console.log(JSON.stringify({
      ok: false,
      error: summary,
      plan_slug: planSlug,
      collection_branch: collectionBranch,
      conflict: {
        phase_n: phaseN,
        pr_number: pr.number,
        head_ref: pr.headRefName,
        files: conflicts,
        previously_merged: already_merged.map(({ phaseN: n, pr: p }) => ({ phase_n: n, pr_number: p.number })),
      },
      suggested_action: 'manual rebase, or (future work) re-fanout with --strategy serial-deps',
    }, null, 2));
  }
  console.error(`mc: ${summary}`);
  if (conflicts.length > 0) {
    console.error('  Conflicting files:');
    for (const f of conflicts) console.error(`    ${f}`);
  }
  if (previousPhases) {
    console.error(`  Previously merged cleanly: ${previousPhases}`);
  }
  console.error('  Suggested: manual rebase against the previously-merged phases.');
  console.error('  Future work: `mc gather --strategy serial-deps` will let phases declare ordering.');
  return 1;
}

function emitSuccess(opts, { planSlug, collectionBranch, fromRef, merged, summaryUrl }) {
  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      plan_slug: planSlug,
      collection_branch: collectionBranch,
      from: fromRef,
      phase_count: merged.length,
      phases: merged.map(({ phaseN, pr }) => ({
        phase_n: phaseN,
        pr_number: pr.number,
        head_ref: pr.headRefName,
        title: pr.title,
      })),
      summary_pr_url: summaryUrl,
    }, null, 2));
    return 0;
  }
  process.stdout.write(`mc gather — merged ${merged.length} phase${merged.length === 1 ? '' : 's'} for plan "${planSlug}"\n\n`);
  for (const { phaseN, pr } of merged) {
    process.stdout.write(`  phase ${phaseN}: PR #${pr.number} ${pr.headRefName} — ${pr.title || ''}\n`);
  }
  process.stdout.write(`\nCollection branch: ${collectionBranch} (from ${fromRef})\n`);
  process.stdout.write(`Summary PR:        ${summaryUrl}\n`);
  return 0;
}

function emitError(opts, msg) {
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  }
  console.error(`mc: ${msg}`);
  return 1;
}

function parseArgs(argv) {
  const opts = { planSlug: null, dryRun: false, json: false };
  for (const a of argv) {
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('--')) { return { error: `unknown flag: ${a}` }; }
    if (opts.planSlug) { return { error: `unexpected positional arg: ${a}` }; }
    opts.planSlug = a;
  }
  return opts;
}

function printUsage() {
  console.error('Usage: mc gather <plan-slug> [--dry-run] [--json]');
  console.error('  Merges phase PRs from `mc fanout` into a single wip/<plan-slug> collection branch.');
  console.error('  Stops on the first cross-phase conflict (no auto-resolution).');
  console.error('  Future work: --strategy serial-deps for declared phase ordering.');
}
