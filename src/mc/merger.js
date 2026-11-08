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
 *   - `queueMerge` is what `mc merge` and the runner call: the job is in
 *     `merges.json`, and a merger is running. It returns at once.
 *   - `serve` is the merger: take the oldest job, run the round, write the
 *     goal's answer, drop the job — or keep it as `red` with the reason, for
 *     the page — take the next; leave when nothing is left in line.
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
 * a running deploy the same way in memoro's lane, before a round and never
 * inside one: the deployer lets the round in flight finish, builds alone, and
 * that queue goes on after it. Another repository's lane does not wait for it.
 */
import { spawn as realSpawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './atomic-write.js';
import { runTool } from './child-async.js';
import { runAsync as runGitAsync } from './git.js';
import { appendEntry, goalOfPr, logStamp, prRef, redMergeText, setGoalState } from './goals.js';
import { dropPr } from './page-cache.js';
import { runningDeploy } from './deploys.js';
import { BUILD_LANE, runningRound } from './gate-lock.js';
import {
  dequeue, enqueue, heldBy, inLine, markLanding, markOffline, markQueued, markRed, markRequeued, MERGE_BATCH_MAX, mergesPath, nextBatch, parseQueue,
  placeOf, queuedFor,
} from './merge-queue.js';
import { removeRedDetail, writeRedDetail } from './merge-red.js';
import { shouldWait } from './merge-step.js';
import { realLock } from './runner-lock.js';
import { gateLaneOf, gateLanes } from './repo-gate-table.js';
import { readLease } from './repo-lease.js';
import { isNetworkFailure } from './network-failure.js';
import { deployPull, runMergeRound } from './repo-merge.js';
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

/** How often a round in flight asks GitHub whether its pull request is still the one it measures (`watchSubject`). */
export const SUBJECT_POLL_MS = 60_000;

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
 * Hand a pull request to the merger: the job, then a merger to take it.
 * Returns `{ place, merger, already }`: `place` 0 is next, `already` when the
 * merger is landing this very pull request now.
 */
export function queueMerge({
  root, repo, repoPath, pr, branch = null, holder = null, goal = null, sha = null,
  now = new Date(), env = process.env,
  read = realRead, write = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
  lock = realLock, start = startMerger,
} = {}) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const job = {
    repo, repo_path: repoPath, pr: Number(pr), branch, holder, since: stamp, state: 'queued',
    goal, sha,
  };
  const entries = lock(root, () => {
    const next = enqueue(parseQueue(read(mergesPath(root))), job);
    write(mergesPath(root), next);
    return next;
  }, { name: 'merges' });
  const already = queuedFor(entries, repo, pr)?.state === 'landing';
  const merger = start({ root, env });
  return { place: placeOf(entries, repo, pr), merger, already };
}

// The call merger-run.js makes, for a caller that hands no `gh`.
const realGh = (args, options = {}) => runTool('gh', args, { cwd: options.cwd });

/**
 * What GitHub says of a job's pull request: `{ state, sha, base }` for
 * `MERGED`, `CLOSED` or `OPEN`, or null when `gh` fails or says nothing — a
 * null is no answer, and the round decides as it always did.
 */
async function prStateOf(job, gh, failure = {}) {
  try {
    const seen = await gh(['pr', 'view', String(job.pr), '--json', 'state,mergeCommit,baseRefName'], { cwd: job.repo_path });
    if (!seen || seen.error || (Number.isInteger(seen.status) && seen.status !== 0)) {
      // Why it could not say, for a caller that tells the network apart (`isNetworkFailure`).
      failure.error = String(seen?.stderr || seen?.error?.message || seen?.error || '').trim() || null;
      return null;
    }
    const facts = JSON.parse(seen.stdout || 'null');
    const state = facts?.state;
    if (state === 'MERGED') return facts.mergeCommit?.oid ? { state, sha: facts.mergeCommit.oid, base: facts.baseRefName || null } : null;
    return state === 'CLOSED' || state === 'OPEN' ? { state } : null;
  } catch { return null; }
}

/** The head commit of a job's pull request on GitHub, or null when `gh` cannot say. */
async function headOf(job, gh) {
  try {
    const seen = await gh(['pr', 'view', String(job.pr), '--json', 'headRefOid'], { cwd: job.repo_path });
    if (!seen || seen.error || (Number.isInteger(seen.status) && seen.status !== 0)) return null;
    return JSON.parse(seen.stdout || 'null')?.headRefOid || null;
  } catch { return null; }
}

/**
 * Asks GitHub every `every` ms whether the pull request a round is measuring
 * is still the subject: `onGone(facts)` once, when it is merged (`merged`,
 * with the commit and base), closed (`closed`), or has a new push (`pushed`,
 * its head is not `startHead`). A check still in flight is not joined by
 * another, and a failed or unreadable answer says nothing. Returns `stop()`.
 */
export function watchSubject({
  job, gh, startHead = null, every = SUBJECT_POLL_MS, onGone,
  setTimer = setInterval, clearTimer = clearInterval,
}) {
  let checking = false;
  let done = false;
  let timer = null;
  const check = async () => {
    if (checking || done) return;
    checking = true;
    let facts = null;
    try {
      const seen = await gh(['pr', 'view', String(job.pr), '--json', 'state,headRefOid,mergeCommit,baseRefName'], { cwd: job.repo_path });
      if (seen && !seen.error && (!Number.isInteger(seen.status) || seen.status === 0)) facts = JSON.parse(seen.stdout || 'null');
    } catch { facts = null; }
    checking = false;
    if (done || !facts) return;
    const state = facts.state;
    const fire = (answer) => {
      done = true;
      clearTimer(timer);
      onGone(answer);
    };
    if (state === 'MERGED') {
      const sha = facts.mergeCommit?.oid || null;
      fire({ kind: 'merged', sha, head: facts.headRefOid || null, base: facts.baseRefName || null, reason: `#${job.pr} was merged on GitHub as ${String(sha || '').slice(0, 7)} while its round ran — the round is stopped` });
    } else if (state === 'CLOSED') {
      fire({ kind: 'closed', reason: `#${job.pr} was closed on GitHub while its round ran — the round is stopped` });
    } else if (state === 'OPEN' && startHead && facts.headRefOid && facts.headRefOid !== startHead) {
      const head = String(facts.headRefOid);
      fire({ kind: 'pushed', sha: head, reason: `#${job.pr} got a new push (${head.slice(0, 7)}) while its round ran — stopped; back in line at its place` });
    }
  };
  timer = setTimer(check, every);
  timer?.unref?.();
  return () => {
    done = true;
    clearTimer(timer);
  };
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
 * one is dequeued and answered landed (the `tell` path), a closed one
 * is dequeued (2026-10-10: #13370 and #13372
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
  }, { name: 'merges' });
  for (const { entry, facts } of dropped) {
    if (facts.state === 'MERGED') {
      const report = alreadyMerged(facts);
      await tell(entry, report.ok, report, {
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
 * answered: wait while somebody else measures, run one round over all of
 * them, record it, and write each job's own answer. Each answer is written
 * to its goal and told to `onAnswer` when it is given, so the queue and the
 * page know an answer given before the round (merged or closed on GitHub)
 * for the whole round. Returns the answers, `[{ job, landed, report }]`.
 */
export async function landJob(batch, {
  root, mergeRound = runMergeRound, sleep, say, gh = null,
  readRunningRound = runningRound, readLeaseFn = readLease, alive = pidAlive,
  readRunningDeploy = () => runningDeploy({ ...process.env, MC_WORK_ROOT: root }),
  now = () => new Date(), read = realRead, write, lock = realLock,
  recordStart = recordRoundStart, record = recordRound, appendRun = null,
  // The page's PR cache, told at once (page-cache.js `dropPr`).
  dropFromPage = dropPr,
  // The repository's lane: the round waited for is the one in this lane.
  lane = null,
  // Told each answer as it is given, after its goal is written: `serve`
  // writes the queue from it.
  onAnswer = null,
  // How often a round in flight asks GitHub whether its pull request is gone (`watchSubject`).
  watchMs = SUBJECT_POLL_MS,
  // A goal job's answer written to its GOAL.json and LOG.md (goals.js `setGoalState`).
  setGoal = realSetGoal,
  // `() => goals` (goals.js `programsGoals`): how a pull request queued by
  // anyone finds the goal whose `prs` carry it. Null knows only `job.goal`;
  // merger-run.js gives the real one.
  goalsOf = null,
  // A goal entry with no status change (goals.js `appendEntry`).
  noteGoal = appendEntry,
  afterLanding = null,
} = {}) {
  const t0 = now().getTime();
  const answers = [];
  const answer = async (job, landed, report) => {
    // A goal's head moved past the one its review judged: not OK any more.
    // It leaves the queue, and the goal stays in merge for one mend session (`tellGoal`).
    const moved = !landed && Boolean(job.goal) && (report?.stopped_at === 'pushed' || report?.stopped_at === 'moved');
    // A round the watch stopped for a new push: back in line at its place.
    const back = !landed && !moved && report?.stopped_at === 'pushed';
    // A red is not repaired here: a goal's goes to one mend session (`tellGoal`).
    const requeued = !landed && !back && !moved && mayRequeue(job, report);
    // The network stopped the round: back in line after a backoff, until the sixth in a row, which is answered as it stands.
    const offline = !landed && !back && !moved && !requeued && mayOffline(job, report);
    const given = !landed && !offline && report?.stopped_at === OFFLINE_STOP ? offlineGivenUp(report) : report;
    const flags = { ...(requeued ? { requeued: true } : {}), ...(back ? { back: true } : {}), ...(moved ? { moved: true } : {}), ...(offline ? { offline: true } : {}) };
    answers.push({ job, landed, report: given, ...flags });
    await tell(job, landed, given, {
      root, say, gh, now, read, write, lock, appendRun, dropFromPage, seconds: Math.round((now().getTime() - t0) / 1000), requeued, back, moved, offline, setGoal, goalsOf, noteGoal,
    });
    // Outside any lock: the queue's lock, taken twice by this process, waits 5 s.
    if (onAnswer) {
      try {
        await onAnswer({ job, landed, report: given, ...flags });
      } catch (error) {
        say(`${job.repo} #${job.pr}: the queue could not be told (${error?.message || error}) — written after the round`);
      }
    }
  };
  const jobs = [].concat(batch);
  // A session already decided that a goal should merge. Execute that decision
  // directly: no criteria, reviewed-head check, gate or automatic conflict fix.
  const ask = gh || realGh;
  for (const one of [...jobs]) {
    const goal = goalOfJob(one, goalsOf);
    if (!one.goal && goal?.stage !== 'merge') continue;
    let merged;
    try {
      merged = await ask(['pr', 'merge', String(one.pr), '--squash'], { cwd: one.repo_path });
    } catch (error) { merged = { status: 1, stderr: error.message }; }
    // Read the result, also covering a retry after the previous process landed
    // the PR but died before recording its answer.
    const unread = {};
    const facts = await prStateOf(one, ask, unread);
    const error = String(merged?.stderr || '').trim();
    // GitHub could not be reached, and nothing says the PR merged: the network's
    // answer (`offline`), not the decision's. Back in line; the goal is left as it is.
    const unreachable = facts?.state !== 'MERGED' && facts?.state !== 'CLOSED'
      && (merged?.status !== 0 ? isNetworkFailure(error) : !facts && isNetworkFailure(unread.error));
    const report = facts?.state === 'MERGED' ? { ...alreadyMerged(facts), already_merged: merged?.status !== 0 }
      : unreachable ? {
        ok: false, merged: false, stopped_at: OFFLINE_STOP,
        reason: merged?.status !== 0
          ? `gh pr merge ${one.pr} --squash could not reach GitHub (${error}) — ${facts?.state === 'OPEN' ? 'GitHub still has it open' : 'its state could not be read'}, so nothing is known to have merged`
          : `gh pr view ${one.pr} could not reach GitHub to confirm the merge (${unread.error})`,
      }
      : { ok: false, merged: false, stopped_at: 'merge', reason: error || 'GitHub did not confirm the merge' };
    if (report.ok && afterLanding) {
      try { await afterLanding(one); } catch (error) { say(`${one.repo}: could not pull the installation (${error.message})`); }
    }
    await answer(one, report.ok, report);
    jobs.splice(jobs.indexOf(one), 1);
  }
  // Asked first: a pull request somebody merged or closed on GitHub is
  // answered by itself and leaves the batch, rather than stopping the round
  // for everyone in it (2026-10-10 17:52, #13372 turned #13373 and #13374 red).
  for (const one of [...jobs]) {
    const facts = await prStateOf(one, ask);
    if (facts?.state === 'MERGED') {
      const report = alreadyMerged(facts);
      await answer(one, report.ok, report);
    } else if (facts?.state === 'CLOSED') await answer(one, false, closedOnGitHub(one));
    else continue;
    jobs.splice(jobs.indexOf(one), 1);
  }
  if (!jobs.length) return answers;
  // The head the round starts on, read once for a single job: a push to it
  // while the round runs stops the round (`watchSubject`). Unreadable: only
  // merged and closed are watched. A goal's is the head its review judged.
  const startHead = jobs.length === 1 ? (jobs[0].goal && jobs[0].sha) || await headOf(jobs[0], ask) : null;

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
    // Only memoro's lane: the deploy builds memoro, and a light repository's
    // round neither touches that build nor can be touched by it. memoro-cli
    // sat behind a 76-minute deploy on 2026-11-01 for no reason but this check.
    const deploying = (lane ?? gateLaneOf(job.repo)) === BUILD_LANE ? readRunningDeploy() : null;
    const running = readRunningRound({ alive, lane: lane ?? gateLaneOf(job.repo) });
    const lease = readLeaseFn(job.repo_path);
    const blocking = lease?.held && !lease.orphaned;
    if (deploying || running || blocking) {
      const why = deploying ? `the deploy of ${String(deploying.sha || '').slice(0, 7) || '?'} (pid ${deploying.pid})`
        : running ? `another gate round in the ${lane ?? gateLaneOf(job.repo)} lane (${running.repo || 'a repository'} #${running.pr ?? '?'}, pid ${running.pid})` : `${job.repo} is held by ${lease.holder}`;
      if (why !== said) { say(`${label}: waiting behind ${why}`); said = why; }
      await sleep(MERGER_POLL_MS);
      continue;
    }
    recordStart({ repo: job.repo_path, mode: 'merge', holder: job.holder?.name || null, prs: numbers });
    // The first job's holder holds the round, the rule the gate's lease has.
    // `signals: false`: the gate installs no SIGTERM handler of its own in
    // the merger. Its exit cut the round short (2026-10-10 17:47); the
    // merger's own handler lets the round finish and leaves between jobs.
    // Watched while it runs: a single job's pull request gone on GitHub stops
    // the round (`watchSubject`); a batch is not watched (MERGE_BATCH_MAX is 1).
    const controller = new AbortController();
    let gone = null;
    const stopWatch = jobs.length === 1 ? watchSubject({
      job, gh: ask, startHead, every: watchMs,
      onGone: (facts) => { gone = facts; controller.abort(new Error(facts.reason)); },
    }) : () => {};
    try {
      report = await mergeRound({
        repoPath: job.repo_path, pr: job.pr, ...(jobs.length > 1 ? { prs: numbers } : {}), mode: 'merge', signals: false,
        env: { ...process.env, MC_WORK_ROOT: root },
        ...(job.holder ? { holder: job.holder } : {}),
        onProgress: (message) => say(`${label}: ${message}`),
        signal: controller.signal,
      });
    } finally {
      stopWatch();
    }
    keepRed(report, { root, repo: job.repo, pr: job.pr, batch: jobs.length > 1, now });
    record(report, { mode: 'merge' });
    // Stopped by the watch: answered as GitHub says. A 'gone' nobody asked for falls through as any other stop.
    if (report?.stopped_at === 'gone' && gone) {
      report = gone.kind === 'merged' ? alreadyMerged({ sha: gone.sha, base: gone.base })
        : gone.kind === 'closed' ? closedOnGitHub(job)
        : { ok: false, merged: false, stopped_at: 'pushed', reason: gone.reason };
      break;
    }
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
  return (batch, lane, extra = {}) => landJob(batch, {
    afterLanding: (job) => deployPull({ git: (args, options) => runGitAsync(options.cwd, args), repoPath: job.repo_path, env: process.env, say: deps.say || (() => {}), installs: sourceLinkedInstallations }),
    ...deps, lane, ...extra,
  });
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

/**
 * The stop a round gives when the network did not answer (`isNetworkFailure`,
 * network-failure.js): a failed fetch, or a gh call that could not connect. Nothing
 * about the pull request was read, so nothing is wrong with it. It goes back in
 * line after a backoff — a minute, doubling, at most `REQUEUE_DELAY_MS` — with
 * no session started, the goal left as it is, and no requeue used up. The
 * `OFFLINE_BLOCK_AFTER`th such answer in a row is answered as it stands, and the
 * goal is blocked with a reason that says how long the network has been down.
 */
export const OFFLINE_STOP = 'offline';
export const OFFLINE_FIRST_MS = 60_000;
export const OFFLINE_BLOCK_AFTER = 6;

/** The wait before the retry after the `n`th offline answer in a row: a minute, doubling, at most 15 minutes. */
export function offlineBackoffMs(n) {
  return Math.min(REQUEUE_DELAY_MS, OFFLINE_FIRST_MS * 2 ** Math.max(0, n - 1));
}

/** Whether this answer is put back in line: the network stopped the round, and fewer than `OFFLINE_BLOCK_AFTER` have come in a row. */
export function mayOffline(job, report) {
  return Boolean(report) && !report.ok && report.stopped_at === OFFLINE_STOP && (job?.offline || 0) + 1 < OFFLINE_BLOCK_AFTER;
}

/** The sixth offline answer in a row, with the reason: the network has been down for at least the backoffs between the six. */
function offlineGivenUp(report) {
  const waits = Array.from({ length: OFFLINE_BLOCK_AFTER - 1 }, (_, index) => offlineBackoffMs(index + 1));
  const minutes = Math.round(waits.reduce((sum, ms) => sum + ms, 0) / 60_000);
  return { ...report, reason: `${report.reason} — the network has been unreachable for at least ${minutes} min (${OFFLINE_BLOCK_AFTER} rounds in a row)` };
}

/** When an offline job is taken again, as an ISO instant: the backoff after its next offline answer. */
const offlineNotBefore = (job, now) => new Date(now().getTime() + offlineBackoffMs((job?.offline || 0) + 1)).toISOString();

/** A goal's stage or status and a runner entry, written to its GOAL.json and LOG.md. */
function realSetGoal({ dir, stage, status, entry }) {
  return setGoalState({ dir, stage, status, entry });
}

/**
 * The goal a job answers to, as `{ programme, goal, dir, stage, status, prs,
 * success_criteria, log }`, or null: the
 * job's own (a goal's green review queued it), else the goal whose `prs` name
 * this pull request (`mc publish` or `mc goal pr` put it there), so a pull
 * request a person or another session queued is the goal's too. `prs` is read
 * from the goal as it stands; a goal `goalsOf` cannot read has none.
 */
export function goalOfJob(job, goalsOf) {
  let goals = [];
  try { goals = goalsOf ? goalsOf() : []; } catch { goals = []; }
  if (job.goal) {
    const found = goals.find((goal) => goal.programme === job.goal.programme && goal.goal === job.goal.goal);
    return { ...job.goal, stage: found?.stage ?? null, status: found?.status ?? null, prs: found?.prs ?? [], success_criteria: found?.success_criteria ?? null, log: found?.log ?? [] };
  }
  const found = goalOfPr(goals, job.repo, job.pr);
  return found && !found.problems?.length ? { programme: found.programme, goal: found.goal, dir: found.dir, stage: found.stage, status: found.status, prs: found.prs, success_criteria: found.success_criteria ?? null, log: found.log ?? [] } : null;
}

/**
 * A goal job's answer, in its goal: landed is stage `done` with the pull
 * request and the landed sha — unless the goal carries another pull request
 * (`prs`) than this one, when the landing is written with no change and the
 * runner sets `done` once the rest has landed (`settleLanded`, run.js). Not
 * landed — red, or moved past the reviewed head — sets `merge · blocked`
 * immediately, for plan recovery. A goal in another stage keeps its stage.
 * A requeue or an offline answer says nothing yet: the next round answers it.
 */
function tellGoal(job, goal, landed, report, { say, now, setGoal, noteGoal, moved, requeued, offline }) {
  if (requeued || offline) return;
  const label = `${job.repo} #${job.pr}`;
  const name = `${goal.programme}/${goal.goal}`;
  const at = logStamp(now());
  const entry = (done, comment = null) => ({ at, tool: 'runner', model: null, done, comment, next: null });
  const reason = `${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`;
  const others = (goal.prs ?? []).filter((item) => !(item.repo === job.repo && item.pr === Number(job.pr)))
    .filter((item) => !(goal.log ?? []).some((entry) => String(entry.done ?? '').startsWith(`${prRef(item)} landed `)));
  const landedText = `landed #${job.pr} as ${report?.merge_commit || 'an unknown sha'}`;
  const kept = { stage: goal.stage || 'merge', status: goal.status || 'ready' };
  try {
    if (landed && others.length) {
      noteGoal({ dir: goal.dir, entry: { ...entry(`${prRef({ repo: job.repo, pr: job.pr })} ${landedText}`, `the goal carries ${others.map(prRef).join(', ')} too — done when every one has landed`), ...kept } });
      say(`${label}: goal ${name} — landed; ${others.map(prRef).join(', ')} still to settle`);
      return;
    }
    const red = redMergeText(job.pr, moved ? 'moved' : 'red');
    const why = moved ? (report?.reason || 'the branch moved past the reviewed head') : reason;
    // The sixth offline answer in a row blocks the goal in the stage it is in:
    // the network is its obstacle now, and a red-style note would leave it
    // running. Its stage is kept: a review goal has no verdict yet.
    const blocksGoal = !landed && report?.stopped_at === OFFLINE_STOP;
    if (!landed && goal.stage && goal.stage !== 'merge' && !blocksGoal) {
      noteGoal({ dir: goal.dir, entry: { ...entry(red, `${why} — the goal is in ${goal.stage}, not merge; it stays there`), ...kept } });
      say(`${label}: goal ${name} is ${goal.stage} — not landed, nothing moves`);
      return;
    }
    const change = landed ? { stage: 'done', status: 'ready', entry: entry(`${prRef(job)} ${landedText}`) }
      : { stage: blocksGoal ? goal.stage || 'merge' : 'merge', status: 'blocked', entry: entry(red, `${why} — a mend session resolves the obstacle`) };
    const set = setGoal({ dir: goal.dir, ...change });
    const words = `${change.stage}${change.status ? ` · ${change.status}` : ''}`;
    if (set?.problems) say(`${label}: goal ${name} could not be set ${words} (${set.problems.join('; ')})`);
    else say(`${label}: goal ${name} is ${words}`);
  } catch (error) {
    say(`${label}: goal ${name} could not be written (${error?.message || error})`);
  }
}

/** One job's answer, said and written: the page's cache, the goal, the runs.tsv row. */
async function tell(job, landed, report, { root, say, gh, now, read, write, lock, appendRun, dropFromPage, seconds, requeued = false, back = false, moved = false, offline = false, setGoal = realSetGoal, goalsOf = null, noteGoal = appendEntry }) {
  const label = `${job.repo} #${job.pr}`;
  say(moved ? `${label}: ${report.reason} — leaves the queue; the goal stays in merge`
    : back ? `${label}: ${report.reason}`
    : requeued
    ? `${label}: ${report?.stopped_at}: ${report?.reason || 'red only under load'} — back in line in ${Math.round(REQUEUE_DELAY_MS / 60_000)} min (requeue ${(job.requeues || 0) + 1} of ${MAX_REQUEUES}), no session started`
    : offline
    ? `${label}: offline: ${report?.reason || 'the network did not answer'} — back in line in ${Math.round(offlineBackoffMs((job.offline || 0) + 1) / 60_000)} min (offline ${(job.offline || 0) + 1} of ${OFFLINE_BLOCK_AFTER}), no session started`
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

  // Re-read and record under the shared lock: two repositories can finish
  // the same goal concurrently, and both landings must survive in its log.
  if (!back) lock(root, () => {
    const goal = goalOfJob(job, goalsOf);
    if (goal) tellGoal(job, goal, landed, report, { say, now, setGoal, noteGoal, moved, requeued, offline });
  }, { name: 'merges' });

  if (appendRun) {
    try {
      appendRun({
        ts: now().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
        name: (job.goal ? `goal:${job.goal.programme}/${job.goal.goal}` : job.repo),
        kind: 'merge',
        exit: landed ? 0 : 1,
        seconds,
        pr: job.pr,
        note: landed ? 'merged' : back ? 'pushed' : moved ? 'moved' : offline ? 'offline' : `red,${report?.stopped_at || 'unknown'}`,
      });
    } catch { /* the row is a courtesy; the goal and the round log carry the answer */ }
  }
}

/**
 * The merger's loops, one per gate lane (ruling 34), side by side in this one
 * process. Each takes only the jobs whose repository's lane is its own, so a
 * memoro-cli round runs while a memoro round is in flight and two memoro
 * rounds never do. Returns when neither lane has anything to take, or when
 * `stopping()` says so — asked between jobs in each loop: a job in flight is
 * always finished, because a round cut in half is a lease and a lock somebody
 * else has to reap. Before each batch it also asks `head()`; a checkout that
 * has moved past `version.commit` releases `merger.json` and calls `handover`
 * once, at once, and this merger then takes nothing more: the rounds it holds
 * finish, and the successor takes the rest of the queue, skipping the
 * entries this merger holds (`heldBy`).
 */
export async function serve({
  root, read = realRead, write = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
  lock = realLock, stopping = () => false, say = () => {}, now = () => new Date(),
  // `{ checkout, commit }` of the code this merger runs, read once by
  // merger-run.js: the first line says it, and merger.json keeps the commit.
  version = null,
  take = () => takeMerger({ root, commit: version?.commit || null }), release = () => releaseMerger({ root }),
  land = (batch, lane, extra = {}) => landJob(batch, { root, say, now, read, lock, lane, ...extra }),
  laneOf = (job) => gateLaneOf(job.repo),
  // The most jobs one round lands (merge-queue.js): one, unless a test asks.
  batchMax = MERGE_BATCH_MAX,
  // A loop for each declared repository, so a job queued during another's round
  // starts at once; a job of any other repository opens its own.
  lanes = gateLanes({ root }),
  // How long a loop with nothing in its lane waits before it looks again while
  // the other is landing: a job queued meanwhile saw this merger alive and
  // started none, so this loop is the one that has to find it.
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  gh = null,
  sweep = () => sweepMergedReds({ root, gh, read, write, lock, say, now }),
  appendRun = null,
  // `async () => <short sha> | null` — the checkout's HEAD now; null for a
  // merger that never leaves for new code.
  head = null,
  // `(from, to) => {}` — told once when the merger decides to leave for new code.
  onMoved = null,
  // This merger's pid, and whether a pid runs: an entry `landing` under
  // another live merger is that merger's (`heldBy`).
  pid = process.pid,
  alive = pidAlive,
  // `() => {}` — told once when the merger leaves for new code, after `release`
  // has let go of merger.json: the successor starts then (merger-run.js).
  handover = null,
} = {}) {
  if (!take()) { say('another merger is running — leaving'); return 0; }
  say(version ? `merger ${process.pid} started — ${version.checkout} at ${version.commit}` : `merger ${process.pid} started`);
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
  // Entries another live merger holds are its own (`heldBy`): not taken here.
  const held = heldBy({ pid, alive });
  const batchIn = (entries, lane) => nextBatch(entries, { lane, laneOf, now: now().getTime(), max: batchMax, held });
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
  // Said once; a head that cannot be read is no move. The order: the first
  // lane to see the move releases merger.json and starts the successor, and
  // then this merger finishes only the rounds it holds — the
  // successor takes every other job.
  async function codeMoved() {
    if (movedTo) return true;
    if (!head || !version?.commit || version.commit === 'unknown') return false;
    let current = null;
    try { current = await head(); } catch { current = null; }
    if (!current || sameCommit(current, version.commit)) return false;
    movedTo = current;
    say(`code moved ${version.commit} → ${current} — successor started; this merger finishes the rounds in flight and leaves`);
    try { onMoved?.(version.commit, current); } catch { /* a line, not the merger */ }
    release();
    try { handover?.(); } catch (error) { say(`the successor could not be started (${error?.message || error}) — the runner's next pass starts one`); }
    return true;
  }

  // One job's answer written to the queue the moment `landJob` gives it
  // (2026-10-10: #13400 closed and #13397 read `landing` for the 9 minutes
  // of the others' round). Called after `tell`, outside any lock, so it
  // takes the queue's lock itself.
  const writeAnswer = async ({ job, landed: isLanded, report, requeued, back, moved, offline }) => {
    const at = now().toISOString();
    const reason = `${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`;
    const retryDiagnostic = {
      category: String(report?.stopped_at || (offline ? 'offline' : 'unknown')).slice(0, 80),
      explanation: String(report?.reason || 'The round provided no explanation').slice(0, 1000),
    };
    lock(root, () => {
      let entries = parseQueue(read(mergesPath(root)));
      entries = (isLanded && report?.ok && report.merged) || moved
        ? dequeue(entries, job)
        : back
        ? markQueued(entries, job)
        : requeued
        ? markRequeued(entries, job, { notBefore: new Date(now().getTime() + REQUEUE_DELAY_MS).toISOString(), retryDiagnostic })
        : offline
        ? markOffline(entries, job, { notBefore: offlineNotBefore(job, now), retryDiagnostic })
        : markRed(entries, job, { reason, answered: at });
      write(mergesPath(root), entries);
    }, { name: 'merges' });
    written.add(keyOf(job));
    changed();
  };

  // One loop per repository with work, opened as its first job is seen.
  const loops = new Map();
  const openLane = (lane) => { if (lane && !loops.has(lane)) loops.set(lane, loop(lane)); };
  const openLanes = (entries) => { for (const job of entries) openLane(laneOf(job)); };
  const loop = async (lane) => {
    await null; // Its first pass after the caller's own, never inside the queue lock.
    for (;;) {
      if (leaving) return;
      if (stopping()) {
        // Seen by a lane between its jobs; a lane with a round in flight
        // finishes it and leaves at the top of its loop.
        if (!toldStop) { toldStop = true; say(`asked to stop — waiting for ${inFlight} job(s) in flight`); }
        leaving = true; changed(); return;
      }
      // New code in the checkout: `codeMoved` has released merger.json and
      // started the successor, so no new batch here. A round in flight in the
      // other lane is answered and that lane leaves at the top of its loop.
      if (await codeMoved()) { leaving = true; changed(); return; }
      let pending = [];
      const batch = lock(root, () => {
        let entries = parseQueue(read(mergesPath(root)));
        const next = batchIn(entries, lane);
        if (next.length) {
          const started = now().toISOString();
          entries = next.reduce((all, job) => markLanding(all, job, started, pid), entries);
        }
        if (next.length) write(mergesPath(root), entries);
        pending = entries;
        return next;
      }, { name: 'merges' });
      openLanes(pending);
      if (!batch.length) {
        await sweepReds();
        idle.add(lane);
        if (idle.size < loops.size) {
          // The other lane is landing. Looked at again when it answers a job,
          // when it has nothing either, or after a poll — whichever is first.
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
        openLanes(entries);
        if (![...loops.keys()].some((one) => batchIn(entries, one).length) || !take()) {
          say('nothing the merger may take — leaving');
          leaving = true; changed(); return;
        }
        idle.clear(); changed();
        continue;
      }
      const [job] = batch;
      say(batch.length === 1
        ? `${job.repo} #${job.pr}: landing`
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
      // What is left here is what `onAnswer` did not write: a round that
      // threw, or a `land` that does not tell its answers as it gives them.
      const answered = now().toISOString();
      const left = answers.filter((one) => !written.has(keyOf(one.job)));
      if (left.length) {
        lock(root, () => {
          let entries = parseQueue(read(mergesPath(root)));
          for (const { job: one, report, requeued, back, moved, offline } of left) {
            const reason = `${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`;
            const retryDiagnostic = {
              category: String(report?.stopped_at || (offline ? 'offline' : 'unknown')).slice(0, 80),
              explanation: String(report?.reason || 'The round provided no explanation').slice(0, 1000),
            };
            entries = (report?.ok && report.merged) || moved
              ? dequeue(entries, one)
              : back
              ? markQueued(entries, one)
              : requeued
              ? markRequeued(entries, one, { notBefore: new Date(now().getTime() + REQUEUE_DELAY_MS).toISOString(), retryDiagnostic })
              : offline
              ? markOffline(entries, one, { notBefore: offlineNotBefore(one, now), retryDiagnostic })
              : markRed(entries, one, { reason, answered });
          }
          write(mergesPath(root), entries);
        }, { name: 'merges' });
      }
      // Queued again later, a job is written again.
      for (const one of batch) written.delete(keyOf(one));
      changed();
    }
  };

  try {
    openLanes(parseQueue(read(mergesPath(root))));
    for (const lane of lanes) openLane(lane);
    // A job of a new repository opens a loop while the others run.
    for (let settled = 0; settled < loops.size; settled = loops.size) await Promise.all(loops.values());
    return 0;
  } finally {
    release();
    if (toldStop) say('left');
    if (movedTo && !toldStop) say(`left for ${movedTo}`);
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
