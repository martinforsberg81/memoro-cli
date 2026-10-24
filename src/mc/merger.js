/**
 * The merger — one process that lands the pull requests `mc merge` queued,
 * one at a time (ruling 30, 2026-10-09).
 *
 * Martin: *"Jag ser framför mig att merge är en separat pid. När man lägger
 * något i kön, dvs. mc merge repo pr så bara hamnar det i en kö. Samma pid kör
 * sedan en i taget av de pr som den fått till sig. Just nu blir flera
 * processer hängande eller väntande på detta."*
 *
 * Until then every `mc merge` waited for the gate itself, and so did the
 * runner's own landing of a session's pull request (ruling 25): six lanes
 * could be six processes polling one lock, each giving up after eight
 * minutes and asking to be run again. Now:
 *
 *   - `queueMerge` is what `mc merge` and the runner call: the step (if the
 *     pull request is one) is `landing` in the register, the job is in
 *     `merges.json`, and a merger is running. It returns at once.
 *   - `serve` is the merger: take the oldest job, run the round, write the
 *     register, drop the job — or keep it as `red` with the reason, for the
 *     page — take the next; leave when nothing is left in line.
 *   - `merger.json` is its pid. Taken with `O_EXCL`; a file naming a dead pid
 *     is a merger that was killed, and the next `mc merge` (or the runner's
 *     next read of the world) starts another, which lands the job the dead
 *     one had — the round itself says whether it already merged.
 *
 * The gate lock and the repository lease are what they were: the merger's
 * round takes both, so a person's `mc test` and the merger never measure at
 * once in one lane. There is a lock per gate lane (ruling 34, gate-lock.js),
 * and the merger runs one loop per lane: memoro-cli's minute-long rounds no
 * longer wait behind memoro's fifteen. Still one process and one pid. The merger waits them out; it has nobody to give up to. It waits out
 * a running deploy the same way, before a round and never inside one: the
 * deployer lets the round in flight finish, builds alone, and the queue goes
 * on after it.
 */
import { spawn as realSpawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './atomic-write.js';
import { runTool } from './child-async.js';
import { dropPr } from './page-cache.js';
import { runningDeploy } from './deploys.js';
import { GATE_LANES, runningRound } from './gate-lock.js';
import {
  dequeue, enqueue, heldLanding, inLine, markLanding, markMended, markMending, markQueued, markRed, markRequeued, MERGE_BATCH_MAX, mergesPath, nextBatch, parseQueue,
  placeOf, queuedFor, stepsDone,
} from './merge-queue.js';
import { MEND_AT_ONCE, mendedReason, mendLine } from './mend.js';
import { removeRedDetail, writeRedDetail } from './merge-red.js';
import { landedPatch, landingPatch, redPatch, shouldWait } from './merge-step.js';
import { readEntry, realLock, updateStep } from './register.js';
import { gateLaneOf } from './repo-gate-table.js';
import { readLease } from './repo-lease.js';
import { runMergeRound } from './repo-merge.js';
import { sourceLinkedInstallations } from './repo-status.js';
import { recordRound, recordRoundStart } from './repo-round-log.js';
import { tsvHeader, tsvRow } from './run-plan.js';
import { pidAlive } from './status-collect.js';

const MERGER_RUN = fileURLToPath(new URL('./merger-run.js', import.meta.url));

/**
 * Where a detached mc process is started from: `relative` in the checkout the
 * first `mc` on PATH resolves to, never the caller's own tree. A step session
 * that runs `node src/mc-cli.js merge` in its workarea would otherwise start a
 * merger on its branch's code (2026-10-10, merger 14366 ran the merge-watch
 * branch for fifteen minutes). `{ path, installed }`; `installed` false is
 * `fallback`, because no installed mc has that file.
 */
export function installedScript(relative, fallback, env = process.env) {
  const install = sourceLinkedInstallations(env).find((item) => item.command === 'mc');
  const path = install ? join(install.root, relative) : null;
  if (path && existsSync(path)) return { path, installed: true };
  return { path: fallback, installed: false };
}

/** The merger's script in the installed mc — `installedScript` for `merger-run.js`. */
export function installedMergerRun(env = process.env) {
  return installedScript(join('src', 'mc', 'merger-run.js'), MERGER_RUN, env);
}

/** How often the merger looks again at a gate lock or a lease somebody else holds. */
export const MERGER_POLL_MS = 15 * 1000;

/**
 * How often an idle merger asks GitHub about its red rows: one `gh pr view`
 * per red entry, so not every poll; a hand merge seen five minutes late costs
 * a red row on the page for five minutes.
 */
const SWEEP_MS = MERGER_POLL_MS * 20;

/**
 * What a session's environment must not hand the merger: the merger outlives
 * the session that started it and lands everybody's pull requests, so a
 * `MC_STEP` it inherited would name one step for all of them.
 */
const SESSION_ENV = ['MC_STEP', 'MC_PROJECT', 'MC_REPO', 'MC_WORKAREA', 'MC_SCRATCH'];

export function mergerPath(root) {
  return join(root, 'runner', 'merger.json');
}

export function mergerLogPath(root) {
  return join(root, 'runner', 'log', 'merger.log');
}

const realRead = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

/** The merger running now — `{ pid, since, commit }` — or null. A dead pid is nobody. */
export function readMerger({ root, read = realRead, alive = pidAlive } = {}) {
  let raw = null;
  try { raw = JSON.parse(read(mergerPath(root)) || 'null'); } catch { return null; }
  if (!Number.isInteger(raw?.pid) || !alive(raw.pid)) return null;
  return raw;
}

/**
 * This process is the merger now, or another one is. One `O_EXCL` create; a
 * file naming a dead pid — or this process, from an earlier take — is taken
 * over.
 */
export function takeMerger({ root, alive = pidAlive, now = new Date(), pid = process.pid, commit = null } = {}) {
  const path = mergerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  for (let tries = 0; tries < 3; tries += 1) {
    try {
      const fd = openSync(path, 'wx', 0o644);
      writeSync(fd, JSON.stringify({ pid, since: now.toISOString(), ...(commit ? { commit } : {}) }));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      let held = null;
      try { held = JSON.parse(realRead(path) || 'null'); } catch { held = null; }
      if (held?.pid && held.pid !== pid && alive(held.pid)) return false;
      try { rmSync(path, { force: true }); } catch { /* raced */ }
    }
  }
  return false;
}

/** Give it back — only if it is still this process's. */
export function releaseMerger({ root, pid = process.pid } = {}) {
  try {
    const held = JSON.parse(realRead(mergerPath(root)) || 'null');
    if (held?.pid !== pid) return false;
    rmSync(mergerPath(root), { force: true });
    return true;
  } catch { return false; }
}

/**
 * A merger, running: the one there is, or a new one started detached with
 * its output in `merger.log`. `{ pid, started }`; `pid` is null when the
 * spawn itself failed, and the job waits in the queue for the next start.
 * It runs the installed mc's `merger-run.js`, whoever calls this.
 */
export function startMerger({
  root, env = process.env, spawn = realSpawn, alive = pidAlive, now = () => new Date(),
} = {}) {
  const running = readMerger({ root, alive });
  if (running) return { pid: running.pid, started: false };
  const log = mergerLogPath(root);
  let fd = null;
  try {
    mkdirSync(dirname(log), { recursive: true });
    fd = openSync(log, 'a', 0o644);
    const run = installedMergerRun(env);
    if (!run.installed) writeSync(fd, `${now().toISOString()}  merger started from ${run.path} — no installed mc found\n`);
    const childEnv = { ...env, MC_WORK_ROOT: env.MC_WORK_ROOT || root };
    for (const key of SESSION_ENV) delete childEnv[key];
    const child = spawn(process.execPath, [run.path, '--root', root], {
      cwd: root, detached: true, stdio: ['ignore', fd, fd], env: childEnv,
    });
    child.unref();
    return { pid: child.pid ?? null, started: true };
  } catch (error) {
    return { pid: null, started: false, error: error?.message || String(error) };
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** After a merger left for new code: a successor on the installed checkout while jobs remain in line, or nothing. Returns the line it said. */
export function succeed({ root, movedTo = null, read = realRead, start = startMerger, say = () => {} } = {}) {
  const waiting = inLine(parseQueue(read(mergesPath(root)))).length;
  if (!waiting) {
    const line = 'nothing in line — no successor started; the next mc merge starts one';
    say(line);
    return line;
  }
  const next = start({ root });
  const line = next.pid
    ? `successor pid ${next.pid} started on ${movedTo || 'the new code'} for ${waiting} job${waiting === 1 ? '' : 's'} in line`
    : `no successor started (${next.error || 'no pid'}) — the runner's next pass starts one`;
  say(line);
  return line;
}

/**
 * The HEAD of the checkout `mc` on PATH runs from: what the next merger would
 * run. Local, no network. `git(cwd, args)` returns `{ status, stdout }`; it is
 * handed in, because the merger's own path holds no synchronous child
 * (child-async.test.js) and `mc merge watch` may.
 */
export function installedHead({ env = process.env, git = null } = {}) {
  const install = sourceLinkedInstallations(env).find((item) => item.command === 'mc');
  if (!install || !git) return null;
  const r = git(install.root, ['rev-parse', '--short', 'HEAD']);
  return r?.status === 0 ? String(r.stdout || '').trim() || null : null;
}

// Two short shas of different lengths name one commit when one starts the other.
function sameCommit(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  return Boolean(x && y) && (x.startsWith(y) || y.startsWith(x));
}

/**
 * Hand a pull request to the merger. The register first — the step is
 * `landing` with its pull request — then the job, then a merger to take it.
 * Returns `{ place, merger, already }`: `place` 0 is next, `already` when the
 * merger is landing this very pull request now.
 */
export function queueMerge({
  root, repo, repoPath, pr, branch = null, holder = null, step = null, parent = null,
  now = new Date(), env = process.env,
  read = realRead, write = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
  lock = realLock, start = startMerger,
} = {}) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  if (step) {
    updateStep({ root, project: step.project, index: step.index, patch: landingPatch({ pr, branch }), now: stamp, read, write, lock });
  }
  const job = {
    repo, repo_path: repoPath, pr: Number(pr), branch, holder, since: stamp, state: 'queued',
    step: step ? { project: step.project, index: step.index } : null,
    parent,
  };
  const entries = lock(root, () => {
    const next = enqueue(parseQueue(read(mergesPath(root))), job);
    write(mergesPath(root), next);
    return next;
  });
  const already = queuedFor(entries, repo, pr)?.state === 'landing';
  const merger = start({ root, env });
  return { place: placeOf(entries, repo, pr), merger, already };
}

/**
 * Whether the job a stacked job is built on has landed: its step is `done`
 * in the register. A parent with no step to read is taken as landed — the
 * queue's own order has already kept the two apart.
 */
export function parentLanded(root, { read = realRead } = {}) {
  return (parent) => {
    if (!parent?.project || !Number.isInteger(parent.index)) return true;
    return readEntry(root, parent.project, { read })?.steps?.[parent.index]?.status === 'done';
  };
}

/**
 * Whether every earlier step of a job's plan is `done` in the register
 * (`stepsDone`, merge-queue.js): a plan's steps land in order, with or
 * without a `parent`. A register that cannot be read is taken as done, as in
 * `parentLanded`.
 */
export function stepsBeforeDone(root, { read = realRead } = {}) {
  return stepsDone((project) => readEntry(root, project, { read })?.steps ?? null);
}

// Without holding the event loop: a restack of a memoro branch took 29 s on
// 2026-10-10, and the other lane stood still for all of it.
const realGit = async (cwd, args) => {
  const r = await runTool('git', args, { cwd });
  return { ok: r.status === 0, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
};

/**
 * A stacked branch moved onto main once the job below it has landed
 * (ruling 30, A). The one below was squash-merged, so its commits are in
 * this branch and not on main under the same names. Only this step's own
 * commits are replayed onto origin/main: the non-merge commits on the tip
 * that are neither on the sha this branch started on nor on main (ruling 38)
 * — a `rebase --onto` would also replay what a merge of main, or a parent
 * moved after the stack, brought in. A pick that main already has is empty
 * and skipped. A pick that conflicts falls back to merging origin/main into
 * the tip, as `freshenBranchForLanding` does; only a conflicting merge is a
 * stop. The branch is pushed back with a lease on the tip it had. A branch
 * that no longer carries that sha was moved already. Returns
 * `{ ok, moved, reason }`.
 */
export async function restack(job, { git = realGit, say = () => {} } = {}) {
  const repoPath = job.repo_path;
  const branch = job.branch;
  if (!branch || !job.parent?.sha) return { ok: true, moved: false };
  if (!(await git(repoPath, ['fetch', '-q', 'origin'])).ok) return { ok: false, reason: 'git fetch failed before moving the branch onto main' };
  const tip = await git(repoPath, ['rev-parse', `origin/${branch}`]);
  if (!tip.ok) return { ok: false, reason: `origin/${branch} is not there to move onto main` };
  if (!(await git(repoPath, ['merge-base', '--is-ancestor', job.parent.sha, tip.stdout])).ok) return { ok: true, moved: false };
  const dir = mkdtempSync(join(tmpdir(), 'mc-restack-'));
  try {
    if (!(await git(repoPath, ['worktree', 'add', '-q', '--detach', dir, tip.stdout])).ok) return { ok: false, reason: 'git worktree add failed for the move onto main' };
    const conflictedIn = async () => (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    const own = await git(dir, ['rev-list', '--reverse', '--no-merges', tip.stdout, `^${job.parent.sha}`, '^origin/main']);
    if (!own.ok) return { ok: false, reason: `git rev-list failed listing ${branch}'s own commits` };
    let replayed = (await git(dir, ['checkout', '-q', '--detach', 'origin/main'])).ok;
    for (const sha of replayed ? own.stdout.split('\n').filter(Boolean) : []) {
      if ((await git(dir, ['cherry-pick', sha])).ok) continue;
      // An empty pick — main already has it as a squash — is no conflict.
      if (!(await conflictedIn()).length && (await git(dir, ['cherry-pick', '--skip'])).ok) continue;
      await git(dir, ['cherry-pick', '--abort']);
      replayed = false;
      break;
    }
    if (!replayed) {
      if (!(await git(dir, ['checkout', '-q', '--detach', tip.stdout])).ok) return { ok: false, reason: `git checkout of ${branch}'s tip failed for the move onto main` };
      if (!(await git(dir, ['merge', '--no-edit', 'origin/main'])).ok) {
        const conflicted = await conflictedIn();
        await git(dir, ['merge', '--abort']);
        return { ok: false, reason: `moving #${job.pr} onto main after #${job.parent.pr} landed conflicts${conflicted.length ? ` in ${conflicted.join(' ')}` : ''} — merge origin/main into ${branch} and keep both intents` };
      }
    }
    const pushed = await git(dir, ['push', '-q', `--force-with-lease=${branch}:${tip.stdout}`, 'origin', `HEAD:${branch}`]);
    if (!pushed.ok) return { ok: false, reason: `the moved ${branch} could not be pushed (${pushed.stderr.split('\n').at(-1) || 'push refused'})` };
    say(`${job.repo} #${job.pr}: moved onto main past #${job.parent.pr}${replayed ? '' : ' (merged main in)'}`);
    return { ok: true, moved: true };
  } finally {
    await git(repoPath, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

// The call merger-run.js makes, for a caller that hands no `gh`.
const realGh = (args, options = {}) => runTool('gh', args, { cwd: options.cwd });

/**
 * What GitHub says of a job's pull request: `{ state, sha, base }` for
 * `MERGED`, `CLOSED` or `OPEN`, or null when `gh` fails or says nothing — a
 * null is no answer, and the round decides as it always did.
 */
async function prStateOf(job, gh) {
  try {
    const seen = await gh(['pr', 'view', String(job.pr), '--json', 'state,mergeCommit,baseRefName'], { cwd: job.repo_path });
    if (!seen || seen.error || (Number.isInteger(seen.status) && seen.status !== 0)) return null;
    const facts = JSON.parse(seen.stdout || 'null');
    const state = facts?.state;
    if (state === 'MERGED') return facts.mergeCommit?.oid ? { state, sha: facts.mergeCommit.oid, base: facts.baseRefName || null } : null;
    return state === 'CLOSED' || state === 'OPEN' ? { state } : null;
  } catch { return null; }
}

/** The answer for a pull request somebody merged on GitHub outside the queue. */
const alreadyMerged = (facts) => ({
  ok: true, merged: true, merge_commit: facts.sha, merged_into: facts.base, already_merged: true, stopped_at: null, reason: null,
});

/** The answer for a pull request closed on GitHub without merging. */
const closedOnGitHub = (job) => ({
  ok: false, merged: false, stopped_at: 'closed', reason: `#${job.pr} was closed on GitHub without merging`,
});

/**
 * Red entries whose pull request has left GitHub's open list since: a merged
 * one is dequeued and its step `done` (the `tell` path, landed), a closed one
 * is dequeued with the register left as it is (2026-10-10: #13370 and #13372
 * sat red after being merged by hand). GitHub is asked outside the lock; an
 * entry `mc merge` queued again meanwhile is not red any more and is left.
 * Returns the number of entries dequeued.
 */
export async function sweepMergedReds({
  root, gh = null, read = realRead, write = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
  lock = realLock, say = () => {}, now = () => new Date(),
} = {}) {
  const ask = gh || realGh;
  const reds = parseQueue(read(mergesPath(root))).filter((entry) => entry.state === 'red');
  const gone = [];
  for (const entry of reds) {
    const facts = await prStateOf(entry, ask);
    if (facts?.state === 'MERGED' || facts?.state === 'CLOSED') gone.push({ entry, facts });
  }
  if (!gone.length) return 0;
  const dropped = lock(root, () => {
    let entries = parseQueue(read(mergesPath(root)));
    const out = gone.filter(({ entry }) => queuedFor(entries, entry.repo, entry.pr)?.state === 'red');
    for (const { entry } of out) entries = dequeue(entries, entry);
    if (out.length) write(mergesPath(root), entries);
    return out;
  });
  for (const { entry, facts } of dropped) {
    if (facts.state === 'MERGED') {
      await tell(entry, true, alreadyMerged(facts), {
        root, say, gh, now, read, write, lock, appendRun: null, dropFromPage: dropPr, seconds: 0,
      });
    } else {
      say(`${entry.repo} #${entry.pr}: closed on GitHub — its red row leaves the queue`);
    }
  }
  return dropped.length;
}

/* ------------------------------------------------------------------ serve */

/**
 * Each job of a batch with its own answer: `[{ job, landed, report }]`.
 * A single round's report is every job's. A batch's (`report.batch`) is
 * split: a job's own fallback round when it had one; else the batch report
 * with this job's `merges` entry in it; and a job the batch stopped before
 * reaching gets the batch's stop.
 */
export function answersFor(jobs, report) {
  const isLanded = (r) => Boolean(r?.ok && r.merged && !r.off_default);
  if (!report?.batch) return jobs.map((job) => ({ job, landed: isLanded(report), report }));
  const { merges = [], rounds = [] } = report.batch;
  return jobs.map((job) => {
    const own = rounds.find((round) => Number(round?.pr?.number) === Number(job.pr));
    if (own) return { job, landed: isLanded(own), report: own };
    const entry = merges.find((item) => Number(item.number) === Number(job.pr));
    const mine = entry?.merged
      ? {
        ...report, ok: true, merged: true, merge_commit: entry.merge_commit, stopped_at: null, reason: null,
        merged_into: report.merged_into || report.pr?.base || null,
      }
      : {
        ...report, ok: false, merged: false, merge_commit: null,
        stopped_at: report.stopped_at || 'batch', reason: entry?.error || report.reason,
      };
    return { job, landed: isLanded(mine), report: mine };
  });
}

/**
 * A batch of jobs for one repository (one job is a batch of one), landed or
 * answered: move the stacked ones onto main, wait while somebody else
 * measures, run one round over all of them, record it, and write each job's
 * own answer. Each answer is written to the register and told to `onAnswer`
 * when it is given, so the queue and the page know an answer given before
 * the round (a restack refused, merged or closed on GitHub) for the whole
 * round. Returns the answers, `[{ job, landed, report }]`.
 */
export async function landJob(batch, {
  root, mergeRound = runMergeRound, sleep, say, gh = null,
  readRunningRound = runningRound, readLeaseFn = readLease, alive = pidAlive,
  readRunningDeploy = () => runningDeploy({ ...process.env, MC_WORK_ROOT: root }),
  now = () => new Date(), read = realRead, write, lock = realLock,
  recordStart = recordRoundStart, record = recordRound, appendRun = null,
  moveOntoMain = restack,
  // The page's PR cache, told at once (page-cache.js `dropPr`).
  dropFromPage = dropPr,
  // The gate lane the batch's repository runs in: the round waited for is
  // the one in this lane, and a round in the other lane is no reason to wait.
  lane = 'heavy',
  // Whether a red gets its one mend first (mend.js `mayMend`). Off unless
  // the caller mends: `serve` with a `mend` is what sets such a job aside.
  mayMend = () => false,
  // Told each answer as it is given, after the register is written: `serve`
  // writes the queue and starts a mend from it.
  onAnswer = null,
} = {}) {
  const t0 = now().getTime();
  const answers = [];
  const answer = async (job, landed, report) => {
    const mending = !landed && mayMend(job, report);
    const requeued = !landed && !mending && mayRequeue(job, report);
    const flags = { ...(mending ? { mending: true } : {}), ...(requeued ? { requeued: true } : {}) };
    answers.push({ job, landed, report, ...flags });
    await tell(job, landed, report, {
      root, say, gh, now, read, write, lock, appendRun, dropFromPage, seconds: Math.round((now().getTime() - t0) / 1000), mending, requeued,
    });
    // Outside any lock: `tell` has let go of the register's, and the queue's
    // is the same lock, which a second take by this process waits 5 s for.
    if (onAnswer) {
      try {
        await onAnswer({ job, landed, report, ...flags });
      } catch (error) {
        say(`${job.repo} #${job.pr}: the queue could not be told (${error?.message || error}) — written after the round`);
      }
    }
  };
  const jobs = [];
  for (const job of [].concat(batch)) {
    // Built on a job that has landed since: onto main first, or the round
    // measures the one below a second time and the squash conflicts with it.
    // One that cannot be moved is answered now and leaves the batch.
    if (job.parent) {
      const moved = await moveOntoMain(job, { say });
      if (!moved.ok) { await answer(job, false, { ok: false, merged: false, stopped_at: 'restack', reason: moved.reason }); continue; }
    }
    jobs.push(job);
  }
  // Asked first: a pull request somebody merged or closed on GitHub is
  // answered by itself and leaves the batch, rather than stopping the round
  // for everyone in it (2026-10-10 17:52, #13372 turned #13373 and #13374 red).
  const ask = gh || realGh;
  for (const one of [...jobs]) {
    const facts = await prStateOf(one, ask);
    if (facts?.state === 'MERGED') await answer(one, true, alreadyMerged(facts));
    else if (facts?.state === 'CLOSED') await answer(one, false, closedOnGitHub(one));
    else continue;
    jobs.splice(jobs.indexOf(one), 1);
  }
  if (!jobs.length) return answers;

  const [job] = jobs;
  const numbers = jobs.map((item) => item.pr);
  const label = `${job.repo} ${numbers.map((n) => `#${n}`).join(' ')}`;
  let report = null;
  let said = null;
  // A test file killed from outside the round is measured once more; a second
  // `file-killed` is answered red with its reason (ruling 38).
  let killedOnce = false;
  // So is a red that passed alone on the base and on the candidate, or a file
  // whose tests were all cancelled (`red-under-load`): the second is answered
  // red, saying the files passed alone and the round twice did not.
  let underLoadOnce = false;
  for (; !report;) {
    // Waited for before the round rather than inside it, so a busy gate is
    // not a round-log line every fifteen seconds. An orphaned lease is in
    // nobody's way: the round's own claim reaps it.
    // A deploy asked for waits for the round in flight and then runs alone;
    // the queue goes on after it (Martin, 2026-10-10). Its `running` row is
    // written before the deployer starts, so it is seen here before the
    // deployer looks at the gate.
    const deploying = readRunningDeploy();
    const running = readRunningRound({ alive, lane });
    const lease = readLeaseFn(job.repo_path);
    const blocking = lease?.held && !lease.orphaned;
    if (deploying || running || blocking) {
      const why = deploying ? `the deploy of ${String(deploying.sha || '').slice(0, 7) || '?'} (pid ${deploying.pid})`
        : running ? `another gate round in the ${lane} lane (${running.repo || 'a repository'} #${running.pr ?? '?'}, pid ${running.pid})` : `${job.repo} is held by ${lease.holder}`;
      if (why !== said) { say(`${label}: waiting behind ${why}`); said = why; }
      await sleep(MERGER_POLL_MS);
      continue;
    }
    recordStart({ repo: job.repo_path, mode: 'merge', holder: job.holder?.name || null, prs: numbers });
    // The first job's holder holds the round, the rule the gate's lease has.
    // `signals: false`: the gate installs no SIGTERM handler of its own in
    // the merger. Its exit cut the round short (2026-10-10 17:47); the
    // merger's own handler lets the round finish and leaves between jobs.
    report = await mergeRound({
      repoPath: job.repo_path, pr: job.pr, ...(jobs.length > 1 ? { prs: numbers } : {}), mode: 'merge', signals: false,
      ...(job.holder ? { holder: job.holder } : {}),
      onProgress: (message) => say(`${label}: ${message}`),
    });
    keepRed(report, { root, repo: job.repo, pr: job.pr, batch: jobs.length > 1, now });
    record(report, { mode: 'merge' });
    if (report?.stopped_at === 'file-killed' && !killedOnce) {
      killedOnce = true;
      const files = (report.killed_files || []).map((one) => one.file).join(', ') || 'a test file';
      say(`${label}: ${files} was killed from outside the round — measuring again`);
    } else if (report?.stopped_at === 'red-under-load' && !underLoadOnce) {
      underLoadOnce = true;
      const files = (report.under_load_files || []).join(', ') || 'the red files';
      say(`${label}: ${files} red only under load — measuring again`);
    } else if (!shouldWait(report)) {
      // Lost the race between "both free" and the round's own lock otherwise.
      break;
    }
    report = null;
    await sleep(MERGER_POLL_MS);
  }
  if (report?.stopped_at === 'red-under-load' && underLoadOnce) {
    report = { ...report, reason: `${report.reason}; red under load in two rounds running` };
  }

  for (const one of answersFor(jobs, report)) await answer(one.job, one.landed, one.report);
  return answers;
}

/**
 * A red round's failures written to `runner/merge-red/` and its path put on
 * the report as `red_detail` (ruling 44): for one job, the round's; for a
 * batch, each pull request's own fallback round's, by its number.
 */
function keepRed(report, { root, repo, pr, batch, now }) {
  if (!report) return;
  if (batch) {
    for (const round of report.batch?.rounds || []) {
      const path = writeRedDetail({ root, repo, pr: round?.pr?.number, report: round, now: now() });
      if (path) round.red_detail = path;
    }
    return;
  }
  const path = writeRedDetail({ root, repo, pr, report, now: now() });
  if (path) report.red_detail = path;
}

/**
 * The `land` merger-run.js hands `serve`: `landJob` with these deps and the
 * lane `serve` names, so a job's wait reads the round in its own lane. Until
 * merger-hardening step 5 the lane was dropped there, and a light job waited
 * on the heavy lane's round.
 */
export function landerFor(deps) {
  return (batch, lane, extra = {}) => landJob(batch, { ...deps, lane, ...extra });
}

/**
 * The stops that are put back in line instead of answered: a red that passed
 * alone on both commits (`red-under-load`) and a file killed from outside
 * the round (`file-killed`), each after the merger has already measured it
 * twice. Answered red, the step went back to `ready` and the runner started a
 * session to "fix it on the same pull request" that found nothing to fix —
 * note-steps #13897 paid two on 2026-10-19. Back in line instead, after
 * `REQUEUE_DELAY_MS` so the load has a chance to pass, at most
 * `MAX_REQUEUES` times; then answered red as before.
 */
export const REQUEUE_STOPS = Object.freeze(['red-under-load', 'file-killed']);
export const MAX_REQUEUES = 2;
export const REQUEUE_DELAY_MS = 15 * 60_000;

/** Whether this answer is a requeue: one of `REQUEUE_STOPS`, with requeues left. */
export function mayRequeue(job, report) {
  return Boolean(report) && !report.ok && REQUEUE_STOPS.includes(report.stopped_at) && (job?.requeues || 0) < MAX_REQUEUES;
}

/** One job's answer, said and written: the page's cache, the register, the runs.tsv row. */
async function tell(job, landed, report, { root, say, gh, now, read, write, lock, appendRun, dropFromPage, seconds, mending = false, requeued = false }) {
  const label = `${job.repo} #${job.pr}`;
  // Set aside for its one mend: the step stays `landing`, so the runner
  // leaves it alone, and the mend's outcome is what writes the register.
  say(mending ? `${label}: ${report?.reason || report?.stopped_at || 'red'} — mending (one try)`
    : requeued
    ? `${label}: ${report?.stopped_at}: ${report?.reason || 'red only under load'} — back in line in ${Math.round(REQUEUE_DELAY_MS / 60_000)} min (requeue ${(job.requeues || 0) + 1} of ${MAX_REQUEUES}), no session started`
    : landed && report?.already_merged
    ? `${label}: already merged on GitHub as ${String(report.merge_commit || '').slice(0, 7)} — answered landed`
    : landed
    ? `${label}: merged into ${report.merged_into || 'main'} as ${String(report.merge_commit || '').slice(0, 7)} (${seconds}s)`
    : `${label}: not merged — ${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`);
  // A landed pull request leaves PULL REQUESTS now, not when the page or a
  // runner lane next asks GitHub. A cache that cannot be written costs the
  // page a stale row and the landing nothing.
  if (landed) { try { dropFromPage({ root, repo: job.repo, number: job.pr }); } catch { /* see above */ } }
  // Its last red is nobody's to read any more.
  if (landed) removeRedDetail({ root, repo: job.repo, pr: job.pr });

  // A requeued step stays `landing`: the runner leaves it alone, and the next round answers it.
  if (job.step && !mending && !requeued) {
    const stamp = now().toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const io = { read, lock, ...(write ? { write } : {}) };
    try {
      const standing = readEntry(root, job.step.project, { read })?.steps?.[job.step.index];
      if (standing?.status === 'done' || standing?.status === 'blocked') {
        say(`${label}: ${job.step.project} step ${job.step.index + 1} is ${standing.status} — the register is left as it is`);
      } else if (landed) {
        let body = null;
        if (gh) {
          const seen = await gh(['pr', 'view', String(job.pr), '--json', 'body'], { cwd: job.repo_path });
          try { body = JSON.parse(seen?.stdout || '{}')?.body || null; } catch { body = null; }
        }
        updateStep({ root, project: job.step.project, index: job.step.index, patch: landedPatch({ pr: job.pr, report, now: stamp, body }), now: stamp, ...io });
        say(`${label}: ${job.step.project} step ${job.step.index + 1} is done`);
      } else {
        const patch = redPatch({ step: standing, report });
        // Once the one below has landed, the next session merges main into
        // this branch before it starts, and nothing is to be moved again.
        const below = job.parent && parentLanded(root, { read })(job.parent) ? { stacked_on: null } : {};
        updateStep({ root, project: job.step.project, index: job.step.index, patch: { ...patch, pr: job.pr, ...below }, now: stamp, ...io });
        say(patch.status === 'ready'
          ? `${label}: ${job.step.project} step ${job.step.index + 1} is ready again (attempt ${patch.attempts}) — the next session fixes it on the same pull request`
          : `${label}: ${job.step.project} step ${job.step.index + 1} failed — ${patch.reason}`);
      }
    } catch (error) {
      say(`${label}: the register could not be written (${error?.message || error}) — the round stands as said above`);
    }
  }

  if (appendRun) {
    try {
      appendRun({
        ts: now().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
        name: job.step?.project || job.repo,
        kind: 'merge',
        exit: landed ? 0 : 1,
        seconds,
        pr: job.pr,
        note: landed ? 'merged' : `red,${report?.stopped_at || 'unknown'}`,
      });
    } catch { /* the row is a courtesy; the register and the round log carry the answer */ }
  }
}

/**
 * The merger's loops, one per gate lane (ruling 34), side by side in this one
 * process. Each takes only the jobs whose repository's lane is its own, so a
 * memoro-cli round runs while a memoro round is in flight and two memoro
 * rounds never do. Returns when neither lane has anything to take, or when
 * `stopping()` says so — asked between jobs in each loop: a job in flight is
 * always finished, because a round cut in half is a lease and a lock somebody
 * else has to reap. Before each batch it also asks `head()`, and a checkout
 * that has moved past `version.commit` ends it like a stop, between rounds,
 * with the queue left as it is.
 */
export async function serve({
  root, read = realRead, write = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
  lock = realLock, stopping = () => false, say = () => {}, now = () => new Date(),
  // `{ checkout, commit }` of the code this merger runs, read once by
  // merger-run.js: the first line says it, and merger.json keeps the commit.
  version = null,
  take = () => takeMerger({ root, commit: version?.commit || null }), release = () => releaseMerger({ root }),
  land = (batch, lane, extra = {}) => landJob(batch, { root, say, now, read, lock, lane, ...extra }),
  landed = parentLanded(root, { read }),
  ordered = stepsBeforeDone(root, { read }),
  laneOf = (job) => gateLaneOf(job.repo),
  // The most jobs one round lands (merge-queue.js): one, unless a test asks.
  batchMax = MERGE_BATCH_MAX,
  lanes = GATE_LANES,
  // How long a loop with nothing in its lane waits before it looks again while
  // the other is landing: a job queued meanwhile saw this merger alive and
  // started none, so this loop is the one that has to find it.
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  gh = null,
  sweep = () => sweepMergedReds({ root, gh, read, write, lock, say, now }),
  // `(job, report, { onPid }) => result` — one mend session (mend.js
  // `runMend`), or null for a merger that does not mend: every red is red.
  // `land` must be handed the matching `mayMend`.
  mend = null,
  mendAtOnce = MEND_AT_ONCE,
  appendRun = null,
  // `async () => <short sha> | null` — the checkout's HEAD now; null for a
  // merger that never leaves for new code.
  head = null,
  // `(from, to) => {}` — told once when the merger decides to leave for new code.
  onMoved = null,
} = {}) {
  if (!take()) { say('another merger is running — leaving'); return 0; }
  say(version ? `merger ${process.pid} started — ${version.checkout} at ${version.commit}` : `merger ${process.pid} started`);
  // A `mending` entry at start is a mend that died with the merger before
  // it: it never finished, so the job goes back in line unmended, and its
  // next red mends again.
  lock(root, () => {
    const entries = parseQueue(read(mergesPath(root)));
    const orphans = entries.filter((entry) => entry.state === 'mending');
    if (!orphans.length) return;
    write(mergesPath(root), entries.map((entry) => (entry.state === 'mending'
      ? { ...entry, state: 'queued', started: null, mend: null, mended: null } : entry)));
    for (const entry of orphans) say(`${entry.repo} #${entry.pr}: its mend (pid ${entry.mend?.pid ?? '?'}) never finished — back in line`);
  });
  const mends = mend ? mendLine({
    atOnce: mendAtOnce,
    run: (job, report) => {
      say(`${job.repo} #${job.pr}: mend session starting on ${job.branch}`);
      return mend(job, report, {
        onPid: (pid) => lock(root, () => {
          const entries = parseQueue(read(mergesPath(root)));
          if (queuedFor(entries, job.repo, job.pr)?.state !== 'mending') return;
          write(mergesPath(root), entries.map((entry) => (entry.state === 'mending' && entry.repo === job.repo && entry.pr === job.pr
            ? { ...entry, mend: { ...entry.mend, pid } } : entry)));
        }),
      });
    },
    settle: (job, report, result) => settleMend(job, report, result, { root, say, now, read, write, lock, gh, appendRun }),
  }) : null;
  // Red rows merged or closed on GitHub since: looked for once now and then
  // at most every SWEEP_MS by whichever loop is idle, one sweep at a time.
  let sweeping = null;
  let swept = -Infinity;
  const sweepReds = async () => {
    if (sweeping || now().getTime() - swept < SWEEP_MS) return;
    swept = now().getTime();
    sweeping = (async () => {
      try { await sweep(); } catch (error) { say(`the sweep of red rows threw — ${error?.message || error}`); }
    })();
    try { await sweeping; } finally { sweeping = null; }
  };
  await sweepReds();
  const batchIn = (entries, lane) => nextBatch(entries, { landed, ordered, lane, laneOf, now: now().getTime(), max: batchMax });
  // What the loops share: which of them has nothing, whether the merger is
  // leaving, and a wake-up for a loop waiting on the other.
  const idle = new Set();
  let leaving = false;
  // Jobs in a round now, across the lanes, and whether the stop was said.
  let inFlight = 0;
  let toldStop = false;
  // Jobs whose answer `writeAnswer` wrote to the queue while their batch was
  // in flight: the post-round block leaves them as they are.
  const written = new Set();
  const keyOf = (job) => `${job.repo}#${job.pr}`;
  // The commit the checkout moved to, once a lane has seen it.
  let movedTo = null;
  let wake = () => {};
  let woken = new Promise((resolve) => { wake = resolve; });
  const changed = () => {
    const was = wake;
    woken = new Promise((resolve) => { wake = resolve; });
    was();
  };
  // Whether the checkout has moved past the commit this merger started on.
  // Said once; a head that cannot be read is no move.
  async function codeMoved() {
    if (movedTo) return true;
    if (!head || !version?.commit || version.commit === 'unknown') return false;
    let current = null;
    try { current = await head(); } catch { current = null; }
    if (!current || sameCommit(current, version.commit)) return false;
    movedTo = current;
    say(`code moved ${version.commit} → ${current} — leaving after the rounds in flight; the next start serves on the new code`);
    try { onMoved?.(version.commit, current); } catch { /* a line, not the merger */ }
    return true;
  }

  // One job's answer written to the queue the moment `landJob` gives it, and
  // its mend started then (2026-10-10: #13400 closed and #13397 set aside for
  // a mend read `landing` for the 9 minutes of the others' round). Called
  // after `tell`, outside any lock, so it takes the queue's lock itself.
  const writeAnswer = async ({ job, landed: isLanded, report, mending, requeued }) => {
    const at = now().toISOString();
    const reason = `${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`;
    lock(root, () => {
      let entries = parseQueue(read(mergesPath(root)));
      entries = isLanded && report?.ok && report.merged
        ? dequeue(entries, job)
        : requeued
        ? markRequeued(entries, job, { notBefore: new Date(now().getTime() + REQUEUE_DELAY_MS).toISOString() })
        : mending && mends
        ? markMending(entries, job, { reason, stopped_at: report?.stopped_at || null, started: at })
        : markRed(entries, job, { reason, answered: at });
      write(mergesPath(root), entries);
    });
    written.add(keyOf(job));
    if (mending && mends) mends.start(job, report).then(changed);
    changed();
  };

  const loop = async (lane) => {
    for (;;) {
      if (leaving) return;
      if (stopping()) {
        // Seen by a lane between its jobs; a lane with a round in flight
        // finishes it and leaves at the top of its loop.
        if (!toldStop) { toldStop = true; say(`asked to stop — waiting for ${inFlight} job(s) in flight`); }
        leaving = true; changed(); return;
      }
      // New code in the checkout: no new batch. A round in flight in the
      // other lane is answered and that lane leaves at the top of its loop.
      if (await codeMoved()) { leaving = true; changed(); return; }
      const batch = lock(root, () => {
        let entries = parseQueue(read(mergesPath(root)));
        // A job a dead merger was landing whose earlier step is no longer
        // `done` goes back in line rather than being landed out of order.
        const back = heldLanding(entries, { ordered }).filter((job) => (laneOf(job) || 'heavy') === lane);
        for (const job of back) {
          entries = markQueued(entries, job);
          say(`${job.repo} #${job.pr}: back in line — ${job.step.project} step ${job.step.index} is not done`);
        }
        const next = batchIn(entries, lane);
        if (next.length) {
          const started = now().toISOString();
          entries = next.reduce((all, job) => markLanding(all, job, started), entries);
        }
        if (next.length || back.length) write(mergesPath(root), entries);
        return next;
      });
      if (!batch.length) {
        await sweepReds();
        idle.add(lane);
        if (idle.size < lanes.length || mends?.busy()) {
          // The other lane is landing. Looked at again when it answers a job,
          // when it has nothing either, or after a poll — whichever is first.
          // A mend running or waiting is looked at again when it settles: it
          // may put its job back in line, and the merger does not leave
          // before it has.
          await Promise.race([woken, sleep(MERGER_POLL_MS)]);
          idle.delete(lane);
          continue;
        }
        // Neither lane has anything. Released before the last look: an `mc
        // merge` that queued between the read above and now saw this merger
        // alive and started none, so the queue is read once more with the
        // file gone — and taken again if either lane has work, unless that
        // call's own merger already has it. A job waiting on one that came
        // back red stays in the queue and is not work: the merger leaves, and
        // that one's next `mc merge` starts a merger again.
        release();
        const entries = parseQueue(read(mergesPath(root)));
        if (!lanes.some((one) => batchIn(entries, one).length) || !take()) {
          say('nothing the merger may take — leaving');
          leaving = true; changed(); return;
        }
        idle.clear(); changed();
        continue;
      }
      const [job] = batch;
      say(batch.length === 1
        ? `${job.repo} #${job.pr}: landing${job.step ? ` (${job.step.project} step ${job.step.index + 1})` : ''}`
        : `${job.repo}: landing a batch of ${batch.length} — ${batch.map((item) => `#${item.pr}`).join(' ')}`);
      let answers = null;
      inFlight += batch.length;
      try {
        const result = await land(batch, lane, { onAnswer: writeAnswer });
        answers = Array.isArray(result) ? result : answersFor(batch, result);
      } catch (error) {
        say(`${job.repo} ${batch.map((item) => `#${item.pr}`).join(' ')}: the round threw — ${error?.stack || error}`);
        answers = answersFor(batch, { ok: false, merged: false, stopped_at: 'threw', reason: `the round threw (${error?.message || error})` });
      } finally {
        inFlight -= batch.length;
      }
      // Landed, the job is gone; red, it stays as a red row on the page until
      // `mc merge` puts it back in line or the pull request is closed. Each
      // job of a batch by its own answer.
      // A red that gets its one mend is set aside as `mending`, and the lane
      // goes on: the mend runs beside it, never awaited here.
      // What is left here is what `onAnswer` did not write: a round that
      // threw, or a `land` that does not tell its answers as it gives them.
      const answered = now().toISOString();
      const left = answers.filter((one) => !written.has(keyOf(one.job)));
      const toMend = left.filter((one) => one.mending && mends);
      if (left.length) {
        lock(root, () => {
          let entries = parseQueue(read(mergesPath(root)));
          for (const { job: one, report, mending, requeued } of left) {
            const reason = `${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`;
            entries = report?.ok && report.merged
              ? dequeue(entries, one)
              : requeued
              ? markRequeued(entries, one, { notBefore: new Date(now().getTime() + REQUEUE_DELAY_MS).toISOString() })
              : mending && mends
              ? markMending(entries, one, { reason, stopped_at: report?.stopped_at || null, started: answered })
              : markRed(entries, one, { reason, answered });
          }
          write(mergesPath(root), entries);
        });
      }
      for (const { job: one, report } of toMend) mends.start(one, report).then(changed);
      // Queued again later, a job is written again.
      for (const one of batch) written.delete(keyOf(one));
      changed();
    }
  };

  try {
    await Promise.all(lanes.map(loop));
    // Asked to stop or leaving for new code, a mend not started yet is
    // dropped (its entry stays `mending`, and the next merger puts it back in
    // line); a running one is waited for, up to its own wall clock.
    if (mends) {
      if (toldStop || movedTo) mends.stop();
      await mends.idle();
    }
    return 0;
  } finally {
    release();
    if (toldStop) say('left');
    if (movedTo && !toldStop) say(`left for ${movedTo}`);
  }
}

/**
 * What came of a mend, written: pushed, the job is back in line at its old
 * place, `mended` set, and the step still `landing`; anything else, the job
 * is red with the round's reason and what the mend said, and the step goes
 * through `redPatch` as any red does. One runs.tsv row of kind `mend`.
 */
export async function settleMend(job, report, result, {
  root, say = () => {}, now = () => new Date(), read = realRead,
  write = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }), lock = realLock, gh = null, appendRun = null,
} = {}) {
  const outcome = result?.outcome || 'failed';
  const at = now().toISOString();
  const label = `${job.repo} #${job.pr}`;
  const pushed = outcome === 'pushed';
  const entryReason = mendedReason(`${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`, { ...result, outcome });
  const still = lock(root, () => {
    const entries = parseQueue(read(mergesPath(root)));
    if (queuedFor(entries, job.repo, job.pr)?.state !== 'mending') return false;
    write(mergesPath(root), pushed
      ? markMended(entries, job, { outcome, at })
      : markRed(entries, job, { reason: entryReason, answered: at, mended: { at, outcome } }));
    return true;
  });
  if (!still) say(`${label}: the mend ended ${outcome}, but the entry is no longer mending — left as it is`);
  else if (pushed) say(`${label}: mended — ${result?.line || 'pushed'} — back in line`);
  else {
    await tell(job, false, { ...report, reason: mendedReason(report?.reason || `the round stopped at ${report?.stopped_at || 'unknown'}`, { ...result, outcome }) }, {
      root, say, gh, now, read, write, lock, appendRun: null, dropFromPage: () => {}, seconds: result?.seconds ?? 0,
    });
  }
  if (appendRun) {
    const counts = result?.read || {};
    try {
      appendRun({
        ts: at.replace(/\.\d{3}Z$/u, 'Z'),
        name: job.step?.project || job.repo,
        kind: 'mend',
        exit: pushed ? 0 : 1,
        seconds: result?.seconds ?? 0,
        pr: job.pr,
        turns: counts.turns ?? '-',
        input: counts.input ?? '-',
        output: counts.output ?? '-',
        cacheRead: counts.cacheRead ?? '-',
        cacheWrite: counts.cacheWrite ?? '-',
        session: counts.session ?? '-',
        note: outcome.replace(/\s+/gu, '-'),
      });
    } catch { /* the row is a courtesy, as the merge row is */ }
  }
}

/** A runs.tsv appender for the merger's own rows, header first. */
export function runsAppender(root, { read = realRead, append } = {}) {
  const path = join(root, 'runner', 'log', 'runs.tsv');
  return (row) => {
    const full = { turns: '-', input: '-', output: '-', cacheRead: '-', cacheWrite: '-', session: '-', landSeconds: '-', model: '-', ...row };
    if (read(path) == null) append(path, `${tsvHeader()}\n`);
    append(path, `${tsvRow(full)}\n`);
  };
}
