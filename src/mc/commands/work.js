/**
 * `mc work` — pieces of work as directories under `~/mc`.
 *
 * Run it with nothing and it shows what exists and asks what you want. That is
 * the way in: the verbs below still work, and are still what a script or a
 * habit reaches for, but nobody has to know them to use mc.
 *
 *   mc work                       what exists — and, at a terminal, a way in
 *   mc work <name>                open it, asking only what it cannot know
 *   mc work <name> new            a new conversation
 *   mc work <name> <id>           one particular conversation
 *   mc work add <name> <repo> [branch]
 *   mc work remove <name> <repo>
 *   mc work release <name> [--apply]
 *   mc work discard <name> [repo] [--apply]
 *
 * The directory is the session name, always: `~/mc/<name>`, with a worktree
 * under it per repository, on a branch of that same name. There is no second
 * naming scheme to learn and nothing derived from a branch.
 *
 * Nothing here is stored. Nothing here refuses: opening a name that does not
 * exist yet makes it, release removes what git says can go and reports what it
 * kept, and discard says what it is about to destroy before it does.
 */
import {
  addWorktree,
  createWorkArea,
  inspectWorkArea,
  knownRepositories,
  listWorkAreas,
  discardWorkArea,
  releaseWorkArea,
  removeWorktree,
  resolveRepository,
} from '../work-area.js';
import { describeAge, describeSize } from '../conversations.js';
import { interactive, ask, select } from '../prompt.js';
import { workRoot } from '../paths.js';
import { openInWorkArea } from '../work-open.js';

const VERBS = ['add', 'remove', 'release', 'discard', 'list'];
const NAME = /^[A-Za-z0-9._-]{1,64}$/u;

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
    // A pipe, a script and `--json` see exactly what they always saw. A person
    // at a terminal is asked instead of being handed a grammar to memorise.
    if (interactive()) return menu(areas, { stdout, stderr });
    if (areas.length === 0) {
      stdout.write(`mc: nothing under ${workRoot()} yet\n`);
      stdout.write('mc: start something with mc work add <name> <repo>\n');
      return 0;
    }
    stdout.write(`${workRoot()}\n`);
    for (const area of areas) {
      stdout.write(`\n  ${area.name}\n`);
      for (const worktree of area.worktrees) stdout.write(`    ${describe(worktree)}\n`);
      for (const item of area.conversations) stdout.write(`    · ${conversationLine(item)}\n`);
    }
    stdout.write('\n');
    return 0;
  }

  if (opts.verb === 'open') return openArea(opts.name, opts, { stdout, stderr });
  return runVerb(opts, { stdout, stderr });
}

/**
 * The verbs, reachable from the command line and from the menu alike.
 *
 * Someone standing at the menu who already knows what they want types it,
 * because that is what a prompt invites. The first time that happened mc read
 * `mc work discard language-grammar-expansion`, matched none of its numbers,
 * and exited without a word — leaving a listing that looked like the command
 * had run and done nothing.
 */
async function runVerb(opts, { stdout, stderr }) {
  if (opts.verb === 'add') {
    const found = resolveRepository(opts.repo);
    if (!found.ok) {
      stderr.write(`mc: no repository "${opts.repo || 'here'}" — looked in:\n`);
      for (const path of found.tried) stderr.write(`      ${path}\n`);
      return 1;
    }
    // Without a branch the work's own name is the branch: one name for the
    // piece of work, the directory it lives in, and the branch it is on.
    const result = addWorktree({ name: opts.name, repo: found.path, branch: opts.branch || opts.name });
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
    if (!result.discarded.length && !result.kept.length
      && !result.conversations.length && !result.removes_area) {
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

  return 2;
}


/**
 * The way in.
 *
 * What exists, numbered, and one more line for starting something. No verb, no
 * order of arguments, nothing to have read first.
 *
 * It also takes a whole command, because a prompt invites one and the verbs
 * are the same verbs. `mc work discard x`, `discard x`, `discard x --apply` —
 * the leading `mc` and `work` are stripped and the rest is read exactly as it
 * would have been from the shell. Anything else is said out loud rather than
 * swallowed, and the listing is shown again with whatever changed.
 */
async function menu(first, { stdout, stderr }) {
  let areas = first;
  for (;;) {
    stdout.write(`\n${workRoot()}\n\n`);
    if (areas.length === 0) {
      stdout.write('  nothing here yet\n\n');
      return startSomething({ stdout, stderr });
    }
    for (const [index, area] of areas.entries()) {
      stdout.write(`  ${String(index + 1).padStart(2)}  ${area.name.padEnd(28)} ${summarise(area)}\n`);
    }
    stdout.write(`  ${'n'.padStart(2)}  start something new\n`);
    stdout.write(`  ${'q'.padStart(2)}  quit\n\n`);

    const answer = ask('>', { stdout });
    if (!answer || answer === 'q') return 0;
    if (answer === 'n' || answer === 'new') return startSomething({ stdout, stderr });

    const byNumber = areas[Number(answer) - 1];
    const byName = areas.find((area) => area.name === answer);
    if (byNumber || byName) return openArea((byNumber || byName).name, {}, { stdout, stderr });

    const outcome = await typed(answer, areas, { stdout, stderr });
    if (outcome !== null) return outcome;
    areas = listWorkAreas();
  }
}

/**
 * A line typed at the menu. Returns an exit code to leave on, or null to show
 * the listing again.
 */
async function typed(answer, areas, { stdout, stderr }) {
  const words = answer.split(/\s+/u).filter(Boolean);
  if (words[0] === 'mc') words.shift();
  if (words[0] === 'work') words.shift();
  if (words.length === 0) return null;

  const sub = parseArgs(words);
  if (sub.error) {
    stderr.write(`\nmc: ${sub.error}\n`);
    return null;
  }
  // A bare word that is not on the list is a typo far more often than it is a
  // new piece of work, and the list is right there to compare it against. From
  // the shell the same word still starts something, because there the name is
  // the whole statement of intent.
  if (sub.verb === 'open' && words.length === 1 && !areas.some((area) => area.name === sub.name)) {
    stderr.write(`\nmc: nothing here called "${sub.name}" — n starts one\n`);
    return null;
  }
  if (sub.verb === 'open') return openArea(sub.name, sub, { stdout, stderr });
  if (sub.verb === 'list') return null;
  stdout.write('\n');
  await runVerb(sub, { stdout, stderr });
  return null;
}

function summarise(area) {
  const parts = area.worktrees.map((worktree) => {
    if (!worktree.is_git) return worktree.repo;
    const marks = [];
    if (worktree.uncommitted) marks.push(`${worktree.uncommitted} uncommitted`);
    if (worktree.unmerged_commits) marks.push(`${worktree.unmerged_commits} unmerged`);
    return `${worktree.repo}${marks.length ? ` (${marks.join(', ')})` : ''}`;
  });
  const conversations = area.conversations.length;
  if (conversations) {
    parts.push(`${conversations} conversation${conversations === 1 ? '' : 's'}`);
  }
  return parts.length ? parts.join('  ·  ') : 'empty';
}

/**
 * A name, a repository, and mc does the rest: the directory, the worktree and
 * the branch all take the name, so there is only ever one thing to invent.
 */
async function startSomething({ stdout, stderr }) {
  const name = ask('name it:', { stdout });
  if (!name) return 0;
  if (!NAME.test(name)) {
    stderr.write(`mc: "${name}" cannot be a directory name\n`);
    return 1;
  }
  if (inspectWorkArea(name).exists) {
    stderr.write(`mc: ${name} already exists — opening it\n`);
    return openArea(name, {}, { stdout, stderr });
  }

  const repos = knownRepositories();
  let repo = repos.length === 1 ? repos[0] : null;
  if (repos.length > 1) {
    const items = repos.map((path, index) => ({
      key: index + 1,
      name: path.split('/').pop(),
      label: path.split('/').pop(),
      value: path,
    }));
    items.push({ key: 'x', name: 'none', label: 'no repository — just a place to work', value: 'none' });
    repo = select('\nwhich repository?', items, { stdout });
    if (!repo) return 0;
  }

  if (repo && repo !== 'none') {
    const result = addWorktree({ name, repo, branch: name });
    if (!result.ok) {
      stderr.write(`mc: could not add ${repo} to ${name} (${result.reason})\n`);
      return 1;
    }
    stdout.write(`\nmc: ${result.path} on ${result.branch}\n`);
  } else {
    stdout.write(`\nmc: ${createWorkArea(name)}\n`);
  }
  return openArea(name, {}, { stdout, stderr });
}

/**
 * Open a piece of work, asking only what mc genuinely cannot know.
 *
 * One conversation is opened rather than offered. One repository is used
 * rather than listed. A flag or an argument answers any of it in advance.
 */
async function openArea(name, opts, { stdout, stderr }) {
  let area = inspectWorkArea(name);
  if (!area.exists) {
    createWorkArea(name);
    stderr.write(`mc: new — ${workRoot()}/${name}\n`);
    area = inspectWorkArea(name);
  }

  // The tool opens where the work is. One worktree and the work is that
  // checkout, so the tool gets it with its git integration intact. Several,
  // and mc asks rather than choosing on the user's behalf and mentioning it in
  // passing. None, and the work is the area itself.
  const candidates = area.worktrees.filter((item) => item.is_git);
  let worktree = opts.repo ? candidates.find((item) => item.repo === opts.repo) : null;
  if (opts.repo && !worktree) {
    stderr.write(`mc: ${name} has no worktree for ${opts.repo}\n`);
    return 1;
  }
  if (!worktree && candidates.length === 1) [worktree] = candidates;
  if (!worktree && candidates.length > 1 && interactive()) {
    worktree = select(`\n${name} — which repository?`, candidates.map((item, index) => ({
      key: index + 1,
      name: item.repo,
      label: `${item.repo.padEnd(20)} ${item.branch || '(detached)'}`,
      value: item,
    })), { stdout });
    if (!worktree) return 0;
  }
  if (!worktree) worktree = { repo: null, path: area.path, is_git: false };

  // Several conversations is the one thing mc cannot guess. One is not a
  // question, and neither is none.
  let pick = opts.pick;
  if (!pick && area.conversations.length > 1 && interactive()) {
    const items = area.conversations.map((item, index) => ({
      key: index + 1,
      name: item.id.slice(0, 8),
      label: conversationLine(item),
      value: item.id,
    }));
    items.push({ key: 'n', name: 'new', label: 'a new conversation', value: 'new' });
    pick = select(`\n${name} — which conversation?`, items, { stdout });
    if (!pick) return 0;
  }

  // A piece of work nobody has opened yet has no tool to inherit, so that is
  // asked once, here, rather than defaulting quietly to one of them.
  let tool = opts.tool;
  if (!tool && area.conversations.length === 0 && interactive()) {
    tool = select(`\n${name} — which tool?`, [
      { key: 1, name: 'claude', label: 'claude', value: 'claude' },
      { key: 2, name: 'codex', label: 'codex', value: 'codex' },
    ], { stdout });
    if (!tool) return 0;
  }

  stderr.write(`mc: ${worktree.path}\n`);
  const opened = openInWorkArea({ areaRoot: area.path, worktree, tool, pick });
  if (!opened.ok) {
    stderr.write(`mc: could not open ${name} (${opened.reason})\n`);
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

function conversationLine(item) {
  return `${item.id.slice(0, 8)}  ${item.tool.padEnd(11)} ${describeAge(item.updated_ms).padEnd(9)} ${describeSize(item.bytes)}`;
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
    if (!NAME.test(head)) return { ...opts, error: `"${head}" cannot be a directory name` };
    return { ...opts, verb: 'open', name: head, pick: rest[0] || null };
  }

  opts.verb = head;
  if (head === 'list') return opts;
  opts.name = rest[0] || null;
  if (!opts.name) return { ...opts, error: 'which piece of work?' };
  if (!NAME.test(opts.name)) return { ...opts, error: `"${opts.name}" cannot be a directory name` };
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
