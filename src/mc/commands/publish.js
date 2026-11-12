/**
 * `mc publish` — push the branch you stand on and open (or find) its pull
 * request, in one call.
 *
 *   mc publish                         last commit's subject and body as the PR's
 *   mc publish --title "…" --body "…"  named instead
 *   mc publish --body-file <path>      the body from a file
 *   mc publish --json                  the snapshot as one object, and nothing queued
 *   mc publish --no-merge              push and open it, and queue nothing
 *   mc publish --goal <p>/<g>          the pull request carries that goal
 *
 * A pull request carries a goal (`prs` in its GOAL.json, goals.js) when one is
 * named: `--goal`, else MC_GOAL, else the goal whose worktree this is, else
 * the goal of a `goal/<goal>` branch. The merger and the runner set the goal
 * `done` once every pull request it carries has landed (Martin, 2026-11-03:
 * *"När ett goal steg landas så måste status uppdateras automatiskt till
 * 'done'"*).
 *
 * The sequence memoro's `AGENTS.md` asks a session to walk by hand
 * (`publish.js` has each rule): refuse on main, refuse a dirty tree, refuse
 * a remote branch that moved (never force), refuse a branch whose merge with
 * origin/main conflicts (after a fetch; a failed fetch only warns),
 * non-force `git push -u`, then
 * one `gh pr create` — or, when the branch already has an open pull request,
 * `gh pr edit` of exactly the fields given (title, body, base) — and one
 * `gh pr view` of the result.
 *
 * Then it queues the pull request for the merger, as `mc merge <repo> <pr>`
 * does, in the same call (Martin, 2026-10-24: every turn a session spends
 * after its work is done is a turn for nothing). A session's publish was
 * always followed by that `mc merge`, one model turn later, to read one line.
 * Not with `--no-merge`, not with `--json` (a script decides). Nor when GitHub does not yet hold
 * the head that was pushed — `mc merge` would refuse it at the door.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { run as runGit, tryGit } from '../git.js';
import { addPr, goalDirIn, goalOfPath, GOAL_FILE, isGoalRef, logStamp, parseGoal, programsGoals, prRef, readTextOrNull } from '../goals.js';
import { writeFileAtomic } from '../atomic-write.js';
import { programsHome } from '../paths.js';
import { describedBody, markedBody, messageParts, publishLines, readBody, refusal } from '../publish.js';
import { scanArgs } from './flags.js';
import { run as merge } from './merge.js';
import { writerRole } from './goal.js';
import { commandUsage } from '../command-help.js';
import { checkAgainstMain, conflictReason } from '../main-conflict.js';
import { admitWriter } from '../programme-lifecycle.js';

/** Each subcommand and the scan it is read with; '' is the bare verb, '*' a first word that names something. help-routes.test.js walks the help with it. */
/** `check`: what the scanned arguments may not be — null, or what is wrong; the verb runs it, and help-routes.test.js walks the help with it. */
export const ROUTES = {
  '': {
    booleans: ['--json', '--no-merge'],
    strictValues: ['--title', '--body', '--body-file', '--base', '--goal'],
    check: ({ positional }) => (positional.length ? `mc publish takes no positional (${positional.join(' ')})` : null),
  },
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const cwd = deps.cwd || process.cwd();
  const scanned = scanArgs(argv, ROUTES['']);
  const refused = scanned.error || ROUTES[''].check(scanned);
  if (refused) { stderr.write(`mc: ${refused}\n${usage()}`); return 2; }
  const { flags } = scanned;

  const git = deps.git || ((args) => tryGit(cwd, args));
  const gh = deps.gh || ((args) => ghCommand(args, cwd));
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) { stderr.write('mc: not inside a git worktree\n'); return 2; }
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  // A detached HEAD is `HEAD`, which `refusal` refuses: a pull request is
  // opened from a branch checked out.
  const branch = current;
  const localHead = git(['rev-parse', 'HEAD']);
  const dirty = (git(['status', '--porcelain']) || '').split('\n').filter(Boolean);
  const remoteLine = git(['ls-remote', '--heads', 'origin', branch]) || '';
  const remoteHead = remoteLine.split(/\s+/u)[0] || null;
  const remoteIsAncestor = remoteHead ? git(['merge-base', '--is-ancestor', remoteHead, 'HEAD']) !== null : true;
  const why = refusal({ branch, dirty, remoteHead, localHead, remoteIsAncestor });
  if (why) { stderr.write(`mc: ${why}\n`); return 1; }
  // A branch whose merge with origin/<base> conflicts is not published (memoro-cli#1369): asked after a fetch.
  // `--base` names that base; without it, main.
  const base = flags.base || 'main';
  const checked = (deps.mainCheck || ((dir, opts) => checkAgainstMain(dir, opts)))(cwd, { base });
  if (!checked.fetch.ok) stderr.write(`mc: warning: git fetch origin failed (${checked.fetch.text}) — checked against the origin/${base} already held\n`);
  if (checked.paths.length) { stderr.write(`mc: ${conflictReason(checked.paths, base)}\n`); return 1; }
  const env = deps.env || process.env;
  const goal = goalOfPublish({ given: flags.goal, env, cwd, branch, home: deps.home || programsHome(env), read: deps.readGoal || readTextOrNull, list: deps.listGoals });
  if (goal?.error) { stderr.write(`mc: ${goal.error}\n`); return 2; }

  const ownerNames = new Set();
  if (goal?.name) ownerNames.add(goal.name.split('/')[0]);
  const programmeHome = resolve(deps.home || programsHome(env));
  const fromProgrammeHome = relative(programmeHome, resolve(cwd));
  if (fromProgrammeHome && fromProgrammeHome !== '..' && !fromProgrammeHome.startsWith(`..${sep}`) && !fromProgrammeHome.startsWith(sep)) {
    ownerNames.add(fromProgrammeHome.split(sep)[0]);
  }
  let writer = null;
  if (ownerNames.size) {
    try { writer = (deps.lifecycle || admitWriter)([...ownerNames], { env, name: 'mc publish' }); }
    catch (error) { stderr.write(`mc: publish refused: ${error.message}\n`); return 1; }
  }

  try {
  const repo = repoName(git(['remote', 'get-url', 'origin']), root);
  const pushed = remoteHead !== localHead;
  if (pushed) {
    const push = (deps.push || ((name, opts) => pushBranch(cwd, name, { stderr, ...opts })))(branch);
    if (!push.ok) { stderr.write(`mc: git push -u origin ${branch} failed:\n${push.text}\n`); return 1; }
  }
  const listed = gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url']);
  let open = null;
  try { open = JSON.parse(listed.stdout || '[]')[0] || null; } catch { open = null; }
  if (!listed.ok) { stderr.write(`mc: gh pr list failed: ${listed.text}\n`); return 1; }

  let bodyGiven = flags.body;
  if (flags['body-file']) {
    try { bodyGiven = (deps.read || readFileSync)(flags['body-file'], 'utf8'); } catch (error) { stderr.write(`mc: --body-file ${flags['body-file']}: ${error.message}\n`); return 2; }
  }
  const fromCommit = messageParts(git(['log', '-1', '--format=%B']));
  const title = flags.title || fromCommit.title;
  const body = bodyGiven ?? fromCommit.body;

  let created = false;
  let number = open?.number ?? null;
  let described = localHead;
  let after = 0;
  if (open) {
    const edit = ['pr', 'edit', String(open.number)];
    if (flags.title) edit.push('--title', flags.title);
    if (bodyGiven != null) {
      edit.push('--body', markedBody(bodyGiven, localHead));
    } else {
      const read = gh(['pr', 'view', String(open.number), '--json', 'body']);
      let current = null;
      try { current = JSON.parse(read.stdout || 'null')?.body ?? null; } catch { current = null; }
      if (!read.ok || current == null) { stderr.write(`mc: gh pr view #${open.number} failed: ${read.text}\n`); return 1; }
      const later = afterTheDescription({ git, body: current, base: flags.base || defaultBase(git), stderr });
      described = later.described;
      after = later.after;
      if (later.body != null) edit.push('--body', later.body);
    }
    if (flags.base) edit.push('--base', flags.base);
    if (edit.length > 3) {
      const edited = gh(edit);
      if (!edited.ok) { stderr.write(`mc: gh pr edit #${open.number} failed: ${edited.text}\n`); return 1; }
    }
  } else {
    const base = flags.base || defaultBase(git);
    const made = gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', markedBody(body, localHead)]);
    if (!made.ok) { stderr.write(`mc: gh pr create failed: ${made.text}\n`); return 1; }
    created = true;
    const found = /\/pull\/(\d+)/u.exec(made.stdout || '');
    number = found ? Number(found[1]) : null;
  }
  if (number == null) {
    const again = gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']);
    try { number = JSON.parse(again.stdout || '[]')[0]?.number ?? null; } catch { number = null; }
  }
  if (number == null) { stderr.write('mc: the pull request was not found after creating it — gh pr list --head ' + branch + '\n'); return 1; }

  const viewed = gh(['pr', 'view', String(number), '--json', 'number,url,headRefOid,baseRefName,mergeable,mergeStateStatus,state']);
  let pr = null;
  try { pr = JSON.parse(viewed.stdout || 'null'); } catch { pr = null; }
  if (!viewed.ok || !pr) { stderr.write(`mc: gh pr view #${number} failed: ${viewed.text}\n`); return 1; }
  if (goal) carryGoal({ goal, repo, number: pr.number, env, now: deps.now ? deps.now() : new Date(), read: deps.readGoal || readTextOrNull, write: deps.writeGoal || writeFileAtomic, stdout, stderr, json: flags.json });
  if (flags.json) {
    stdout.write(`${JSON.stringify({ ...pr, branch, localHead, pushed, created, repo, described, after, next: `mc merge ${repo} ${pr.number}` }, null, 2)}\n`);
    return 0;
  }
  const head = String(pr.headRefOid || '');
  const held = head.startsWith(localHead) || localHead.startsWith(head);
  const queue = !flags['no-merge'] && held;
  for (const line of publishLines({ pr, localHead, branch, pushed, created, repo, after, described, queued: queue })) stdout.write(`${line}\n`);
  if (!queue) return 0;
  return (deps.merge || merge)([repo, String(pr.number)], { stdout, stderr });
  } finally {
    writer?.release();
  }
}

/**
 * The goal this publication carries, as `{ name, dir }`, null for none, or
 * `{ error }` for a `--goal` that is no goal: `--goal`, else MC_GOAL, else the
 * goal whose worktree `cwd` is in, else the one goal named as the `goal/<g>`
 * branch is. Only `--goal` must exist; a goal found any other way that is not
 * there is none.
 */
export function goalOfPublish({ given, env, cwd, branch, home, read = readTextOrNull, list }) {
  const exists = (programme, goal) => read(join(goalDirIn(home, programme, goal), GOAL_FILE)) !== null;
  const named = given || env.MC_GOAL || null;
  if (named) {
    if (!isGoalRef(named)) return given ? { error: `--goal ${named} is not <programme>/<goal>` } : null;
    const [programme, goal] = named.split('/');
    if (!exists(programme, goal)) return given ? { error: `--goal ${named} is not a goal — mc goal list names them` } : null;
    return { name: named, dir: goalDirIn(home, programme, goal) };
  }
  const here = goalOfPath(cwd, home);
  if (here && exists(here.programme, here.goal)) return { name: `${here.programme}/${here.goal}`, dir: goalDirIn(home, here.programme, here.goal) };
  const fromBranch = /^goal\/([a-z0-9][a-z0-9-]*)$/u.exec(branch || '')?.[1];
  if (!fromBranch) return null;
  const found = programsGoals({ home, read, ...(list ? { list } : {}) }).filter((item) => item.goal === fromBranch);
  return found.length === 1 ? { name: `${found[0].programme}/${found[0].goal}`, dir: found[0].dir } : null;
}

/** The pull request written into the goal's `prs`, with an entry; said in one line (on stderr under --json). */
function carryGoal({ goal, repo, number, env, now, read, write, stdout, stderr, json }) {
  const ref = prRef({ repo, pr: number });
  const out = json ? stderr : stdout;
  try {
    const parsed = parseGoal(read(join(goal.dir, GOAL_FILE)) ?? '');
    const entry = { at: logStamp(now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: writerRole(env), stage: parsed.stage ?? null, status: parsed.status ?? 'ready', done: `published ${ref}`, comment: null, next: null };
    const added = addPr({ dir: goal.dir, repo, pr: number, entry, read, write });
    if (added.problems) { stderr.write(`mc: ${ref} is not written into ${goal.name} — ${added.problems.join('; ')}\n`); return; }
    out.write(`goal ${goal.name} carries ${ref}${added.added ? '' : ' already'} — done when every pull request it carries has landed\n`);
  } catch (error) {
    stderr.write(`mc: ${ref} is not written into ${goal.name} (${error?.message || error}) — mc goal pr ${goal.name} ${ref}\n`);
  }
}

/** The base a new pull request aims at: what origin calls its default branch, else main. */
function defaultBase(git) {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return head ? head.replace(/^origin\//u, '') : 'main';
}

/**
 * The commits after the head the description describes, and the body that
 * lists them — `body` is null when it already says so. A description with no
 * mark describes the branch's first commit. When that head is not in this
 * branch nothing is written: the reason goes to stderr, and the body stays.
 */
function afterTheDescription({ git, body, base, stderr }) {
  const read = readBody(body);
  const described = read.described || (git(['rev-list', '--reverse', '--no-merges', `origin/${base}..HEAD`]) || '').split('\n')[0] || null;
  if (!described || git(['merge-base', '--is-ancestor', described, 'HEAD']) === null) {
    stderr.write(`mc: the description's head ${described || '(none)'} is not in this branch — left as it is; write it again with --body-file\n`);
    return { described, after: 0, body: null };
  }
  const commits = (git(['log', '--reverse', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', `${described}..HEAD`]) || '')
    .split('\x1e').map((record) => record.trim()).filter(Boolean)
    .map((record) => {
      const [sha, subject, text = ''] = record.split('\x1f');
      return { sha, subject, body: text };
    });
  const next = describedBody({ text: read.text, described, commits });
  return { described, after: commits.length, body: next === body ? null : next };
}

/** The repository as mc names it — the last segment of origin's URL, or the checkout's own name. */
export function repoName(url, root) {
  const last = String(url || '').trim().replace(/\/+$/u, '').split(/[/:]/u).pop() || '';
  return last.replace(/\.git$/u, '') || basename(root);
}

/**
 * Non-force `git push -u`. GitHub has refused a thin pack with `Internal
 * Server Error` while taking the same commit with `--no-thin` (2026-10-07),
 * so that rejection — and only that one — is pushed once more without it.
 */
export function pushBranch(cwd, branch, { spawn = spawnGit, stderr = process.stderr } = {}) {
  const target = ['-u', 'origin', branch];
  const push = (extra) => spawn('git', ['push', ...extra, ...target], { cwd, encoding: 'utf8', timeout: 120_000 });
  let r = push([]);
  if (r.status !== 0 && /Internal Server Error/u.test(r.stderr || '')) {
    stderr.write('mc: GitHub rejected the thin pack; pushed again with --no-thin\n');
    r = push(['--no-thin']);
  }
  return { ok: r.status === 0, text: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** `spawnSync('git', …)` as `pushBranch` calls it, through the one git entrance. */
function spawnGit(_git, args, { cwd, timeout } = {}) {
  return runGit(cwd, args, { timeoutMs: timeout });
}

export function ghCommand(args, cwd) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, stdout: r.stdout || '', text: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

export function usage() {
  return commandUsage('publish');
}
