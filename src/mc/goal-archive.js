/**
 * Archiving a finished goal — the rules `mc goal archive` and the runner share.
 *
 * A goal that is `done` or `dropped` leaves the list by one road whoever asks:
 * `archiveGoal` refuses what `mc goal archive` refuses, with the reason, and
 * touches nothing when it does; otherwise each worktree is removed through git,
 * the goal's branch deleted, its directory moved to `goals/.archive/`, and one
 * row written to `goals/goal_log.md`. The runner calls it once a goal has been
 * finished for `ARCHIVE_HOLD_MS`, the hold a project under `~/mc/programs/` has
 * too (`project-archive.js`). A programme is never archived by the runner.
 *
 * The rules take what they need as arguments: `git`, `gh`, `known`, `move`,
 * `appendText`, `read` and `now` come from the caller, as goal.js and run.js
 * hand them over, so the tests use a file model and no repository.
 */
import { renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ARCHIVE_HOLD_MS } from './project-archive.js';
import { archiveDirIn, FINISHED, GOAL_FILE, GOAL_LOG_FILE, GOAL_LOG_HEAD, GOALS_DIR, goalLogRow, prRef, statusSince } from './goals.js';
import { repoNameOf } from './repos.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether the runner archives this goal now, and why in one line, as
 * `archiveDue` does for a project: a goal is due once it has been `done` or
 * `dropped` for `holdMs` — exactly that long is due — counted from the log
 * entry that set the status (`statusSince`), not from the file's mtime.
 */
export function goalArchiveDue({ goal, nowMs, holdMs = ARCHIVE_HOLD_MS }) {
  if (!FINISHED.includes(goal.status)) return { due: false, why: `the goal is ${goal.status}` };
  const at = statusSince(goal);
  if (!at || Number.isNaN(Date.parse(at))) return { due: false, why: `the log does not say when it was ${goal.status}` };
  const since = nowMs - Date.parse(at);
  const hours = Math.max(0, Math.floor(since / HOUR_MS));
  if (since < holdMs) return { due: false, why: `${goal.status} ${hours}h ago — archived after ${Math.round(holdMs / HOUR_MS)}h` };
  return { due: true, why: `${goal.status} ${hours}h ago` };
}

/** A directory moved, its new parent made first. Throws when the destination is there. */
export function moveDir(from, to) {
  mkdirSync(join(to, '..'), { recursive: true });
  if (existsSync(to)) throw new Error(`${to} exists`);
  renameSync(from, to);
}

/**
 * One goal archived, or why not. `goal` is a goal as `programsGoals` gives it
 * and `all` every goal there is. Returns `{ to }` when it moved, else
 * `{ refused }` with the reason; a refusal touches nothing. What the context
 * holds: `home` (the programmes home), `git(cwd, args)` and `gh(cwd, args)` as
 * `{ ok, stdout, stderr }`, `known()` (the repositories' paths), `move(from, to)`
 * (throws when it fails), `appendText(path, text)`, `read(path)` and `now`, a Date.
 */
export function archiveGoal(goal, all, { home, git, gh, known, move = moveDir, appendText, read, now }) {
  const refuse = (refused) => ({ refused });
  if (goal.problems.length) return refuse(`its GOAL.json does not parse (${goal.problems[0]})`);
  const name = `${goal.programme}/${goal.goal}`;
  if (!FINISHED.includes(goal.status)) return refuse(`it is ${goal.status}; only a done or dropped goal is archived (mc goal drop ${name} --reason "…" lets it go)`);
  const waiting = all.filter((other) => !FINISHED.includes(other.status) && (other.after ?? []).includes(name)).map((other) => `${other.programme}/${other.goal}`);
  if (waiting.length) return refuse(`${waiting.join(', ')} start${waiting.length === 1 ? 's' : ''} after it — mc goal after changes that first`);
  const repos = known();
  const bareOf = (repo) => repos.find((path) => repoNameOf(path) === repo) ?? null;
  const branch = `goal/${goal.goal}`;
  for (const repo of goal.repos) {
    const path = join(goal.dir, repo);
    const status = git(path, ['status', '--porcelain']);
    if (status.ok && status.stdout.trim()) return refuse(`${repo}'s worktree has uncommitted changes (${path})`);
    const bare = bareOf(repo);
    if (!bare) return refuse(`${repo} is not a repository mc knows, so its worktree cannot be removed`);
    const open = gh(bare, ['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number']);
    let numbers = [];
    try { numbers = open.ok ? JSON.parse(open.stdout || '[]').map((item) => item.number) : []; } catch { numbers = []; }
    if (!open.ok) return refuse(`GitHub could not say whether ${repo} has an open pull request on ${branch}`);
    if (numbers.length) return refuse(`${repo} #${numbers.join(', #')} on ${branch} is open — land or close it first`);
    if (goal.status === 'dropped' && git(bare, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
      const unpushed = git(bare, ['rev-list', '--count', branch, '--not', '--remotes']);
      if (!unpushed.ok || Number(unpushed.stdout.trim()) > 0) return refuse(`${repo}'s ${branch} has commits no remote holds — publish them or say so in a pull request first`);
    }
  }
  for (const item of goal.prs ?? []) {
    const bare = bareOf(item.repo);
    if (!bare) return refuse(`${prRef(item)} is in a repository mc does not know`);
    const view = gh(bare, ['pr', 'view', String(item.pr), '--json', 'state']);
    let state = null;
    try { state = view.ok ? JSON.parse(view.stdout || 'null')?.state ?? null : null; } catch { state = null; }
    if (state === null) return refuse(`GitHub could not say where ${prRef(item)} stands`);
    if (state === 'OPEN') return refuse(`${prRef(item)} is open — land or close it first`);
  }
  for (const repo of goal.repos) {
    const path = join(goal.dir, repo);
    const bare = bareOf(repo);
    if (git(path, ['rev-parse', '--is-inside-work-tree']).ok) {
      const removed = git(bare, ['worktree', 'remove', path]);
      if (!removed.ok) return refuse(`${repo}'s worktree could not be removed (${removed.stderr.trim() || 'git failed'})`);
    }
    git(bare, ['worktree', 'prune']);
    if (git(bare, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
      const deleted = git(bare, ['branch', '-D', branch]);
      if (!deleted.ok) return refuse(`${repo}'s ${branch} could not be deleted (${deleted.stderr.trim() || 'git failed'}); its worktree is gone`);
    }
  }
  const archive = archiveDirIn(home, goal.programme);
  const stamp = now.toISOString().slice(0, 10);
  let to = join(archive, goal.goal);
  if (read(join(to, GOAL_FILE)) !== null) to = join(archive, `${goal.goal}-${now.toISOString().replace(/[-:]/gu, '').slice(0, 13)}`);
  try {
    move(goal.dir, to);
  } catch (error) {
    return refuse(`${goal.dir} could not be moved to ${to} (${error?.message || error}); its worktrees are gone`);
  }
  const logPath = join(home, goal.programme, GOALS_DIR, GOAL_LOG_FILE);
  appendText(logPath, `${read(logPath) === null ? GOAL_LOG_HEAD : ''}${goalLogRow({ date: stamp, goal: goal.goal, status: goal.status, prs: goal.prs, log: goal.log })}\n`);
  return { to };
}
