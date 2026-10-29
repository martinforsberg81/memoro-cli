import { reviewCommandRefusal } from '../autonomous-review-guard.js';
/**
 * `mc publish` — push the branch you stand on and open (or find) its pull
 * request, in one call.
 *
 *   mc publish                         last commit's subject and body as the PR's
 *   mc publish --title "…" --body "…"  named instead
 *   mc publish --body-file <path>      the body from a file
 *   mc publish --branch <name>         a detached HEAD (a mend's worktree) to that branch
 *   mc publish --json                  the snapshot as one object, and nothing queued
 *   mc publish --no-merge              push and open it, and queue nothing
 *
 * The sequence memoro's `AGENTS.md` asks a session to walk by hand
 * (`publish.js` has each rule): refuse on main, refuse a dirty tree, refuse
 * a remote branch that moved (never force), non-force `git push -u`, then
 * one `gh pr create` — or, when the branch already has an open pull request,
 * `gh pr edit` of exactly the fields given (title, body, base) — and one
 * `gh pr view` of the result.
 *
 * Then it queues the pull request for the merger, as `mc merge <repo> <pr>`
 * does, in the same call (Martin, 2026-10-24: every turn a session spends
 * after its work is done is a turn for nothing). A session's publish was
 * always followed by that `mc merge`, one model turn later, to read one line.
 * Not with `--no-merge`, not with `--json` (a script decides), and not for a
 * detached HEAD published with `--branch`: that is a mend's, and the merger
 * that started the mend measures it again. Nor when GitHub does not yet hold
 * the head that was pushed — `mc merge` would refuse it at the door. In a
 * branch flow a step before the review is booked built instead, and queues
 * nothing (`bookBuilt`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { tryGit } from '../git.js';
import { projectPlan } from '../merge-boundary.js';
import { builtPatch } from '../merge-step.js';
import { branchFlow } from '../plan-schema.js';
import { workRoot } from '../paths.js';
import { parseStepEnv, updateStep } from '../register.js';
import { describedBody, markedBody, messageParts, publishLines, readBody, refusal } from '../publish.js';
import { scanArgs } from './flags.js';
import { run as merge } from './merge.js';
import { AUTONOMOUS_PR_MARK, autonomousBranchHeld } from '../autonomous-pr.js';
import { repoNameOf } from '../repos.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const reviewRefusal = reviewCommandRefusal(['publish', ...argv], deps);
  if (reviewRefusal) { stderr.write(`mc: ${reviewRefusal}\n`); return 1; }
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;
  const autonomous = deps.autonomousPublication || null;
  if ((env.MC_AUTONOMOUS_RUN || env.MC_AUTONOMOUS_ROLE) && !autonomous) {
    stderr.write('mc: autonomous publication requires mc autonomous-project finish; ordinary publish cannot close this run\n');
    return 1;
  }
  const scanned = scanArgs(argv, { booleans: ['--json', '--no-merge'], strictValues: ['--title', '--body', '--body-file', '--base', '--branch'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  if (scanned.positional.length) { stderr.write(`mc: mc publish takes no positional (${scanned.positional.join(' ')})\n${usage()}`); return 2; }
  const { flags } = scanned;

  const git = deps.git || ((args) => tryGit(cwd, args));
  const gh = deps.gh || ((args) => ghCommand(args, cwd));
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) { stderr.write('mc: not inside a git worktree\n'); return 2; }
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (flags.branch && current !== 'HEAD' && current !== flags.branch) { stderr.write(`mc: --branch ${flags.branch}, but this worktree is on ${current} — drop --branch\n`); return 2; }
  if (flags.branch && git(['check-ref-format', '--branch', flags.branch]) === null) { stderr.write(`mc: --branch ${flags.branch} is not a branch name\n`); return 2; }
  const branch = flags.branch || current;
  if (autonomous && (flags.branch || branch !== autonomous.branch)) { stderr.write('mc: autonomous branch ownership mismatch\n'); return 1; }
  const detached = current === 'HEAD';
  const localHead = git(['rev-parse', 'HEAD']);
  const dirty = (git(['status', '--porcelain']) || '').split('\n').filter(Boolean);
  const remoteLine = git(['ls-remote', '--heads', 'origin', branch]) || '';
  const remoteHead = remoteLine.split(/\s+/u)[0] || null;
  const remoteIsAncestor = remoteHead ? git(['merge-base', '--is-ancestor', remoteHead, 'HEAD']) !== null : true;
  const why = refusal({ branch, dirty, remoteHead, localHead, remoteIsAncestor });
  if (why) { stderr.write(`mc: ${why}\n`); return 1; }

  const repo = repoName(git(['remote', 'get-url', 'origin']), root);
  if (!autonomous && autonomousBranchHeld({ root: deps.root || workRoot(env), repo: repoNameOf(root), branch })) {
    stderr.write('mc: known autonomous branch requires mc autonomous-project finish; nothing pushed or queued\n'); return 1;
  }
  let autonomousListed = null;
  if (autonomous) {
    autonomousListed = gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state']);
    let prs;
    try { prs = JSON.parse(autonomousListed.stdout); } catch { prs = null; }
    if (!autonomousListed.ok || !Array.isArray(prs) || prs.length > 1
      || prs.some(pr => !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.state !== 'OPEN')
      || (autonomous.pr !== null && (prs.length !== 1 || prs[0].number !== autonomous.pr))) {
      stderr.write('mc: existing autonomous PR ownership could not be confirmed; nothing published\n'); return 1;
    }
  }
  const pushed = remoteHead !== localHead;
  if (pushed) {
    const push = (deps.push || ((name, opts) => pushBranch(cwd, name, { stderr, ...opts })))(branch, { detached });
    if (!push.ok) { stderr.write(`mc: ${detached ? 'git push' : 'git push -u'} origin ${branch} failed:\n${push.text}\n`); return 1; }
  }
  if (autonomous) {
    const observed = (git(['ls-remote', '--heads', 'origin', branch]) || '').split(/\s+/u)[0];
    if (observed !== localHead) { stderr.write('mc: autonomous push is unconfirmed\n'); return 1; }
    await autonomous.onPushed(localHead);
  }

  const listed = autonomousListed || gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url']);
  let open = null;
  try { open = JSON.parse(listed.stdout || '[]')[0] || null; } catch { open = null; }
  if (!listed.ok) { stderr.write(`mc: gh pr list failed: ${listed.text}\n`); return 1; }

  let bodyGiven = flags.body;
  if (flags['body-file']) {
    try { bodyGiven = (deps.read || readFileSync)(flags['body-file'], 'utf8'); } catch (error) { stderr.write(`mc: --body-file ${flags['body-file']}: ${error.message}\n`); return 2; }
  }
  if (autonomous) bodyGiven = `${bodyGiven ?? ''}\n\n${AUTONOMOUS_PR_MARK}`;
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
    const made = gh(['pr', 'create', ...(autonomous ? ['--draft'] : []), '--base', base, '--head', branch, '--title', title, '--body', markedBody(body, localHead)]);
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
  if (autonomous) await autonomous.onLocated(number);

  const viewed = gh(['pr', 'view', String(number), '--json', `number,url,headRefOid,baseRefName,mergeable,mergeStateStatus,state${autonomous ? ',headRefName,body' : ''}`]);
  let pr = null;
  try { pr = JSON.parse(viewed.stdout || 'null'); } catch { pr = null; }
  if (!viewed.ok || !pr) { stderr.write(`mc: gh pr view #${number} failed: ${viewed.text}\n`); return 1; }
  if (autonomous) {
    if (pr.number !== number || pr.headRefOid !== localHead || pr.headRefName !== branch || pr.baseRefName !== 'main'
      || pr.state !== 'OPEN' || !pr.body?.includes(AUTONOMOUS_PR_MARK)) {
      stderr.write('mc: autonomous PR does not confirm the marked, pushed branch/head\n'); return 1;
    }
    await autonomous.onResolved(pr);
    stdout.write(`mc: autonomous publication prepared in #${pr.number}; nothing queued; process completion and handoff remain required\n`);
    return 0;
  }

  if (flags.json) {
    stdout.write(`${JSON.stringify({ ...pr, branch, localHead, pushed, created, repo, described, after, next: `mc merge ${repo} ${pr.number}` }, null, 2)}\n`);
    return 0;
  }
  const head = String(pr.headRefOid || '');
  const held = head.startsWith(localHead) || localHead.startsWith(head);
  const queue = !flags['no-merge'] && !detached && held;
  for (const line of publishLines({ pr, localHead, branch, pushed, created, repo, after, described, queued: queue })) stdout.write(`${line}\n`);
  if (!queue) return 0;
  const built = bookBuilt({ branch, number: pr.number, localHead, deps, stdout, stderr });
  if (built !== null) return built;
  return (deps.merge || merge)([repo, String(pr.number)], { stdout, stderr });
}

/**
 * A step before a branch flow's review is `built`, not landed: its work stands
 * on the project's branch, in the project's one pull request, and the review
 * step's landing makes it `done`. Only a runner's session names its step
 * (`MC_STEP`); a plan that cannot be read, or no step, is queued as before.
 * Returns the exit code when the step was booked, else null.
 */
function bookBuilt({ branch, number, localHead, deps, stdout, stderr }) {
  const env = deps.env || process.env;
  const told = parseStepEnv(env.MC_STEP);
  if (!told) return null;
  let found = null;
  try { found = (deps.projectPlan || projectPlan)({ project: told.project }); } catch { return null; }
  if (!found || !branchFlow(found.plan) || told.index >= found.plan.steps.length - 1) return null;
  const root = deps.root || workRoot(env);
  const stamp = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  try {
    (deps.updateStep || updateStep)({ root, project: told.project, index: told.index, patch: builtPatch({ pr: number, branch, sha: localHead, now: stamp }), now: stamp });
  } catch (error) {
    stderr.write(`mc: ${told.project} step ${told.index + 1} is not booked built (${error?.message || error}) — #${number} is open and nothing is queued\n`);
    return 1;
  }
  stdout.write(`mc: built — step ${told.index + 1} stands on ${branch} at ${localHead.slice(0, 7)} in #${number}; the next step continues on this branch. Your work is over.\n`);
  return 0;
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
 * Non-force `git push -u`, or for a detached HEAD `git push origin
 * HEAD:refs/heads/<branch>`. GitHub has refused a thin pack with `Internal
 * Server Error` while taking the same commit with `--no-thin` (2026-10-07),
 * so that rejection — and only that one — is pushed once more without it.
 */
export function pushBranch(cwd, branch, { spawn = spawnSync, stderr = process.stderr, detached = false } = {}) {
  const target = detached ? ['origin', `HEAD:refs/heads/${branch}`] : ['-u', 'origin', branch];
  const push = (extra) => spawn('git', ['push', ...extra, ...target], { cwd, encoding: 'utf8', timeout: 120_000 });
  let r = push([]);
  if (r.status !== 0 && /Internal Server Error/u.test(r.stderr || '')) {
    stderr.write('mc: GitHub rejected the thin pack; pushed again with --no-thin\n');
    r = push(['--no-thin']);
  }
  return { ok: r.status === 0, text: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function ghCommand(args, cwd) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, stdout: r.stdout || '', text: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

export function usage() {
  return [
    'usage — mc publish                          push this branch and open its pull request (title and body from the last commit)\n',
    '        mc publish --title "…" --body "…"   named instead; on an open pull request each edits only its own field\n',
    '        mc publish --body-file <path>       the body from a file\n',
    '        mc publish --base <branch>          the base a new pull request aims at, or the open one is moved to\n',
    '        mc publish --branch <name>          a detached HEAD (a mend\'s worktree) to that branch\n',
    '        mc publish --json                   the pull request snapshot as one object; queues nothing\n',
    '        mc publish --no-merge               push and open it, and queue nothing\n',
    '\n',
    'Refuses on main, on a dirty tree, and when origin\'s branch moved (never force); a detached HEAD only with --branch.\nThen queues the pull request for the merger, as mc merge <repo> <pr> does — not with --no-merge, --json or --branch.\n',
  ].join('');
}
