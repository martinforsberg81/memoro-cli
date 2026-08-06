/**
 * `mc work` — pieces of work as directories under `~/mc`.
 *
 *   mc work                       what exists, derived from disk and git
 *   mc work add <name> <repo> [branch]
 *   mc work release <name> [--apply]
 *
 * Nothing here is stored except the tool conversation. Nothing here refuses:
 * release removes what git says can go and reports what it kept.
 */
import {
  addWorktree,
  createWorkArea,
  inspectWorkArea,
  listWorkAreas,
  releaseWorkArea,
  resolveRepository,
} from '../work-area.js';
import { workRoot } from '../paths.js';
import { openInWorkArea } from '../work-open.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc work\n');
    stderr.write('        mc work new <name>\n');
    stderr.write('        mc work add <name> <repo> [branch]\n');
    stderr.write('        mc work open <name> [session] [--repo <repo>] [--codex|--claude]\n');
    stderr.write('        mc work release <name> [--apply]\n');
    return 2;
  }

  if (opts.verb === 'list') {
    const areas = listWorkAreas();
    if (opts.json) { stdout.write(`${JSON.stringify({ ok: true, root: workRoot(), areas }, null, 2)}\n`); return 0; }
    if (areas.length === 0) {
      stdout.write(`mc: no work areas under ${workRoot()}\n`);
      stdout.write('mc: start one with mc work add <name> <repo> [branch]\n');
      return 0;
    }
    stdout.write(`${workRoot()}\n`);
    for (const area of areas) {
      stdout.write(`\n  ${area.name}\n`);
      for (const worktree of area.worktrees) {
        stdout.write(`    ${describe(worktree)}\n`);
      }
      for (const [session, entry] of Object.entries(area.state?.sessions || {})) {
        stdout.write(`    · ${session}  ${entry.tool}${entry.conversation ? `  ${entry.conversation.slice(0, 8)}` : ''}\n`);
      }
    }
    stdout.write('\n');
    return 0;
  }

  if (opts.verb === 'new') {
    const path = createWorkArea(opts.name);
    stdout.write(`mc: ${path}\n`);
    stdout.write('mc: no worktree — add one with mc work add, or just open it\n');
    return 0;
  }

  if (opts.verb === 'add') {
    const found = resolveRepository(opts.repo);
    if (!found.ok) {
      stderr.write(`mc: no repository "${opts.repo || 'here'}" — looked in:\n`);
      for (const path of found.tried) stderr.write(`      ${path}\n`);
      return 1;
    }
    // Without a branch the work area's own name is the obvious one: the same
    // change across every repository it spans carries the same name.
    const branch = opts.branch || opts.name;
    const result = addWorktree({ name: opts.name, repo: found.path, branch });
    if (!result.ok) {
      stderr.write(`mc: could not add ${repo} to ${opts.name} (${result.reason})\n`);
      return 1;
    }
    stdout.write(`mc: ${result.path}${result.branch ? ` on ${result.branch}` : ''}\n`);
    return 0;
  }

  if (opts.verb === 'open') {
    const area = inspectWorkArea(opts.name);
    if (!area.exists) {
      stderr.write(`mc: no work area named "${opts.name}" under ${workRoot()}\n`);
      return 1;
    }
    // The tool opens where the work is. One worktree and the work is that
    // checkout, so the tool gets it with its git integration intact. Several,
    // or none, and the work is the area itself — mc opens there rather than
    // choosing a checkout on the user's behalf and mentioning it in passing.
    const candidates = area.worktrees.filter((item) => item.is_git);
    const named = opts.repo ? candidates.find((item) => item.repo === opts.repo) : null;
    if (opts.repo && !named) {
      stderr.write(`mc: ${opts.name} has no worktree for ${opts.repo}\n`);
      return 1;
    }
    const worktree = named
      || (candidates.length === 1 ? candidates[0] : { repo: null, path: area.path, is_git: false });
    stderr.write(`mc: ${worktree.path}\n`);
    const opened = openInWorkArea({
      name: opts.name,
      session: opts.session,
      worktree,
      tool: opts.tool,
    });
    if (!opened.ok) {
      stderr.write(`mc: could not open ${opts.name} (${opened.reason})\n`);
      if (opened.hint) stderr.write(`mc: ${opened.hint}\n`);
      return 1;
    }
    if (opened.conversation && !opened.resumed) {
      stderr.write(`mc: ${opened.session} is a new ${opened.tool} conversation\n`);
    }
    return opened.code || 0;
  }

  const area = inspectWorkArea(opts.name);
  if (!area.exists) {
    stderr.write(`mc: no work area named "${opts.name}" under ${workRoot()}\n`);
    return 1;
  }
  const result = releaseWorkArea(opts.name, { dryRun: !opts.apply });
  if (opts.json) { stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`); return 0; }
  stdout.write(`mc work release ${opts.name}${opts.apply ? '' : ' — dry run'}\n`);
  for (const item of result.removed) {
    stdout.write(`  ${opts.apply ? 'removed' : 'would remove'}  ${item.repo}${item.branch ? ` (${item.branch})` : ''}\n`);
  }
  for (const item of result.kept) {
    stdout.write(`  kept     ${item.repo}${item.branch ? ` (${item.branch})` : ''} — ${item.why}\n`);
  }
  if (!result.removed.length && !result.kept.length) stdout.write('  nothing to release\n');
  if (!opts.apply) stdout.write('\nRun again with --apply.\n');
  return 0;
}

function describe(worktree) {
  if (!worktree.is_git) return `${worktree.repo}  (not a git worktree)`;
  const marks = [];
  if (worktree.uncommitted) marks.push(`${worktree.uncommitted} uncommitted`);
  if (worktree.unmerged_commits) marks.push(`${worktree.unmerged_commits} unmerged`);
  return `${worktree.repo}  ${worktree.branch || '(detached)'}${marks.length ? `  [${marks.join(', ')}]` : ''}`;
}

export function parseArgs(argv) {
  const opts = {
    verb: 'list', name: null, repo: null, branch: null, session: 'main',
    tool: null, apply: false, json: false, repoFlagNext: false,
  };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--apply') { opts.apply = true; continue; }
    if (arg === '--repo') { opts.repoFlagNext = true; continue; }
    if (arg === '--codex') { opts.tool = 'codex'; continue; }
    if (arg === '--claude') { opts.tool = 'claude'; continue; }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.repoFlagNext) { opts.repo = arg; opts.repoFlagNext = false; continue; }
    positional.push(arg);
  }
  if (positional.length === 0) return opts;
  const [verb, ...rest] = positional;
  if (!['add', 'release', 'list', 'open', 'new'].includes(verb)) {
    return { ...opts, error: `unknown verb: ${verb}` };
  }
  opts.verb = verb;
  if (verb === 'list') return opts;
  opts.name = rest[0] || null;
  if (!opts.name) return { ...opts, error: 'a work-area name is required' };
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(opts.name)) {
    return { ...opts, error: `"${opts.name}" cannot be a directory name` };
  }
  if (verb === 'new') return opts;
  if (verb === 'open') {
    opts.session = rest[1] || 'main';
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(opts.session)) {
      return { ...opts, error: `"${opts.session}" cannot be a session name` };
    }
    return opts;
  }
  if (verb === 'add') {
    opts.repo = rest[1] || null;
    opts.branch = rest[2] || null;
  }
  return opts;
}
