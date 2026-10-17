/**
 * `mc publish` — push the branch you stand on and open (or find) its pull
 * request, in one call.
 *
 *   mc publish                         last commit's subject and body as the PR's
 *   mc publish --title "…" --body "…"  named instead
 *   mc publish --body-file <path>      the body from a file
 *   mc publish --json                  the snapshot as one object
 *
 * The sequence memoro's `AGENTS.md` asks a session to walk by hand
 * (`publish.js` has each rule): refuse on main, refuse a dirty tree, refuse
 * a remote branch that moved (never force), non-force `git push -u`, then
 * one `gh pr create` — or, when the branch already has an open pull request,
 * `gh pr edit` of exactly the fields given (title, body, base) — and one
 * `gh pr view` of the result. Five lines back, the last of them `mc merge <repo> <pr>`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { tryGit } from '../git.js';
import { describedBody, markedBody, messageParts, publishLines, readBody, refusal } from '../publish.js';
import { scanArgs } from './flags.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const cwd = deps.cwd || process.cwd();
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--title', '--body', '--body-file', '--base'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  if (scanned.positional.length) { stderr.write(`mc: mc publish takes no positional (${scanned.positional.join(' ')})\n${usage()}`); return 2; }
  const { flags } = scanned;

  const git = deps.git || ((args) => tryGit(cwd, args));
  const gh = deps.gh || ((args) => ghCommand(args, cwd));
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) { stderr.write('mc: not inside a git worktree\n'); return 2; }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const localHead = git(['rev-parse', 'HEAD']);
  const dirty = (git(['status', '--porcelain']) || '').split('\n').filter(Boolean);
  const remoteLine = git(['ls-remote', '--heads', 'origin', branch]) || '';
  const remoteHead = remoteLine.split(/\s+/u)[0] || null;
  const remoteIsAncestor = remoteHead ? git(['merge-base', '--is-ancestor', remoteHead, 'HEAD']) !== null : true;
  const why = refusal({ branch, dirty, remoteHead, localHead, remoteIsAncestor });
  if (why) { stderr.write(`mc: ${why}\n`); return 1; }

  const repo = repoName(git(['remote', 'get-url', 'origin']), root);
  const pushed = remoteHead !== localHead;
  if (pushed) {
    const push = (deps.push || ((name) => pushBranch(cwd, name, { stderr })))(branch);
    if (!push.ok) { stderr.write(`mc: git push -u origin ${branch} failed:\n${push.text}\n`); return 1; }
  }

  const listed = gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url']);
  let open = null;
  try { open = JSON.parse(listed.stdout || '[]')[0] || null; } catch { open = null; }
  if (!listed.ok) { stderr.write(`mc: gh pr list failed: ${listed.text}\n`); return 1; }

  let bodyGiven = flags.body;
  if (flags.bodyFile) {
    try { bodyGiven = (deps.read || readFileSync)(flags.bodyFile, 'utf8'); } catch (error) { stderr.write(`mc: --body-file ${flags.bodyFile}: ${error.message}\n`); return 2; }
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

  if (flags.json) {
    stdout.write(`${JSON.stringify({ ...pr, branch, localHead, pushed, created, repo, described, after, next: `mc merge ${repo} ${pr.number}` }, null, 2)}\n`);
    return 0;
  }
  for (const line of publishLines({ pr, localHead, branch, pushed, created, repo, after, described })) stdout.write(`${line}\n`);
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
 * Non-force `git push -u`. GitHub has refused a thin pack with `Internal
 * Server Error` while taking the same commit with `--no-thin` (2026-10-07),
 * so that rejection — and only that one — is pushed once more without it.
 */
export function pushBranch(cwd, branch, { spawn = spawnSync, stderr = process.stderr } = {}) {
  const push = (extra) => spawn('git', ['push', ...extra, '-u', 'origin', branch], { cwd, encoding: 'utf8', timeout: 120_000 });
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
    '        mc publish --json                   the pull request snapshot as one object\n',
    '\n',
    'Refuses on main, on a dirty tree, and when origin\'s branch moved (never force). Ends with the mc merge line to run.\n',
  ].join('');
}
