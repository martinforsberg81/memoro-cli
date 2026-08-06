/**
 * `mc work` — pieces of work as directories under `~/mc`.
 *
 *   mc work                       what exists, derived from disk, git and the tools
 *   mc work <name>                open it — the most recent conversation here
 *   mc work <name> new            a new conversation
 *   mc work <name> <id>           that conversation, by the id `mc work` shows
 *   mc work add <name> <repo> [branch]
 *   mc work remove <name> <repo>
 *   mc work release <name> [--apply]
 *   mc work discard <name> [repo] [--apply]
 *
 * Nothing here is stored. Nothing here refuses: opening a name that does not
 * exist yet makes it, release removes what git says can go and reports what it
 * kept, and discard says what it is about to destroy before it does.
 */
import {
  addWorktree,
  createWorkArea,
  inspectWorkArea,
  listWorkAreas,
  discardWorkArea,
  releaseWorkArea,
  removeWorktree,
  resolveRepository,
} from '../work-area.js';
import { describeAge, describeSize } from '../conversations.js';
import { workRoot } from '../paths.js';
import { openInWorkArea } from '../work-open.js';

const VERBS = ['add', 'remove', 'release', 'discard', 'list'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc work\n');
    stderr.write('        mc work <name> [new | <conversation id>] [--repo <repo>] [--codex|--claude]\n');
    stderr.write('        mc work add <name> <repo> [branch]\n');
    stderr.write('        mc work remove <name> <repo>\n');
    stderr.write('        mc work release <name> [--apply]\n');
    stderr.write('        mc work discard <name> [repo] [--apply]\n');
    return 2;
  }

  if (opts.verb === 'list') {
    const areas = listWorkAreas();
    if (opts.json) { stdout.write(`${JSON.stringify({ ok: true, root: workRoot(), areas }, null, 2)}\n`); return 0; }
    if (areas.length === 0) {
      stdout.write(`mc: nothing under ${workRoot()} yet\n`);
      stdout.write('mc: start something with mc work add <name> <repo>\n');
      return 0;
    }
    stdout.write(`${workRoot()}\n`);
    for (const area of areas) {
      stdout.write(`\n  ${area.name}\n`);
      for (const worktree of area.worktrees) {
        stdout.write(`    ${describe(worktree)}\n`);
      }
      for (const item of area.conversations) {
        stdout.write(`    · ${item.id.slice(0, 8)}  ${item.tool.padEnd(11)} ${describeAge(item.updated_ms).padEnd(9)} ${describeSize(item.bytes)}\n`);
      }
    }
    stdout.write('\n');
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
      stderr.write(`mc: could not add ${found.path} to ${opts.name} (${result.reason})\n`);
      return 1;
    }
    stdout.write(`mc: ${result.path}${result.branch ? ` on ${result.branch}` : ''}\n`);
    return 0;
  }

  if (opts.verb === 'discard') {
    const area = inspectWorkArea(opts.name);
    if (!area.exists) {
      stderr.write(`mc: nothing called "${opts.name}" under ${workRoot()}\n`);
      return 1;
    }
    const result = discardWorkArea(opts.name, { repo: opts.repo, dryRun: !opts.apply });
    if (opts.json) { stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`); return 0; }
    stdout.write(`mc work discard ${opts.name}${opts.apply ? '' : ' — dry run'}\n`);
    for (const item of result.discarded) {
      const loses = [];
      if (item.uncommitted) loses.push(`${item.uncommitted} uncommitted`);
      if (item.unmerged_commits) loses.push(`${item.unmerged_commits} unmerged`);
      stdout.write(`  ${opts.apply ? 'destroyed' : 'would destroy'}  ${item.repo}${item.branch ? ` (${item.branch})` : ''}${loses.length ? ` — losing ${loses.join(', ')}` : ''}\n`);
    }
    // A conversation is not in git. Nothing brings it back, so it is named
    // one by one rather than counted.
    for (const item of result.conversations) {
      stdout.write(`  ${opts.apply ? 'destroyed' : 'would destroy'}  ${item.tool} ${item.id.slice(0, 8)} — ${describeSize(item.bytes)}, ${describeAge(item.updated_ms)}\n`);
    }
    for (const item of result.conversations_failed || []) {
      stdout.write(`  kept       ${item.tool} ${item.id.slice(0, 8)} — ${item.reason}\n`);
    }
    for (const item of result.kept) {
      stdout.write(`  kept       ${item.repo} — ${item.why}\n`);
    }
    if (result.removes_area) {
      stdout.write(`  ${opts.apply ? 'removed' : 'would remove'}    the work area itself\n`);
    }
    if (!result.discarded.length && !result.kept.length && !result.conversations.length) {
      stdout.write('  nothing there\n');
    }
    if (!opts.apply) stdout.write('\nThis destroys work. Run again with --apply if that is what you want.\n');
    return 0;
  }

  if (opts.verb === 'remove') {
    const result = removeWorktree({ name: opts.name, repo: opts.repo });
    if (!result.ok) {
      stderr.write(`mc: kept ${opts.repo} in ${opts.name} — ${result.reason}\n`);
      return 1;
    }
    stdout.write(`mc: removed ${opts.repo} from ${opts.name}\n`);
    if (result.branch_kept) stdout.write(`mc: kept branch ${result.branch} — it has unmerged commits\n`);
    return 0;
  }

  if (opts.verb === 'release') {
    const area = inspectWorkArea(opts.name);
    if (!area.exists) {
      stderr.write(`mc: nothing called "${opts.name}" under ${workRoot()}\n`);
      return 1;
    }
    const result = releaseWorkArea(opts.name, { dryRun: !opts.apply });
    if (opts.json) { stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`); return 0; }
    stdout.write(`mc work release ${opts.name}${opts.apply ? '' : ' — dry run'}\n`);
    for (const item of result.removed) {
      stdout.write(`  ${opts.apply ? 'removed' : 'would remove'}  ${item.repo}${item.branch ? ` (${item.branch})` : ''}\n`);
    }
    for (const item of result.conversations) {
      stdout.write(`  ${opts.apply ? 'removed' : 'would remove'}  ${item.tool} ${item.id.slice(0, 8)} — ${describeSize(item.bytes)}, ${describeAge(item.updated_ms)}\n`);
    }
    for (const item of result.kept) {
      stdout.write(`  kept     ${item.repo}${item.branch ? ` (${item.branch})` : ''} — ${item.why}\n`);
    }
    if (!result.removed.length && !result.kept.length) stdout.write('  nothing to release\n');
    if (!opts.apply) stdout.write('\nRun again with --apply.\n');
    return 0;
  }

  // Open. A name nobody has used yet is not a mistake to report — it is the
  // start of something, so mc makes the directory and says where it is.
  let area = inspectWorkArea(opts.name);
  if (!area.exists) {
    createWorkArea(opts.name);
    stderr.write(`mc: new — ${workRoot()}/${opts.name}\n`);
    area = inspectWorkArea(opts.name);
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
    areaRoot: area.path,
    worktree,
    tool: opts.tool,
    pick: opts.pick,
  });
  if (!opened.ok) {
    stderr.write(`mc: could not open ${opts.name} (${opened.reason})\n`);
    if (opened.hint) stderr.write(`mc: ${opened.hint}\n`);
    return 1;
  }
  // Neither tool saves anything until the first turn. Saying so is the
  // difference between mc losing something and there being nothing to lose.
  if (opened.kept_nothing) {
    stderr.write(`mc: ${opened.tool} saved no conversation — nothing was said\n`);
  } else if (opened.started) {
    stderr.write(`mc: new ${opened.tool} conversation ${opened.started.slice(0, 8)}\n`);
  }
  return opened.code || 0;
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
    verb: 'list', name: null, repo: null, branch: null, pick: null,
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
  const [head, ...rest] = positional;

  // A first word that is not a verb is the name of a piece of work. Requiring
  // `open` was mc's grammar rather than the user's, and answering a name with
  // a usage list is a refusal in a different costume.
  if (!VERBS.includes(head)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(head)) {
      return { ...opts, error: `"${head}" cannot be a directory name` };
    }
    return { ...opts, verb: 'open', name: head, pick: rest[0] || null };
  }

  opts.verb = head;
  if (head === 'list') return opts;
  opts.name = rest[0] || null;
  if (!opts.name) return { ...opts, error: 'which piece of work?' };
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(opts.name)) {
    return { ...opts, error: `"${opts.name}" cannot be a directory name` };
  }
  if (head === 'discard') {
    opts.repo = opts.repo || rest[1] || null;
    return opts;
  }
  if (head === 'remove') {
    opts.repo = opts.repo || rest[1] || null;
    if (!opts.repo) return { ...opts, error: 'which repository? mc work remove <name> <repo>' };
    return opts;
  }
  if (head === 'add') {
    opts.repo = rest[1] || null;
    opts.branch = rest[2] || null;
  }
  return opts;
}
