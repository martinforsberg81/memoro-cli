/**
 * Archiving a finished goal — the rules `mc goal archive` and the runner share.
 *
 * A goal that is `done` or `dropped` leaves the list by one road whoever asks:
 * `archiveGoal` refuses what `mc goal archive` refuses, with the reason, and
 * touches nothing when it does; otherwise each worktree is removed through git,
 * the goal's branch deleted, its directory moved to `goals/.archive/`, and one
 * row written to `goals/goal_log.md`; the programme's phases are then
 * renumbered (`renumberPhases`), so when the last goal of the lowest phase
 * leaves, the next phase is phase 1. The runner calls it once a goal has been
 * finished for `ARCHIVE_HOLD_MS`. A programme is never archived by the runner.
 *
 * The rules take what they need as arguments: `git`, `gh`, `known`, `move`,
 * `appendText`, `read`, `list`, `write` and `now` come from the caller, as goal.js and run.js
 * hand them over, so the tests use a file model and no repository.
 */
import { renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { appendLog, archiveDirIn, FINISHED, GOAL_FILE, GOAL_LOG_FILE, GOAL_LOG_HEAD, GOALS_DIR, goalBranch, goalLogRow, listDirsOf, LOG_FILE, logStamp, parseLog, prRef, renumberPhases, stageSince, updateGoal } from './goals.js';
import { writeFileAtomic } from './atomic-write.js';
import { repoNameOf } from './repos.js';
import { dequeue, mergesPath, parseQueue } from './merge-queue.js';
import { admitWriter } from './programme-lifecycle.js';

/** How long a finished goal stays listed before the runner archives it. */
export const ARCHIVE_HOLD_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether the runner archives this goal now: dropped work is due immediately;
 * done retains its configured hold, counted from the stage-setting log entry.
 */
export function goalArchiveDue({ goal, nowMs, holdMs = ARCHIVE_HOLD_MS }) {
  if (!FINISHED.includes(goal.stage)) return { due: false, why: `the goal is in ${goal.stage}` };
  if (goal.stage === 'dropped') return { due: true, why: 'dropped — abandoned work is finalized immediately' };
  const at = stageSince(goal);
  if (!at || Number.isNaN(Date.parse(at))) return { due: false, why: `the log does not say when it was ${goal.stage}` };
  const since = nowMs - Date.parse(at);
  const hours = Math.max(0, Math.floor(since / HOUR_MS));
  if (since < holdMs) return { due: false, why: `${goal.stage} ${hours}h ago — archived after ${Math.round(holdMs / HOUR_MS)}h` };
  return { due: true, why: `${goal.stage} ${hours}h ago` };
}

/**
 * Finalize an abandoned goal before archiving it. Persisting the dropped stage
 * is the caller's first step; this operation is safe to retry after any
 * external failure. `allGoals` includes archived records so an old reference
 * cannot make a manual queue entry look ownerless.
 */
export function finalizeDroppedGoal(goal, options) {
  return withGoalArchiveLease(goal, options, () => finalizeDroppedGoalAdmitted(goal, options));
}

function finalizeDroppedGoalAdmitted(goal, {
  allGoals = () => [], root = null, lock = (_root, fn) => fn(), readQueue,
  writeQueue, active = () => false, ...archive
}) {
  if (goal.stage !== 'dropped') return { refused: 'the goal is not dropped' };
  if (active(goal)) return { refused: `a live session still owns ${goal.programme}/${goal.goal}; its worktrees are retained until the session ends` };
  let subject = goal;
  const repos = archive.known();
  const bareOf = (repo) => repos.find((path) => repoNameOf(path) === repo) ?? null;
  const branch = goalBranch({ git: archive.git, dir: subject.dir, goal: subject.goal, repo: subject.repos[0] });
  const candidates = new Map((subject.prs ?? []).map((pr) => [`${pr.repo}#${pr.pr}`, pr]));
  for (const repo of subject.repos) {
    const bare = bareOf(repo);
    if (!bare) return { refused: `${repo} is not a repository mc knows` };
    const listed = archive.gh(bare, ['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number']);
    if (!listed.ok) return { refused: `GitHub could not say whether ${repo} has an open pull request on ${branch}` };
    let prs;
    try { prs = JSON.parse(listed.stdout || '[]'); } catch { return { refused: `GitHub returned unreadable open pull requests for ${repo} on ${branch}` }; }
    for (const pr of prs) candidates.set(`${repo}#${Number(pr.number)}`, { repo, pr: Number(pr.number) });
  }
  const additions = [...candidates.values()].filter((pr) => !(subject.prs ?? []).some((item) => item.repo === pr.repo && Number(item.pr) === Number(pr.pr)));
  if (additions.length) {
    const saved = updateGoal({ dir: subject.dir, change: (current) => ({ ...current, prs: [...current.prs, ...additions] }), read: archive.read, write: archive.write });
    if (saved.problems) return { refused: `branch-discovered PR ownership could not be recorded (${saved.problems.join('; ')})` };
    subject = { ...subject, prs: saved.goal.prs };
  }
  const preserved = [];
  const abandoned = [];
  let refs = [];
  try { refs = allGoals() || []; } catch { return { refused: 'goal references could not be read; no pull request was closed' }; }
  for (const pr of candidates.values()) {
    const owners = refs.filter((ref) => ref.programme !== subject.programme || ref.goal !== subject.goal)
      .filter((ref) => (ref.prs ?? []).some((item) => item.repo === pr.repo && Number(item.pr) === Number(pr.pr)));
    const liveOwners = owners.filter((ref) => !FINISHED.includes(ref.stage));
    if (liveOwners.length) { preserved.push({ pr, owners: liveOwners }); continue; }
    abandoned.push(pr);
  }
  for (const { pr, owners } of preserved) {
    const comment = `preserved ${prRef(pr)} — still owned by unfinished goal${owners.length === 1 ? '' : 's'} ${owners.map((owner) => `${owner.programme}/${owner.goal}`).join(', ')}; its PR and merge work remain`;
    const logPath = join(subject.dir, LOG_FILE);
    const current = archive.read(logPath) ?? '';
    if (!parseLog(current).some((entry) => entry.comment === comment)) {
      const appended = appendLog(current, { at: logStamp(archive.now), tool: 'runner', model: null, stage: 'dropped', status: subject.status, done: null, comment, next: null });
      archive.appendText(logPath, `${appended.slice(current.length ? current.replace(/\s+$/u, '').length : 0)}`);
    }
  }
  for (const pr of abandoned) {
    const bare = bareOf(pr.repo);
    if (!bare) return { refused: `${pr.repo} is not a repository mc knows` };
    const view = archive.gh(bare, ['pr', 'view', String(pr.pr), '--json', 'state']);
    let state;
    try { state = view.ok ? JSON.parse(view.stdout || 'null')?.state : null; } catch { state = null; }
    if (state === null || state === undefined) return { refused: `GitHub could not say where ${pr.repo}#${pr.pr} stands` };
    if (state === 'OPEN') {
      const closed = archive.gh(bare, ['pr', 'close', String(pr.pr), '--comment', `Goal ${subject.programme}/${subject.goal} was dropped; delivery is abandoned.`]);
      if (!closed.ok) return { refused: `GitHub could not close ${pr.repo}#${pr.pr} (${closed.stderr?.trim() || 'close failed'})` };
      const confirm = archive.gh(bare, ['pr', 'view', String(pr.pr), '--json', 'state']);
      try { state = confirm.ok ? JSON.parse(confirm.stdout || 'null')?.state : null; } catch { state = null; }
      if (state !== 'CLOSED' && state !== 'MERGED') return { refused: `GitHub did not confirm ${pr.repo}#${pr.pr} closed` };
    } else if (state !== 'CLOSED' && state !== 'MERGED') return { refused: `GitHub returned an unknown state for ${pr.repo}#${pr.pr}` };
  }
  if (root && readQueue && writeQueue) {
    try {
      lock(root, () => {
        let entries = parseQueue(readQueue(mergesPath(root)));
        for (const pr of abandoned) entries = dequeue(entries, pr);
        writeQueue(mergesPath(root), entries);
      }, { name: 'merges' });
    } catch (error) {
      return { refused: `merge work could not be cancelled (${error?.message || error})` };
    }
  }
  const result = archiveGoal(subject, { ...archive, active, sharedPrs: preserved.map(({ pr }) => pr) });
  if (!result.refused && preserved.length) result.preserved = preserved;
  return result;
}

/** A directory moved, its new parent made first. Throws when the destination is there. */
export function moveDir(from, to) {
  mkdirSync(join(to, '..'), { recursive: true });
  if (existsSync(to)) throw new Error(`${to} exists`);
  renameSync(from, to);
}

/**
 * One goal archived, or why not. `goal` is a goal as `programsGoals` gives it.
 * Returns `{ to, renumbered }` when it moved — `renumbered` the phase moves
 * made (`renumberPhases`) — else
 * `{ refused }` with the reason; a refusal touches nothing. What the context
 * holds: `home` (the programmes home), `git(cwd, args)` and `gh(cwd, args)` as
 * `{ ok, stdout, stderr }`, `known()` (the repositories' paths), `move(from, to)`
 * (throws when it fails), `appendText(path, text)`, `read(path)`, `list(path)`,
 * `write(path, text)` and `now`, a Date.
 */
export function archiveGoal(goal, options) {
  return withGoalArchiveLease(goal, options, () => archiveGoalAdmitted(goal, options));
}

function archiveGoalAdmitted(goal, { home, git, gh, known, move = moveDir, appendText, read, list = listDirsOf, write = writeFileAtomic, exists = existsSync, now, sharedPrs = [], active = () => false }) {
  const refuse = (refused) => ({ refused });
  if (goal.problems.length) return refuse(`its GOAL.json does not parse (${goal.problems[0]})`);
  const name = `${goal.programme}/${goal.goal}`;
  if (!FINISHED.includes(goal.stage)) return refuse(`it is in ${goal.stage}; only a done or dropped goal is archived (mc goal drop ${name} --reason "…" lets it go)`);
  if (active(goal)) return refuse(`a live session still owns ${name}; its worktrees are retained until the session ends`);
  const repos = known();
  const bareOf = (repo) => repos.find((path) => repoNameOf(path) === repo) ?? null;
  const branch = goalBranch({ git, dir: goal.dir, goal: goal.goal, repo: goal.repos[0] });
  for (const repo of goal.repos) {
    const path = join(goal.dir, repo);
    const status = git(path, ['status', '--porcelain']);
    if (goal.stage === 'dropped' && !status.ok && exists(path)) return refuse(`${repo}'s worktree could not be inspected (${path}); its edits are retained`);
    if (status.ok && status.stdout.trim()) return refuse(`${repo}'s worktree has uncommitted changes (${path})`);
    const bare = bareOf(repo);
    if (!bare) return refuse(`${repo} is not a repository mc knows, so its worktree cannot be removed`);
    const open = gh(bare, ['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number']);
    let numbers = [];
    try { numbers = open.ok ? JSON.parse(open.stdout || '[]').map((item) => item.number) : []; } catch { numbers = []; }
    if (!open.ok) return refuse(`GitHub could not say whether ${repo} has an open pull request on ${branch}`);
    const exclusive = numbers.filter((number) => !sharedPrs.some((pr) => pr.repo === repo && Number(pr.pr) === Number(number)));
    if (exclusive.length) return refuse(`${repo} #${exclusive.join(', #')} on ${branch} is open — land or close it first`);
    if (goal.stage === 'dropped' && git(bare, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
      const unpushed = git(bare, ['rev-list', '--count', branch, '--not', '--remotes']);
      if (!unpushed.ok || Number(unpushed.stdout.trim()) > 0) return refuse(`${repo}'s ${branch} has commits no remote holds — publish them or say so in a pull request first`);
    }
  }
  for (const item of goal.prs ?? []) {
    if (sharedPrs.some((pr) => pr.repo === item.repo && Number(pr.pr) === Number(item.pr))) continue;
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
  appendText(logPath, `${read(logPath) === null ? GOAL_LOG_HEAD : ''}${goalLogRow({ date: stamp, goal: goal.goal, status: goal.stage, prs: goal.prs, log: goal.log })}\n`);
  const renumbered = renumberPhases({ home, programme: goal.programme, list, read, write });
  return { to, renumbered };
}

function withGoalArchiveLease(goal, options, operation) {
  const env = options.env || process.env;
  let lease;
  try { lease = (options.lifecycle || admitWriter)([goal.programme], { env, name: 'goal archive' }); }
  catch (error) { return { refused: error.message }; }
  try { return operation(); } finally { lease.release(); }
}
