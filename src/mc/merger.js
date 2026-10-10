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
 * once. The merger waits them out; it has nobody to give up to. It waits out
 * a running deploy the same way, before a round and never inside one: the
 * deployer lets the round in flight finish, builds alone, and the queue goes
 * on after it.
 */
import { spawn as realSpawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './atomic-write.js';
import { dropPr } from './page-cache.js';
import { runningDeploy } from './deploys.js';
import { runningRound } from './gate-lock.js';
import {
  dequeue, enqueue, markLanding, markRed, mergesPath, nextJob, parseQueue, placeOf, queuedFor,
} from './merge-queue.js';
import { landedPatch, landingPatch, redPatch, shouldWait } from './merge-step.js';
import { readEntry, realLock, updateStep } from './register.js';
import { readLease } from './repo-lease.js';
import { runMergeRound } from './repo-merge.js';
import { recordRound, recordRoundStart } from './repo-round-log.js';
import { tsvHeader, tsvRow } from './run-plan.js';
import { pidAlive } from './status-collect.js';

const MERGER_RUN = fileURLToPath(new URL('./merger-run.js', import.meta.url));

/** How often the merger looks again at a gate lock or a lease somebody else holds. */
export const MERGER_POLL_MS = 15 * 1000;

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

/** The merger running now — `{ pid, since }` — or null. A dead pid is nobody. */
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
export function takeMerger({ root, alive = pidAlive, now = new Date(), pid = process.pid } = {}) {
  const path = mergerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  for (let tries = 0; tries < 3; tries += 1) {
    try {
      const fd = openSync(path, 'wx', 0o644);
      writeSync(fd, JSON.stringify({ pid, since: now.toISOString() }));
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
 */
export function startMerger({ root, env = process.env, spawn = realSpawn, alive = pidAlive } = {}) {
  const running = readMerger({ root, alive });
  if (running) return { pid: running.pid, started: false };
  const log = mergerLogPath(root);
  let fd = null;
  try {
    mkdirSync(dirname(log), { recursive: true });
    fd = openSync(log, 'a', 0o644);
    const childEnv = { ...env, MC_WORK_ROOT: env.MC_WORK_ROOT || root };
    for (const key of SESSION_ENV) delete childEnv[key];
    const child = spawn(process.execPath, [MERGER_RUN, '--root', root], {
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

const realGit = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { ok: r.status === 0, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
};

/**
 * A stacked branch moved onto main once the job below it has landed
 * (ruling 30, A). The one below was squash-merged, so its commits are in
 * this branch and not on main under the same names: `rebase --onto
 * origin/main <the sha this branch started on>` replays only this step's
 * own commits, and the branch is pushed back with a lease on the tip it had.
 * A branch that no longer carries that sha was moved already. Returns
 * `{ ok, moved, reason }`.
 */
export function restack(job, { git = realGit, say = () => {} } = {}) {
  const repoPath = job.repo_path;
  const branch = job.branch;
  if (!branch || !job.parent?.sha) return { ok: true, moved: false };
  if (!git(repoPath, ['fetch', '-q', 'origin']).ok) return { ok: false, reason: 'git fetch failed before moving the branch onto main' };
  const tip = git(repoPath, ['rev-parse', `origin/${branch}`]);
  if (!tip.ok) return { ok: false, reason: `origin/${branch} is not there to move onto main` };
  if (!git(repoPath, ['merge-base', '--is-ancestor', job.parent.sha, tip.stdout]).ok) return { ok: true, moved: false };
  const dir = mkdtempSync(join(tmpdir(), 'mc-restack-'));
  try {
    if (!git(repoPath, ['worktree', 'add', '-q', '--detach', dir, tip.stdout]).ok) return { ok: false, reason: 'git worktree add failed for the move onto main' };
    const rebased = git(dir, ['rebase', '-q', '--onto', 'origin/main', job.parent.sha]);
    if (!rebased.ok) {
      const conflicted = git(dir, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
      git(dir, ['rebase', '--abort']);
      return { ok: false, reason: `moving #${job.pr} onto main after #${job.parent.pr} landed conflicts${conflicted.length ? ` in ${conflicted.join(' ')}` : ''} — merge origin/main into ${branch} and keep both intents` };
    }
    const pushed = git(dir, ['push', '-q', `--force-with-lease=${branch}:${tip.stdout}`, 'origin', `HEAD:${branch}`]);
    if (!pushed.ok) return { ok: false, reason: `the moved ${branch} could not be pushed (${pushed.stderr.split('\n').at(-1) || 'push refused'})` };
    say(`${job.repo} #${job.pr}: moved onto main past #${job.parent.pr}`);
    return { ok: true, moved: true };
  } finally {
    git(repoPath, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ serve */

/**
 * One job, landed or answered: wait while somebody else measures, run the
 * round, record it, write the step. Returns the round's report.
 */
export async function landJob(job, {
  root, mergeRound = runMergeRound, sleep, say, gh = null,
  readRunningRound = runningRound, readLeaseFn = readLease, alive = pidAlive,
  readRunningDeploy = () => runningDeploy({ ...process.env, MC_WORK_ROOT: root }),
  now = () => new Date(), read = realRead, write, lock = realLock,
  recordStart = recordRoundStart, record = recordRound, appendRun = null,
  moveOntoMain = restack,
  // The page's PR cache, told at once (page-cache.js `dropPr`).
  dropFromPage = dropPr,
} = {}) {
  const label = `${job.repo} #${job.pr}`;
  const t0 = now().getTime();
  let report = null;
  let said = null;
  // Built on a job that has landed since: onto main first, or the round
  // measures the one below a second time and the squash conflicts with it.
  if (job.parent) {
    const moved = moveOntoMain(job, { say });
    if (!moved.ok) report = { ok: false, merged: false, stopped_at: 'restack', reason: moved.reason };
  }
  for (; !report;) {
    // Waited for before the round rather than inside it, so a busy gate is
    // not a round-log line every fifteen seconds. An orphaned lease is in
    // nobody's way: the round's own claim reaps it.
    // A deploy asked for waits for the round in flight and then runs alone;
    // the queue goes on after it (Martin, 2026-10-10). Its `running` row is
    // written before the deployer starts, so it is seen here before the
    // deployer looks at the gate.
    const deploying = readRunningDeploy();
    const running = readRunningRound({ alive });
    const lease = readLeaseFn(job.repo_path);
    const blocking = lease?.held && !lease.orphaned;
    if (deploying || running || blocking) {
      const why = deploying ? `the deploy of ${String(deploying.sha || '').slice(0, 7) || '?'} (pid ${deploying.pid})`
        : running ? `another gate round (${running.repo || 'a repository'} #${running.pr ?? '?'}, pid ${running.pid})` : `${job.repo} is held by ${lease.holder}`;
      if (why !== said) { say(`${label}: waiting behind ${why}`); said = why; }
      await sleep(MERGER_POLL_MS);
      continue;
    }
    recordStart({ repo: job.repo_path, mode: 'merge', holder: job.holder?.name || null, prs: [job.pr] });
    report = await mergeRound({
      repoPath: job.repo_path, pr: job.pr, mode: 'merge',
      ...(job.holder ? { holder: job.holder } : {}),
      onProgress: (message) => say(`${label}: ${message}`),
    });
    record(report, { mode: 'merge' });
    // Lost the race between "both free" and the round's own lock.
    if (!shouldWait(report)) break;
    report = null;
    await sleep(MERGER_POLL_MS);
  }

  const seconds = Math.round((now().getTime() - t0) / 1000);
  const landed = Boolean(report?.ok && report.merged && !report.off_default);
  say(landed
    ? `${label}: merged into ${report.merged_into || 'main'} as ${String(report.merge_commit || '').slice(0, 7)} (${seconds}s)`
    : `${label}: not merged — ${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`);
  // A landed pull request leaves PULL REQUESTS now, not when the page or a
  // runner lane next asks GitHub. A cache that cannot be written costs the
  // page a stale row and the landing nothing.
  if (landed) { try { dropFromPage({ root, repo: job.repo, number: job.pr }); } catch { /* see above */ } }

  if (job.step) {
    const stamp = now().toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const io = { read, lock, ...(write ? { write } : {}) };
    try {
      const standing = readEntry(root, job.step.project, { read })?.steps?.[job.step.index];
      if (standing?.status === 'done' || standing?.status === 'blocked') {
        say(`${label}: ${job.step.project} step ${job.step.index + 1} is ${standing.status} — the register is left as it is`);
      } else if (landed) {
        let body = null;
        if (gh) {
          const seen = gh(['pr', 'view', String(job.pr), '--json', 'body'], { cwd: job.repo_path });
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
  return report;
}

/**
 * The merger's loop. Returns when the queue is empty or `stopping()` says so
 * between jobs — a job in flight is always finished, because a round cut in
 * half is a lease and a lock somebody else has to reap.
 */
export async function serve({
  root, read = realRead, write = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
  lock = realLock, stopping = () => false, say = () => {}, now = () => new Date(),
  take = () => takeMerger({ root }), release = () => releaseMerger({ root }),
  land = (job) => landJob(job, { root, say, now, read, lock }),
  landed = parentLanded(root, { read }),
} = {}) {
  if (!take()) { say('another merger is running — leaving'); return 0; }
  say(`merger ${process.pid} started`);
  try {
    for (;;) {
      if (stopping()) { say('asked to stop — leaving between jobs'); return 0; }
      const job = lock(root, () => {
        const entries = parseQueue(read(mergesPath(root)));
        const next = nextJob(entries, { landed });
        if (next) write(mergesPath(root), markLanding(entries, next, now().toISOString()));
        return next;
      });
      if (!job) {
        // Released before the last look: an `mc merge` that queued between
        // the read above and now saw this merger alive and started none, so
        // the queue is read once more with the file gone — and taken again
        // if there is work, unless that call's own merger already has it.
        // A job waiting on one that came back red stays in the queue and
        // is not work: the merger leaves, and that one's next `mc merge`
        // starts a merger again.
        release();
        if (!nextJob(parseQueue(read(mergesPath(root))), { landed }) || !take()) { say('nothing the merger may take — leaving'); return 0; }
        continue;
      }
      say(`${job.repo} #${job.pr}: landing${job.step ? ` (${job.step.project} step ${job.step.index + 1})` : ''}`);
      let report = null;
      try {
        report = await land(job);
      } catch (error) {
        say(`${job.repo} #${job.pr}: the round threw — ${error?.stack || error}`);
        report = { ok: false, merged: false, stopped_at: 'threw', reason: `the round threw (${error?.message || error})` };
      }
      // Landed, the job is gone; red, it stays as a red row on the page until
      // `mc merge` puts it back in line or the pull request is closed.
      const answered = now().toISOString();
      const done = report?.ok && report.merged;
      lock(root, () => {
        const entries = parseQueue(read(mergesPath(root)));
        write(mergesPath(root), done
          ? dequeue(entries, job)
          : markRed(entries, job, { reason: `${report?.stopped_at || 'unknown'}: ${report?.reason || 'the round said nothing'}`, answered }));
      });
    }
  } finally {
    release();
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
