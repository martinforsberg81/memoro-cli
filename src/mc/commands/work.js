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
import { resolve } from 'node:path';

import {
  addWorktree,
  inspectWorkArea,
  listWorkAreas,
  releaseWorkArea,
} from '../work-area.js';
import { workRoot } from '../paths.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc work\n');
    stderr.write('        mc work add <name> <repo> [branch]\n');
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
      const tools = Object.entries(area.state || {})
        .filter(([, value]) => typeof value === 'string')
        .map(([key]) => key);
      stdout.write(`\n  ${area.name}${tools.length ? `  (${tools.join(', ')})` : ''}\n`);
      for (const worktree of area.worktrees) {
        stdout.write(`    ${describe(worktree)}\n`);
      }
    }
    stdout.write('\n');
    return 0;
  }

  if (opts.verb === 'add') {
    const repo = resolve(opts.repo);
    const result = addWorktree({ name: opts.name, repo, branch: opts.branch });
    if (!result.ok) {
      stderr.write(`mc: could not add ${repo} to ${opts.name} (${result.reason})\n`);
      return 1;
    }
    stdout.write(`mc: ${result.path}${result.branch ? ` on ${result.branch}` : ''}\n`);
    return 0;
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
  const opts = { verb: 'list', name: null, repo: null, branch: null, apply: false, json: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--apply') { opts.apply = true; continue; }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    positional.push(arg);
  }
  if (positional.length === 0) return opts;
  const [verb, ...rest] = positional;
  if (!['add', 'release', 'list'].includes(verb)) {
    return { ...opts, error: `unknown verb: ${verb}` };
  }
  opts.verb = verb;
  if (verb === 'list') return opts;
  opts.name = rest[0] || null;
  if (!opts.name) return { ...opts, error: 'a work-area name is required' };
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(opts.name)) {
    return { ...opts, error: `"${opts.name}" cannot be a directory name` };
  }
  if (verb === 'add') {
    opts.repo = rest[1] || null;
    if (!opts.repo) return { ...opts, error: 'a repository path is required' };
    opts.branch = rest[2] || null;
  }
  return opts;
}
