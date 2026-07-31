/**
 * `mc fanout <plan.md> [--from <ref>] [--tool codex] [--dry-run] [--json]`.
 *
 * Parses a plan file's `## Phase N: <title>` headings and spawns one
 * idle session per phase. Each session lands in its own worktree on
 * a `fan/<plan-slug>/phase-N` branch rooted at --from (default repository
 * branch),
 * with a brief assembled from the plan intro + phase body written to
 * `<worktree>/.mc/brief.md` for the agent to read.
 *
 * v1 scope (per drev brief):
 *   - parses `## Phase N:` headings only (no YAML frontmatter)
 *   - default parallel; no `--strategy serial-deps`
 *   - returns once sessions are spawned; does NOT block on completion
 *   - no push-events / budget / model-selection / verifier
 *
 * Out of scope and intentionally NOT in this file:
 *   - launching the agent tool — sessions are idle,
 *     user attaches via `mc open <session-name>` (follow-up: feed
 *     the brief to the tool on resume)
 *
 * Engineering shape:
 *   - Pure helpers live in `../orchestration/plan-parser.js` and
 *     `../orchestration/brief-template.js`. They have no filesystem,
 *     git, or process dependency — unit-testable in isolation.
 *   - This verb is the impure shell: reads the plan file, calls git,
 *     touches the registry, writes brief files. Every external syscall
 *     is taken as an injectable portal (`gitFn`, `fsFn`) per the
 *     dep-portal pattern (pattern 2). Tests inject stubs; prod gets
 *     the default that shells out.
 *   - We deliberately do NOT call into `mc new` — its branch naming
 *     is `sess/<name>` and there's no programmatic entry point that
 *     skips the launch path. Refactoring `new.js`
 *     to expose a `createSession({ name, branch, kind, parent })` helper
 *     would be a future-work follow-up (see the PR body).
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { parsePhases, planSlugFromFilename } from '../orchestration/plan-parser.js';
import { buildFanoutBrief } from '../orchestration/brief-template.js';
import { upsertEntry, findEntry, readRegistry } from '../registry.js';
import { repoSlug, worktreePath } from '../paths.js';
import {
  repositoryIdentityProjection,
  resolveRepositoryIdentity,
} from '../repository-identity.js';
import {
  git as gitShell,
  isInsideRepo,
  primaryWorktree,
  branchExists,
  resolveDefaultBranch,
} from '../git.js';
import { readEffectiveConfigForNew, resolveToolForNew, TOOL_SUGAR } from './new.js';

/**
 * Default git portal — wraps the synchronous shell-out used elsewhere
 * in mc. Soft-degrades only on probes, never on writes (worktree-add
 * failures bubble up; we want fanout to halt loudly if git can't
 * create a branch, not silently skip a phase).
 */
export function defaultGit() {
  return {
    isInsideRepo,
    primaryWorktree,
    branchExists,
    resolveDefaultBranch,
    resolveRepositoryIdentity,
    createBranch(repoDir, branch, fromRef) {
      gitShell(repoDir, ['branch', branch, fromRef]);
    },
    addWorktree(repoDir, wt, branch) {
      gitShell(repoDir, ['worktree', 'add', wt, branch]);
    },
    deleteBranch(repoDir, branch) {
      // Used for best-effort rollback. Soft-degrade.
      try { gitShell(repoDir, ['branch', '-D', branch]); } catch { /* ok */ }
    },
  };
}

/**
 * Default fs portal. Same soft-degrade reasoning as defaultGit().
 */
export function defaultFs() {
  return {
    readPlanFile(path) { return readFileSync(path, 'utf8'); },
    writeBrief(worktreeDir, brief) {
      const dir = join(worktreeDir, '.mc');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'brief.md'), brief, { mode: 0o600 });
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
  if (!opts.planPath) {
    console.error('mc: usage — `mc fanout <plan.md> [--from <ref>] [--tool <tool>] [--dry-run]`');
    return 2;
  }

  return runWithDeps(opts, {
    git: defaultGit(),
    fs: defaultFs(),
    cwd: process.cwd(),
  });
}

/**
 * Implementation core. Exported for in-process tests with injected deps.
 */
export async function runWithDeps(opts, { git, fs, cwd }) {
  // Resolve plan path relative to cwd if not absolute.
  const planAbs = isAbsolute(opts.planPath) ? opts.planPath : resolve(cwd, opts.planPath);

  // Slug derived from filename (sanitised).
  const slugResult = planSlugFromFilename(planAbs);
  if (!slugResult.ok) {
    return emitError(opts, slugResult.error);
  }
  const planSlug = slugResult.slug;

  // Read + parse.
  let planText;
  try {
    planText = fs.readPlanFile(planAbs);
  } catch (err) {
    return emitError(opts, `cannot read plan file ${planAbs}: ${err.message}`);
  }
  const { intro, phases } = parsePhases(planText);
  if (phases.length === 0) {
    return emitError(opts, `no \`## Phase N:\` headings found in ${planAbs}`);
  }

  // Repo + primary worktree probe (needed even for --dry-run so the
  // user gets an early error in a non-repo cwd).
  if (!git.isInsideRepo(cwd)) {
    return emitError(opts, 'not inside a git repository. `mc fanout` requires a repo.');
  }
  const primary = git.primaryWorktree(cwd);
  if (!primary) {
    return emitError(opts, 'could not resolve primary worktree path');
  }
  const repository = typeof git.resolveRepositoryIdentity === 'function'
    ? git.resolveRepositoryIdentity(primary, { createLocal: !opts.dryRun })
    : { ok: false, reason: 'repository-identity-not-injected' };
  if (!repository.ok && !opts.dryRun && typeof git.resolveRepositoryIdentity === 'function') {
    return emitError(opts, `could not establish repository identity (${repository.reason})`);
  }
  const registry = readRegistry({ persistMigration: !opts.dryRun });
  const baseSlug = repoSlug(primary);
  const collide = repository.ok && registry.entries.some((entry) => (
    entry?.repo_slug === baseSlug
      && entry?.repository_id
      && entry.repository_id !== repository.id
  ));
  const slug = repoSlug(primary, {
    collide,
    repositoryId: repository.ok ? repository.id : null,
  });

  const toolResolution = await resolveToolForNew({
    flagValue: opts.tool,
    configLoader: () => readEffectiveConfigForNew({ primary }),
  });
  if (toolResolution.error) {
    return emitError(opts, toolResolution.error);
  }

  const defaultBranch = opts.from ? null : git.resolveDefaultBranch(primary);
  if (!opts.from && !defaultBranch?.ok) {
    return emitError(
      opts,
      `default branch is unknown (${defaultBranch?.reason || 'unavailable'}); pass --from <ref> or run git config --local mc.defaultBranch <branch>`,
    );
  }
  const fromRef = opts.from || defaultBranch.branch;
  const fromGitRef = opts.from || defaultBranch.ref;
  const fromRemote = opts.from ? null : defaultBranch.remote;

  // Build the per-phase plan up front so dry-run and live mode share
  // the same shape. Each entry has everything needed to spawn.
  const planned = phases.map((p) => {
    const sessionName = `fanout-${planSlug}-phase-${p.n}`;
    const branch = `fan/${planSlug}/phase-${p.n}`;
    const wt = worktreePath(primary, sessionName, {
      collide,
      repositoryId: repository.ok ? repository.id : null,
    });
    const brief = buildFanoutBrief({
      planSlug,
      phaseN: p.n,
      phaseTitle: p.title,
      intro,
      body: p.body,
    });
    return {
      phaseN: p.n,
      title: p.title,
      session_name: sessionName,
      branch,
      worktree_path: wt,
      from: fromRef,
      from_git_ref: fromGitRef,
      from_remote: fromRemote,
      tool: toolResolution.tool,
      tool_source: toolResolution.source,
      brief_length: brief.length,
      brief,
    };
  });

  if (opts.dryRun) {
    return emitDryRun(opts, { planSlug, phases: planned, fromRef });
  }

  // Live mode — spawn each phase. We stop on the first failure but
  // surface clearly what we did spawn so the user can `mc gc` or
  // `mc end` partially. This matches the "halt loudly on write
  // failures" policy from defaultGit().
  const spawned = [];
  for (const p of planned) {
    // Collision checks BEFORE any write — exit-before-side-effect.
    if (findEntry(p.session_name, {
      cwd,
      ...(repository.ok ? { repositoryId: repository.id } : {}),
    })) {
      return emitError(opts, `registry already has a session "${p.session_name}" — \`mc end ${p.session_name}\` or rename it first`);
    }
    if (git.branchExists(primary, p.branch)) {
      return emitError(opts, `branch "${p.branch}" already exists — \`mc end\` the existing session first`);
    }
  }

  for (const p of planned) {
    try {
      git.createBranch(primary, p.branch, fromGitRef);
    } catch (err) {
      return emitError(opts, `failed to create branch ${p.branch}: ${err.message}`);
    }
    try {
      mkdirSync(dirname(p.worktree_path), { recursive: true });
      git.addWorktree(primary, p.worktree_path, p.branch);
    } catch (err) {
      // Best-effort branch rollback so we don't leave dead refs.
      git.deleteBranch(primary, p.branch);
      return emitError(opts, `failed to add worktree for ${p.session_name}: ${err.message}`);
    }
    try {
      fs.writeBrief(p.worktree_path, p.brief);
    } catch (err) {
      return emitError(opts, `failed to write brief for ${p.session_name}: ${err.message}`);
    }
    upsertEntry({
      name: p.session_name,
      ...(repository.ok
        ? {
            repository_id: repository.id,
            repository_identity: repositoryIdentityProjection(repository),
          }
        : {}),
      branch: p.branch,
      worktree_path: p.worktree_path,
      repo_slug: slug,
      primary_worktree: primary,
      kind: 'fanout-phase',
      parent_plan: planSlug,
      phase_n: p.phaseN,
      from_ref: fromRef,
      from_git_ref: fromGitRef,
      from_remote: fromRemote,
      tool: p.tool,
      model_chain: [],
      session_state: 'no-session-yet',
      safety_verdict: 'SAFE_TO_END',
    });
    spawned.push(p);
  }

  return emitSuccess(opts, { planSlug, phases: spawned, fromRef });
}

function emitDryRun(opts, { planSlug, phases, fromRef }) {
  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      plan_slug: planSlug,
      from: fromRef,
      phase_count: phases.length,
      phases: phases.map(({ brief, ...rest }) => rest),
    }, null, 2));
    return 0;
  }
  process.stdout.write(`mc fanout — dry run (no sessions spawned)\n\n`);
  process.stdout.write(`Plan slug:    ${planSlug}\n`);
  process.stdout.write(`From ref:     ${fromRef}\n`);
  process.stdout.write(`Phase count:  ${phases.length}\n\n`);
  for (const p of phases) {
    process.stdout.write(`  phase ${p.phaseN}: ${p.title}\n`);
    process.stdout.write(`    session:  ${p.session_name}\n`);
    process.stdout.write(`    branch:   ${p.branch}\n`);
    process.stdout.write(`    worktree: ${p.worktree_path}\n`);
    process.stdout.write(`    tool:     ${p.tool} (${p.tool_source})\n`);
    process.stdout.write(`    brief:    ${p.brief_length} chars\n`);
  }
  return 0;
}

function emitSuccess(opts, { planSlug, phases, fromRef }) {
  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      plan_slug: planSlug,
      from: fromRef,
      phase_count: phases.length,
      phases: phases.map(({ brief, ...rest }) => rest),
    }, null, 2));
    return 0;
  }
  process.stdout.write(`mc fanout — spawned ${phases.length} session${phases.length === 1 ? '' : 's'} for plan "${planSlug}"\n\n`);
  for (const p of phases) {
    process.stdout.write(`  phase ${p.phaseN}: ${p.title}\n`);
    process.stdout.write(`    session:  ${p.session_name}\n`);
    process.stdout.write(`    branch:   ${p.branch}  (from ${fromRef})\n`);
    process.stdout.write(`    worktree: ${p.worktree_path}\n`);
    process.stdout.write(`    tool:     ${p.tool} (${p.tool_source})\n`);
    process.stdout.write(`    brief:    ${p.worktree_path}/.mc/brief.md\n`);
  }
  process.stdout.write(`\nNext:\n`);
  process.stdout.write(`  mc list                              # track session status\n`);
  process.stdout.write(`  mc open <session-name>               # attach to a phase\n`);
  process.stdout.write(`  mc gather ${planSlug}                # collect PRs once phases land\n`);
  return 0;
}

function emitError(opts, msg) {
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  }
  // Always emit to stderr too so non-JSON callers see the failure
  // (pattern: tests cover the human-readable path, not just --json).
  console.error(`mc: ${msg}`);
  return 1;
}

function parseArgs(argv) {
  const opts = { planPath: null, from: null, tool: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') { opts.from = argv[++i]; continue; }
    if (a === '--tool') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { error: '--tool requires a value' };
      opts.tool = next;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TOOL_SUGAR, a)) {
      if (opts.tool && opts.tool !== TOOL_SUGAR[a]) {
        return { error: `conflicting tool flags: --tool ${opts.tool} and ${a}` };
      }
      opts.tool = TOOL_SUGAR[a];
      continue;
    }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('--')) { return { error: `unknown flag: ${a}` }; }
    if (opts.planPath) { return { error: `unexpected positional arg: ${a}` }; }
    opts.planPath = a;
  }
  return opts;
}

function printUsage() {
  console.error('Usage: mc fanout <plan.md> [--from <ref>] [--tool claude|codex|gemini | --claude | --codex] [--dry-run] [--json]');
  console.error('  Parses `## Phase N: <title>` headings and spawns one idle session per phase.');
  console.error('  Each phase gets its own worktree at fan/<plan-slug>/phase-N rooted at --from.');
}
