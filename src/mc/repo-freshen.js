/**
 * After a green merge, the branches the merge just made dirty (A6).
 *
 * Measured 2026-08-23: one branch was rebased twice in forty minutes because
 * main moved under it — the second time onto a one-line insertion-point
 * conflict against its own author's already-merged rule — for ~12 minutes of
 * a track's time, none of it value. And the queue's hotspot files mean every
 * merge dirties most open branches at once. So the round that moved main,
 * while it still holds the repository's lease, brings the open branches up
 * to date — the same work, done once, by the one already holding the lease.
 *
 * The branch is freshened by merging the base *into* it, not by rebasing it:
 * the repository's convention since #363→#364 is "merge main in, no
 * force-push", a rebase rewrites history under the branch owner's feet, and
 * a merge commit pushed plainly needs nothing from them. The rules, and they
 * are hard:
 *
 *  - **A conflict touches nothing.** The merge is aborted, the branch is
 *    left exactly as it was, and the report names the branch and the files.
 *    Conflicts only under `artifacts/` are said as what they are —
 *    regenerate, never resolve — and still not resolved here.
 *  - **No push without the owner knowing.** The push and the inbox line go
 *    together; an area mc cannot find gets the line in the round's own
 *    output instead, and the push still happens only on a clean merge.
 *  - **The declared `affected` runs first when there is one.** Red means no
 *    push: the branch is semantically behind main, and that is the owner's
 *    to see, not mc's to land. No declaration means no run, said plainly —
 *    a guessed script name green-lighting a push would be worse than none.
 *  - **A branch somebody is working in right now is skipped.** The worktree
 *    occupation already knows.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { gateRoot } from './repo-gate.js';
import { declarationFor } from './repo-gate-table.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';
import { sendToArea } from './work-send.js';
import { toolProcesses } from './work-status.js';

/** Who the inbox lines are from. Fixed: the round runs wherever it was started. */
const SENDER = Object.freeze({ name: 'mc repo merge', kind: 'watcher' });

/**
 * Freshen every open branch aimed at `base`, and say what happened to each.
 *
 * Returns `{ branches: [...] }` where each entry carries the branch, the PR
 * number, what was done (`pushed`, `conflict`, `affected-red`, `skipped`),
 * and the detail a reader needs. Never throws for one branch's sake: a
 * branch that could not even be looked at is an entry, not an exception.
 */
export function freshenOpenBranches({
  repoPath,
  base,
  holder,
  root = mcHome(),
  env = process.env,
  git = null,
  gh = null,
  send = sendToArea,
  processes = toolProcesses,
  shell = null,
  say = () => {},
} = {}) {
  const run = (tool) => (args, options = {}) => spawnSync(tool, args, {
    cwd: options.cwd, env, encoding: 'utf8',
  });
  const askGit = git || run('git');
  const askGh = gh || run('gh');
  const sh = shell || ((command, options) => spawnSync('sh', ['-c', command], {
    cwd: options.cwd, env, encoding: 'utf8',
  }));
  const outcome = { branches: [] };
  const note = (entry) => { outcome.branches.push(entry); say(`freshen ${entry.branch}: ${entry.action}${entry.detail ? ` — ${entry.detail}` : ''}`); return entry; };

  const listed = askGh(['pr', 'list', '--base', base, '--state', 'open', '--json', 'number,headRefName'], { cwd: repoPath });
  if (listed.status !== 0) {
    say(`freshen: could not list open pull requests (${trim(listed.stderr) || 'gh failed'}) — no branch touched`);
    return outcome;
  }
  let open = [];
  try { open = JSON.parse(listed.stdout || '[]'); } catch { open = []; }
  if (!open.length) return outcome;

  askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
  const baseRef = `origin/${base}`;
  const occupied = occupiedBranches({ git: askGit, repoPath, processes });
  const declared = declarationFor(repoPath, { root, env });
  const affected = declared.ok ? declared.declaration.affected || null : null;
  const prepare = declared.ok ? declared.declaration.prepare || null : null;

  const workspace = join(gateRoot(root), `${repoFileSlug(repoPath)}-freshen`);

  for (const item of open) {
    const branch = item.headRefName;
    const headRef = `origin/${branch}`;
    const entry = { branch, number: item.number, action: null, detail: null, told: null };

    const behind = trim(askGit(['rev-list', '--count', `${headRef}..${baseRef}`], { cwd: repoPath }).stdout);
    if (behind === '') { note({ ...entry, action: 'skipped', detail: `could not read how far ${branch} is behind` }); continue; }
    if (Number(behind) === 0) continue; // current — not even an entry; silence is right here
    if (occupied.has(branch)) {
      note({ ...entry, action: 'skipped', detail: `somebody is working in a worktree on ${branch} right now` });
      continue;
    }

    rmSync(workspace, { recursive: true, force: true });
    askGit(['worktree', 'prune'], { cwd: repoPath });
    const added = askGit(['worktree', 'add', '--detach', workspace, headRef], { cwd: repoPath });
    if (added.status !== 0) { note({ ...entry, action: 'skipped', detail: trim(added.stderr) || `could not check out ${headRef}` }); continue; }

    try {
      const merged = askGit(['merge', '--no-edit', baseRef], { cwd: workspace });
      if (merged.status !== 0) {
        const conflicted = trim(askGit(['diff', '--name-only', '--diff-filter=U'], { cwd: workspace }).stdout).split('\n').filter(Boolean);
        askGit(['merge', '--abort'], { cwd: workspace });
        const outside = conflicted.filter((file) => !file.startsWith('artifacts/'));
        const detail = outside.length
          ? `conflicts with ${base} in ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''} — left exactly as it was`
          : `conflicts only under artifacts/ (${conflicted.length} file${conflicted.length === 1 ? '' : 's'}) — regenerate, never resolve; left exactly as it was`;
        entry.told = tell({ send, branch, number: item.number, occupied, git: askGit, repoPath, say,
          message: `mc repo merge: #${item.number} (${branch}) ${detail}` });
        note({ ...entry, action: 'conflict', detail });
        continue;
      }

      if (affected) {
        if (prepare) {
          const ready = sh(prepare, { cwd: workspace });
          if (ready.status !== 0) { note({ ...entry, action: 'skipped', detail: `${prepare} failed before ${affected} — nothing pushed` }); continue; }
        }
        const ran = sh(affected, { cwd: workspace });
        if (ran.status !== 0) {
          const detail = `${base} merged in cleanly but ${affected} is red — nothing pushed; the branch needs its owner`;
          entry.told = tell({ send, branch, number: item.number, occupied, git: askGit, repoPath, say,
            message: `mc repo merge: #${item.number} (${branch}) ${detail}` });
          note({ ...entry, action: 'affected-red', detail });
          continue;
        }
      }

      const pushed = askGit(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: workspace });
      if (pushed.status !== 0) { note({ ...entry, action: 'skipped', detail: `push refused (${trim(pushed.stderr) || 'git push failed'}) — the branch moved since it was read, or the remote said no` }); continue; }
      const at = trim(askGit(['rev-parse', 'HEAD'], { cwd: workspace }).stdout).slice(0, 7);
      const detail = `${base} merged in at ${at}, clean${affected ? `, ${affected} green` : ', no affected declared — run yours before building on it'}`;
      entry.told = tell({ send, branch, number: item.number, occupied, git: askGit, repoPath, say,
        message: `mc repo merge: your branch ${branch} (#${item.number}) is freshened — ${detail}; plain merge commit, nothing rewritten, git pull and continue` });
      note({ ...entry, action: 'pushed', detail });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      askGit(['worktree', 'prune'], { cwd: repoPath });
    }
  }
  return outcome;
}

/**
 * Which branches have a session standing in them right now: every worktree
 * of the repository, its branch, and whether a tool process stands in it.
 */
function occupiedBranches({ git, repoPath, processes }) {
  const listed = git(['worktree', 'list', '--porcelain'], { cwd: repoPath });
  const occupied = new Set();
  if (listed?.status !== 0) return occupied;
  let path = null;
  for (const line of String(listed.stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
    if (line.startsWith('branch ') && path) {
      const branch = line.slice('branch '.length).replace('refs/heads/', '').trim();
      try {
        if ((processes([path]) || []).length > 0) occupied.add(branch);
      } catch { /* a worktree that cannot be asked is not proof of anybody */ }
    }
  }
  return occupied;
}

/**
 * The owner's line: into the inbox of the area whose worktree holds the
 * branch, or — when no area holds it — nowhere, which the entry says. The
 * file is the delivery; no knock, because "your branch moved" can wait for
 * the owner's next turn (#346: waking is for state changes they wait on).
 */
function tell({ send, branch, git, repoPath, message, say }) {
  const area = areaOf({ git, repoPath, branch });
  if (!area) { say(`freshen ${branch}: no work area holds this branch — the line is only here`); return null; }
  try {
    const sent = send({ name: area, message, sender: SENDER, wake: false });
    return sent?.ok ? area : null;
  } catch { return null; }
}

/** The work area whose worktree has the branch checked out, if any. */
function areaOf({ git, repoPath, branch }) {
  const listed = git(['worktree', 'list', '--porcelain'], { cwd: repoPath });
  if (listed?.status !== 0) return null;
  let path = null;
  for (const line of String(listed.stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
    if (line.startsWith('branch ') && path) {
      const name = line.slice('branch '.length).replace('refs/heads/', '').trim();
      if (name === branch) {
        // ~/mc/<area>/... — the area is the path segment under the work root.
        const match = /\/mc\/([^/]+)\//u.exec(`${path}/`);
        return match ? match[1] : null;
      }
    }
  }
  return null;
}

function trim(value) {
  return String(value ?? '').trim();
}
