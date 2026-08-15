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
 *   mc work send <name> "<message>"  a message into its inbox, and a nudge
 *   mc work add <name> <repo> [branch] [--from <ref>]
 *   mc work stop <name>              stop what is running; keep the work
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
import { sendToArea } from '../work-send.js';
import { stopWork } from '../work-stop.js';
import { interactive, ask, select } from '../prompt.js';
import { workRoot } from '../paths.js';
import {
  areaRole, areaRoleName, reservedRoleHint, reservedRoleName,
} from '../roles.js';
import { scanArgs } from './flags.js';
import {
  attachBackground, backgroundTarget, clearTrustDialog, openInWorkArea, startInBackground,
} from '../work-open.js';

const VERBS = ['add', 'remove', 'release', 'discard', 'stop', 'list', 'send'];
const NAME = /^[A-Za-z0-9._-]{1,64}$/u;

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc work\n');
    stderr.write('        mc work <name> [new | <conversation id>] [--repo <repo>] [--codex|--claude] [--model <model>]\n');
    stderr.write('        mc work send <name> "<message>" [--json]\n');
    stderr.write('        mc work add <name> <repo> [branch] [--from <ref>]\n');
    stderr.write('        mc work remove <name> <repo>\n');
    stderr.write('        mc work stop <name>\n');
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
  // The file first, the waking second. Once the message is in the recipient's
  // inbox the send has succeeded — a conversation that is not running, or one
  // that will not take the keystroke, costs the recipient latency and never
  // costs the sender the message.
  if (opts.verb === 'send') {
    const result = sendToArea({ name: opts.name, message: opts.message });
    if (!result.ok) {
      stderr.write(`mc: nothing called "${opts.name}" under ${workRoot()}\n`);
      return 1;
    }
    if (opts.json) {
      stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return 0;
    }
    stdout.write(`mc: ${result.file}\n`);
    if (result.woke) {
      stdout.write(`mc: woke ${opts.name} — it has been told to read its inbox\n`);
    } else if (result.reason === 'no-live-conversation') {
      stdout.write(`mc: nothing is running in ${opts.name} — it reads its inbox when it starts\n`);
    } else {
      stdout.write(`mc: delivered to the inbox, but could not wake it (${result.reason})\n`);
    }
    return 0;
  }

  if (opts.verb === 'add') {
    // The reserved names never become areas, so there is nothing to add to —
    // and letting `add` conjure one up would be the back door the open-path
    // guard just closed. An area that predates the reservation keeps working
    // (same carve-out as opening it).
    if (reservedRoleName(opts.name)) {
      const area = inspectWorkArea(opts.name, undefined, { conversations: false, git: false });
      if (!area.exists || areaRoleName(area.path)) {
        stderr.write(`mc: ${reservedRoleHint(opts.name)}\n`);
        return 1;
      }
    }
    const found = resolveRepository(opts.repo);
    if (!found.ok) {
      stderr.write(`mc: no repository "${opts.repo || 'here'}" — looked in:\n`);
      for (const path of found.tried) stderr.write(`      ${path}\n`);
      return 1;
    }
    // Without a branch the work's own name is the branch: one name for the
    // piece of work, the directory it lives in, and the branch it is on.
    const result = addWorktree({
      name: opts.name, repo: found.path, branch: opts.branch || opts.name, from: opts.from,
    });
    if (!result.ok) {
      stderr.write(`mc: could not add ${found.path} to ${opts.name} (${result.reason})\n`);
      return 1;
    }
    // Where it started from is worth a line. A work area that quietly began
    // 35 commits behind cost a session an afternoon of tests that failed for
    // a reason that had nothing to do with its work.
    stdout.write(`mc: ${result.path}${result.branch ? ` on ${result.branch}` : ''}\n`);
    if (result.base) stdout.write(`mc: from ${result.base}\n`);
    if (result.base_note) stderr.write(`mc: ${result.base_note}\n`);
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
      stdout.write(`  ${opts.apply ? 'destroyed' : 'would destroy'}  ${conversationLine(item)}\n`);
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
    if (!opts.apply) stdout.write(`\n${stakes(result, opts.name)}\n`);
    return 0;
  }

  if (opts.verb === 'stop') {
    const area = inspectWorkArea(opts.name);
    if (!area.exists) {
      stderr.write(`mc: nothing called "${opts.name}" under ${workRoot()}\n`);
      return 1;
    }
    const result = stopWork(area);
    if (opts.json) { stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`); return 0; }
    for (const item of result.stopped) {
      stdout.write(item.kind === 'background'
        ? `mc: stopped ${item.target}${item.graceful ? '' : ' — it did not leave on its own, so it was killed'}\n`
        : `mc: stopped ${item.name} (pid ${item.pid})\n`);
    }
    for (const item of result.kept) {
      stdout.write(`mc: left ${item.name} (pid ${item.pid}) — ${item.why}\n`);
    }
    if (!result.stopped.length && !result.kept.length) {
      stdout.write(`mc: nothing is running in ${opts.name}\n`);
    } else {
      // Saying what survives is the point: this is not discard, and someone
      // who confuses the two loses a branch.
      stdout.write(`mc: the work is untouched — mc work ${opts.name} picks it up again\n`);
    }
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
      stdout.write(`  ${opts.apply ? 'removed' : 'would remove'}  ${conversationLine(item)}\n`);
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
      const room = Math.max(40, (stdout.columns || 100) - 36);
      stdout.write(`  ${String(index + 1).padStart(2)}  ${area.name.padEnd(28)} ${summarise(area, room)}\n`);
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

/**
 * One line about a piece of work, cut to the terminal it is being read in.
 *
 * The opening line of a conversation is the most useful thing on this row and
 * the most variable in length, so it is what gives way when there is no room —
 * a row that wraps is worse than one that ends in an ellipsis.
 */
function summarise(area, room = 60) {
  const parts = area.worktrees.map((worktree) => {
    if (!worktree.is_git) return worktree.repo;
    const marks = [];
    if (worktree.uncommitted) marks.push(`${worktree.uncommitted} uncommitted`);
    if (worktree.unmerged_commits) marks.push(`${worktree.unmerged_commits} unmerged`);
    return `${worktree.repo}${marks.length ? ` (${marks.join(', ')})` : ''}`;
  });
  // One conversation says what it is about; several are counted, because the
  // point of the number is to tell you a choice is waiting.
  const [only] = area.conversations;
  if (area.conversations.length > 1) {
    parts.push(`${area.conversations.length} conversations`);
  } else if (only) {
    const spare = Math.max(16, room - parts.join('  ·  ').length - 5);
    const text = only.label || `1 ${only.tool} conversation`;
    parts.push(text.length > spare ? `${text.slice(0, spare - 1)}…` : text);
  }
  return parts.length ? parts.join('  ·  ') : 'empty';
}

/**
 * A name, a repository, and mc does the rest: the directory, the worktree and
 * the branch all take the name, so there is only ever one thing to invent.
 */
/**
 * Which repository is this work in?
 *
 * Returns a path, the string `none`, or null if the question was not answered.
 * One repository is used rather than asked about; several are offered.
 */
function chooseRepository({ stdout }) {
  const repos = knownRepositories();
  if (repos.length === 1) return repos[0];
  if (repos.length === 0) return 'none';
  const items = repos.map((path, index) => ({
    key: index + 1,
    name: path.split('/').pop(),
    label: path.split('/').pop(),
    value: path,
  }));
  items.push({ key: 'x', name: 'none', label: 'no repository — just a place to work', value: 'none' });
  return select('\nwhich repository?', items, { stdout });
}

async function startSomething({ stdout, stderr }) {
  const name = ask('name it:', { stdout });
  if (!name) return 0;
  if (!NAME.test(name)) {
    stderr.write(`mc: "${name}" cannot be a directory name\n`);
    return 1;
  }
  // The same guard the shell path has: without it, the menu would create the
  // area first and then refuse to open it forever.
  if (reservedRoleName(name) && !inspectWorkArea(name).exists) {
    stderr.write(`mc: ${reservedRoleHint(name)}\n`);
    return 1;
  }
  if (inspectWorkArea(name).exists) {
    stderr.write(`mc: ${name} already exists — opening it\n`);
    return openArea(name, {}, { stdout, stderr });
  }

  const repo = chooseRepository({ stdout });
  if (repo === null) return 0;

  if (repo !== 'none') {
    const result = addWorktree({ name, repo, branch: name });
    if (!result.ok) {
      stderr.write(`mc: could not add ${repo} to ${name} (${result.reason})\n`);
      return 1;
    }
    stdout.write(`\nmc: ${result.path} on ${result.branch}\n`);
    if (result.base) stdout.write(`mc: from ${result.base}\n`);
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
export async function openArea(name, opts, { stdout, stderr }) {
  // The role workspaces have their own doors (`mc pm`, `mc pm-helper`);
  // opening them here would start a conversation without the role's overlay
  // and semantics, wearing the role's name. Designed difference, not
  // convention — so it refuses by name before anything is created. The one
  // carve-out is an area that already existed before the names were
  // reserved: refusing it would strand real work behind its own name, so it
  // opens as the ordinary area it is, with a note to rename it.
  let area = inspectWorkArea(name);
  if (reservedRoleName(name)) {
    if (!area.exists || areaRoleName(area.path)) {
      stderr.write(`mc: ${reservedRoleHint(name)}\n`);
      return 1;
    }
    stderr.write(`mc: "${name}" is now a reserved role name — this pre-existing area opens as ordinary work; consider renaming it\n`);
  }
  if (!area.exists) {
    // A name nobody has used yet is the start of something, and the first
    // thing it needs is somewhere to work. Typing the name went straight past
    // that question and opened a tool in an empty directory: the session
    // reported "the directory is empty — no repo, no files" and could do
    // nothing at all with what it was asked. The menu asked; the shortcut
    // everyone uses did not.
    createWorkArea(name);
    stderr.write(`mc: ${name} is new\n`);
    const repo = interactive() ? chooseRepository({ stdout }) : 'none';
    if (repo === null) return 0;
    if (repo !== 'none') {
      const added = addWorktree({ name, repo, branch: name });
      if (!added.ok) {
        stderr.write(`mc: could not add ${repo} to ${name} (${added.reason})\n`);
        return 1;
      }
      stdout.write(`mc: ${added.path} on ${added.branch}\n`);
      if (added.base) stdout.write(`mc: from ${added.base}\n`);
    } else {
      stdout.write(`mc: ${workRoot()}/${name} — no repository, so nothing to read here\n`);
    }
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

  // The role this area carries, if any. Everything started here inherits its
  // overlay and model default; an area without a mark inherits nothing. A
  // marked area whose definition has gone missing still opens — blocking the
  // work over a mislaid file helps nobody — but says out loud that the
  // overlay is not being delivered, because a role session silently running
  // without its role is the failure mode this whole design exists to avoid.
  const role = areaRole(area.path);
  if (role?.missing) {
    stderr.write(`mc: this area carries the role "${role.name}" but no definition was found at ${role.path}\n`);
    stderr.write('mc: opening without the role overlay\n');
  }
  const overlay = role?.missing ? null : role?.overlay || null;
  const roleModel = role?.missing ? null : role?.model || null;

  // A piece of work nobody has opened yet has no tool to inherit, so that is
  // asked once, here, rather than defaulting quietly to one of them. In a
  // role's area the role has already answered that first question: its first
  // listed tool is the one the overlay is written for. Only that first
  // question — once conversations exist, the last-used tool wins exactly as
  // it always has, or a resume would quietly switch tools and orphan the
  // conversation it was asked to continue.
  let tool = opts.tool;
  const roleTool = role && !role.missing ? role.tools?.[0] || null : null;
  if (!tool && roleTool && area.conversations.length === 0) tool = roleTool;
  if (!tool && area.conversations.length === 0 && interactive()) {
    tool = select(`\n${name} — which tool?`, [
      { key: 1, name: 'claude', label: 'claude', value: 'claude' },
      { key: 2, name: 'codex', label: 'codex', value: 'codex' },
    ], { stdout });
    if (!tool) return 0;
  }

  if (opts.tmux) {
    // `tool` already carries the flag, the role's preference, or the answer
    // the user just gave at the prompt — starting on anything else would be
    // ignoring them; 'claude' remains the last resort it always was.
    const started = startInBackground({
      name, areaRoot: area.path, worktree, tool: tool || roleTool || 'claude', task: opts.task, model: opts.model,
      overlay, defaultModel: roleModel, defaultModelTool: roleTool,
    });
    if (!started.ok) {
      stderr.write(started.reason === 'already-running'
        ? `mc: ${name} is already running in the background (${started.target})\n`
        : `mc: could not start ${name} in the background (${started.reason})\n`);
      if (started.hint) stderr.write(`mc: ${started.hint}\n`);
      return 1;
    }
    const trust = clearTrustDialog(started.target);
    stdout.write(`mc: ${name} is running in the background as ${started.target}\n`);
    if (trust.answered) stdout.write('mc: answered Claude\'s folder-trust question for it\n');
    if (!opts.task) stdout.write('mc: it has no task — send it one, or it will sit there\n');
    stdout.write(`mc: watch with  mc status\n`);
    stdout.write(`mc: talk to it  tmux send-keys -t ${started.target} "..." Enter\n`);
    // The one way in that is not a tmux incantation. Worth saying here: this
    // is where somebody learns the session exists, and the way out of an
    // attached session is the part nobody guesses.
    stdout.write(`mc: sit with it mc work ${name}  —  ctrl-b d leaves it running\n`);
    return 0;
  }

  // Already running in the background? Then joining means going to it, not
  // starting a second process on the same conversation.
  const running = backgroundTarget(name);
  if (running) {
    // A live conversation cannot change model, and quietly attaching would
    // leave the user believing it did — working with the wrong model is the
    // silent outcome the flag's own errors exist to prevent.
    if (opts.model) {
      stderr.write(`mc: ${name} is already running (${running}) — a live conversation cannot change model\n`);
      stderr.write(`mc: join it without --model, or restart it first: mc work stop ${name}\n`);
      return 1;
    }
    stderr.write(`mc: joining ${name} — it is running in the background\n`);
    stderr.write('mc: ctrl-b d leaves it running\n');
    const joined = attachBackground(running);
    if (!joined.ok) {
      stderr.write(`mc: could not join ${name} (${joined.reason})\n`);
      return 1;
    }
    return joined.code || 0;
  }

  stderr.write(`mc: ${worktree.path}\n`);
  const opened = await openInWorkArea({
    areaRoot: area.path, worktree, tool, pick, model: opts.model,
    overlay, defaultModel: roleModel, defaultModelTool: roleTool,
  });
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

/**
 * What the dry run is actually warning about.
 *
 * "This destroys work" was printed over a listing that said the area was
 * empty. A warning that does not match what is about to happen is worse than
 * none: it teaches the reader to skip the last line, and the last line is the
 * one that matters on the day something really is at stake.
 *
 * So it says what would be lost, and when nothing would be, it says that too.
 */
function stakes(result, name) {
  const at = [];
  const total = (key) => result.discarded.reduce((sum, item) => sum + (item[key] || 0), 0);
  const uncommitted = total('uncommitted');
  const unmerged = total('unmerged_commits');
  if (uncommitted) at.push(`${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'}`);
  if (unmerged) at.push(`${unmerged} unmerged commit${unmerged === 1 ? '' : 's'}`);
  if (result.conversations.length) {
    at.push(`${result.conversations.length} conversation${result.conversations.length === 1 ? '' : 's'}`);
  }
  if (at.length) {
    const list = at.length === 1 ? at[0] : `${at.slice(0, -1).join(', ')} and ${at[at.length - 1]}`;
    return `This destroys ${list}, which nothing brings back. Run again with --apply if that is what you want.`;
  }
  // Nothing is going anywhere while something is standing in it, so `--apply`
  // is not the missing ingredient and saying so would send the user in a
  // circle. The kept lines above already say which process and why.
  if (!result.discarded.length && result.kept.length) {
    return `Nothing in ${name} can go while it is in use.`;
  }
  if (!result.discarded.length) {
    return `Nothing in ${name} but the directory itself. Run again with --apply to remove it.`;
  }
  return `Everything in ${name} is committed and merged — only the worktree and branch go. Run again with --apply.`;
}

/**
 * A conversation, identified by how it opened.
 *
 * `019fd6c6  codex  just now  49 kB` was everything mc knew and none of what
 * the user needed: with two conversations the picker was a coin toss and with
 * five it was unanswerable. The first thing said in a conversation is what
 * anyone remembers it by, and both tools keep it.
 */
function conversationLine(item) {
  const tool = item.tool === 'claude-code' ? 'claude' : item.tool;
  const head = `${item.id.slice(0, 8)}  ${tool.padEnd(6)}  ${describeAge(item.updated_ms).padEnd(9)} ${describeSize(item.bytes).padStart(7)}`;
  if (!item.label) return head;
  const text = item.label.length > 48 ? `${item.label.slice(0, 47)}…` : item.label;
  return `${head}   ${text}`;
}

function describe(worktree) {
  if (!worktree.is_git) return `${worktree.repo}  (not a git worktree)`;
  const marks = [];
  if (worktree.uncommitted) marks.push(`${worktree.uncommitted} uncommitted`);
  if (worktree.unmerged_commits) marks.push(`${worktree.unmerged_commits} unmerged`);
  return `${worktree.repo}  ${worktree.branch || '(detached)'}${marks.length ? `  [${marks.join(', ')}]` : ''}`;
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--json', '--apply', '--tmux'],
    values: ['--repo', '--from'],
    strictValues: ['--model'],
    toolSugar: true,
  });
  const opts = {
    verb: 'list', name: null, repo: scanned.flags.repo, branch: null, pick: null, message: null,
    from: scanned.flags.from, tmux: scanned.flags.tmux, task: null,
    tool: scanned.flags.tool, model: scanned.flags.model,
    apply: scanned.flags.apply, json: scanned.flags.json,
  };
  if (scanned.error) return { ...opts, error: scanned.error };
  const { positional } = scanned;
  if (positional.length === 0) return opts;
  const [head, ...rest] = positional;

  // A first word that is not a verb is the name of a piece of work. Requiring
  // `open` was mc's grammar rather than the user's, and answering a name with
  // a usage list is a refusal in a different costume.
  if (!VERBS.includes(head)) {
    if (!NAME.test(head)) return { ...opts, error: `"${head}" cannot be a directory name` };
    // With --tmux the rest of the line is what the worker should do, not a
    // conversation to pick. A worker started with nothing to do sits at an
    // empty prompt for as long as it is left there.
    if (opts.tmux) return { ...opts, verb: 'open', name: head, task: rest.join(' ') || null };
    return { ...opts, verb: 'open', name: head, pick: rest[0] || null };
  }

  opts.verb = head;
  if (head === 'list') return opts;
  opts.name = rest[0] || null;
  if (!opts.name) return { ...opts, error: 'which piece of work?' };
  if (!NAME.test(opts.name)) return { ...opts, error: `"${opts.name}" cannot be a directory name` };
  if (head === 'stop') return opts;
  if (head === 'send') {
    // Everything after the name is the message. Requiring quotes around it
    // would be mc's grammar rather than the user's, and a report typed
    // straight at a shell is exactly what this is for.
    opts.message = rest.slice(1).join(' ');
    if (!opts.message) return { ...opts, error: `what should it say? mc work send ${opts.name} "<message>"` };
    return opts;
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
