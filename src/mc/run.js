/**
 * `mc run` — the runner, inside mc.
 *
 * The runner starts goal sessions: a free lane takes the next goal that could
 * start on any repository (`nextWork`, `pickWork` in lane-pick.js) — a build
 * session on an open goal, a review session on a goal in review, or the plan
 * session a blocked goal wakes — runs it, and picks again. One session is one
 * fresh headless process in the goal's worktree (a plan session stands in the
 * programme's directory). The runner decides nothing with a model: it reads
 * files, runs git and gh, starts the session through the launch adapter and
 * waits for it. It is the parent of the process it starts.
 *
 * Where a goal stands is its own GOAL.json and LOG.md (goals.js). A session
 * writes its entry with `mc goal log`; one that ends without a word gets a
 * runner entry, and three of those in a row block the goal (`goalWithoutWord`).
 * A review or plan session sends its goal to merge;
 * a goal whose pull requests have all landed is set done (`settleLanded`); a
 * goal waiting on `after` is opened when those have landed (`releaseWaiting`).
 *
 * There is no round. Each lane is a loop on its own clock, `mc run lanes <n>`
 * of them in total, and the chores run in a loop of their own beside them.
 * `--once` is one session, for a person watching.
 *
 * The chores take away what is finished and keep the machine fit: a goal
 * done or dropped for 24 hours is archived (`archiveGoalsDue`, goal-archive.js),
 * every repository is fetched and asked what is open for the page
 * (`askGithub`), a merger that should be running is started (`wakeMerger`),
 * orphaned dev processes are reaped, Docker and scratch are swept.
 *
 * Things that are not goal sessions ride along, and none opens a worktree or
 * touches a branch. `runHelperDay` is the collect: once per calendar day, in
 * the first chore loop after 05:00Z, one digest per repository into
 * `~/mc/intake/`, no model. `runIntakeDrain` is the inbox: every chore loop, the
 * oldest files in `~/mc/intake/` up to `INTAKE_PER_ROUND`, one headless turn
 * each, each file archived under `~/mc/runner/log/intake/<date>/` the moment its
 * turn ends. `runTidyDaily` and `runDepsDaily` are `mc tidy --apply` and
 * `mc deps`, once a day each. The nightly's tick is the last a chore pass
 * does: `runNightly`, a full run of every repository mc knows when a day has
 * passed since the last one, gated by its own row in runs.tsv. `mc run stop`
 * stops it, between repositories as well as between passes; `--once` runs no
 * chores and so no tick.
 *
 * The runner is worked from another terminal by files under `~/mc/runner/`,
 * all read between two picks and never mid-session: `STOP` ends it, `UPDATE`
 * makes it fast-forward mc's own checkout and hand over to a fresh process on
 * the new code. `mc run start|stop|--update` write them; the rules and the
 * handover are in run-control.js. The runner writes `UPDATE` itself only when
 * origin/main of a clean checkout that fast-forwards has moved
 * (`noticeNewCode`).
 *
 * Every process boundary is a dependency on `deps`, so a lane's pass can be
 * driven in a test with a fake git, gh and session and no network. The rules
 * themselves live in run-plan.js.
 */
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import { writeJsonAtomic } from './atomic-write.js';
import { defaultRepos } from './brief-collect.js';
import { run as runGit } from './git.js';
import { gitDirOf } from './repos.js';
import { reap as reapDevServers } from './dev-reap.js';
import { freeMemoryPercent } from './dev-servers.js';
import { sweepDocker, tidyDocker } from './docker.js';
import { REVIEW_CLASS } from './plan-schema.js';
import { addGoalWorktree, appendEntry, FINISHED, GOAL_FILE, goalBranch, goalOfRecord, goalSession, mergeAnswered, prsLanded, goalName, renderGoalText, inStage, lastBuildEntry, LOG_FILE, logStamp, parseGoal, PLAN_ROLE, parseLog, programsGoals, phaseOpen, remakeUnbuiltBranches, REVIEW_DIED_TEXT, REVIEW_ROLE, reviewDiedBefore, setGoalState, stageSince, stageWords } from './goals.js';
import { phaseGoals } from './goal-convert.js';
import { realLock } from './runner-lock.js';
import { drainState, drainWaiting, handOver, mcCheckout, readRunner } from './run-control.js';
import { collectHelper, describeDigest, HELPER_REPOS, unreadableSections } from './helper-collect.js';
import { describeTurn, drainIntake, runHelperTurn } from './helper-turn.js';
import { loggedTick } from './nightly-loop.js';
import { rotateIfLarge } from './logger.js';
import { runTidy } from './tidy.js';
import { readDeps } from './deps.js';
import { RUNNER_DISK, RUNNER_MEMORY, programsHome, runnerDir, runnerScratchDir, workRoot } from './paths.js';
import { archiveGoal, goalArchiveDue } from './goal-archive.js';
import {
  DIAGNOSE_TIMEOUT_MS, GITHUB_CAUSES, GITHUB_STATE, diagnoseGithub, failedAsk, mayAsk, nextAskAt,
} from './github-backoff.js';
import { inLine, mergesPath, nextJob, parseQueue } from './merge-queue.js';
import { queueMerge, readMerger, startMerger } from './merger.js';
import { pidAlive } from './status-collect.js';
import { PR_LIST_ARGS } from './open-prs.js';
import { mergePrs } from './page-cache.js';
import { profileArgs } from './portrait.js';
import { DEFAULT_LANES, readLaneCount } from './lane-count.js';
import { pickWork } from './lane-pick.js';
import { readProgrammePriority } from './programme-priority.js';
import { runsKind } from './session-kind.js';
import { CREDITS_RETRY_MS, patchBillingState, planWindows, readBillingApi, readBillingState } from './billing.js';
import { withoutSessionIdentity } from './session-role.js';
import { CODEX_POLL_MS, refreshCodexCapacity } from './codex-capacity.js';
import { applyRefusal, normaliseCapacity, observeClaudeStream, readCapacity, writeCapacity } from './model-capacity.js';
import { chooseCandidate } from './model-choice.js';
import { readModels } from './model-config.js';
import { billingRoute, gatewayLaunch } from './billing-route.js';
import { instructionsFor, readCanonRole, roleFileText, roleRecord, roleSourceOf } from './roles.js';
import { keepAwake, onACPower } from './stay-awake.js';
import { attachRepoDepsAsync } from './shared-deps.js';
import { rmTree } from './rm-tree.js';
import {
  DEPS_KIND, DEPS_NAME, TIDY_KIND, HELPER_KIND, HELPER_NAME, INTAKE_KIND, INTAKE_PER_ROUND, NIGHTLY_KIND, NIGHTLY_NAME, QUOTA_SLEEP_MS, RESULT_GRACE_MS, TIMEOUT_EXIT,
  BUILD_ROLES, collectNote, goalCheckInPrompt, goalPlanCheckInPrompt, goalPlanPrompt, goalPrompt, goalReviewPrompt, headlessArgs, helperDue, intakeNote, nightlyDue, quietPrompt,
  readSessionOutput, sessionResult, routedSettings, streamSummary, describeSettings, describeWatch, tsvHeader, tsvRow, userMessageLine,
} from './run-plan.js';

/** How often the runner asks GitHub whether a goal's pull requests have all landed (`settleLanded`). */
export const SETTLE_EVERY_MS = 5 * 60_000;

export const REPO_NAMES = ['memoro', 'memoro-cli'];

/** Headless planning candidates, independent of the build/review catalog. */
const HEADLESS_PLAN_CANDIDATES = Object.freeze([
  Object.freeze({ tool: 'claude', model: 'opus', effort: 'medium' }),
  Object.freeze({ tool: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }),
]);

/**
 * A session's scratch directory is kept this long after it was last touched.
 * Two days, not seven: on 2026-10-08 scratch held 15 GiB and a session hit
 * ENOSPC. Not hours either — the gate logs a proposal cites live here.
 */
export const SCRATCH_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Below this many free bytes on the volume where `MC_SCRATCH` is made, no
 * session starts (2026-10-08: 118 MiB free, and a session's first shell
 * commands failed on ENOSPC). Sessions already running go on.
 */
export const DISK_MIN_BYTES = 5 * 2 ** 30;

/**
 * Below this `kern.memorystatus_level` (percent of memory free), no
 * session starts. Above the dev servers' 15 (`DEFAULT_MIN_FREE_PERCENT`,
 * dev-servers.js), so a session does not start into a machine its gate's own dev
 * server would be refused on (2026-10-10: 30 % free, swap 2.4 of 3 GB, on
 * 8 GB). Sessions already running go on.
 */
export const MEMORY_MIN_FREE_PERCENT = 20;

/**
 * After a lane skipped a pass for disk (`diskRoom`), the next chore pass runs
 * `mc tidy --apply` — at most this often, so a disk tidy cannot free stays
 * full without the runner tidying every pass.
 */
export const TIDY_DISK_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** `runner.log` moves to `runner.log.1` past this size; one generation is kept. */
export const RUNNER_LOG_MAX_BYTES = 32 * 2 ** 20;

/** How often an idle lane looks again while an UPDATE waits for the quiet moment. */
export const UPDATE_POLL_MS = 30 * 1000;
/**
 * How often a draining runner says what it still waits on. Measured
 * 2026-10-05: a drain said one line when it began and nothing more for 42
 * minutes, and a silent drain is one a person force-stops.
 */
export const DRAIN_TICK_MS = 10 * 60 * 1000;
/** How often a lane held back by the total cap looks for a free slot again. */
export const TOTAL_POLL_MS = 15 * 1000;
/** How often a session's heartbeat reads the wall clock (`streamSession`). */
export const SLEEP_TICK_MS = 30 * 1000;
/** A gap between two heartbeats longer than this means the runner did not run: the machine slept. Above `sh()`'s 120 s, so a synchronous wait is never taken for one. */
export const SLEEP_GAP_MS = 3 * 60 * 1000;

/**
 * The lane total as `lanes.json` says it now (`mc run lanes`). `deps.laneCount`
 * answers `{ lanes }`, or the number itself.
 */
export function laneTotal(deps = {}) {
  const read = deps.laneCount || (() => readLaneCount({ repos: REPO_NAMES.length }));
  const value = read();
  return typeof value === 'number' ? value : value?.lanes;
}

/** Short shas of two lengths name one commit when one starts the other. */
function sameCommit(a, b) {
  const [x, y] = [String(a).trim(), String(b).trim()];
  return Boolean(x && y) && (x.startsWith(y) || y.startsWith(x));
}

/** The tail of the tidy line for `tidyDocker`'s answer: empty when Docker was down or not asked. */
export function dockerNote(docker) {
  if (!docker?.pruned?.length) return '';
  const parts = docker.pruned.map((item) => (item.ok ? `${item.what} ${item.reclaimed || '0B'}` : `${item.what} failed — ${item.detail}`));
  return ` · docker: ${parts.join(', ')}`;
}

/* ------------------------------------------------------------ real deps */

function sh(cmd, args, { cwd, timeout = 120_000, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20, env: env ? { ...process.env, ...env } : undefined });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** `sh` for git — the same limits and answer, started through the one git seam (git.js). */
function shGit(args, { timeout = 120_000, env } = {}) {
  const r = runGit(undefined, args, { timeoutMs: timeout, maxBuffer: 64 << 20, ...(env ? { env: { ...process.env, ...env } } : {}) });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * One session: the adapter's binary with the headless argument list, and
 * nothing killed on elapsed time (ruling 18).
 *
 * For claude (`prompt` given) stdin is a pipe. The prompt goes in as the
 * first stream-json user message; every `checkInMs` while the session runs,
 * `checkIn(elapsedMinutes, count)` is written as another, and the session
 * judges its own work. A message written mid-turn is folded into that turn;
 * one written after a `result` starts a new turn — so on a `result` line
 * stdin is ended, no check-in follows, and claude exits. Not while a
 * background task runs: claude reports its set in `background_tasks_changed`
 * events, and a turn that ended with one alive is a pause — claude starts the
 * next turn itself when the task finishes — so stdin stays open. Two kills:
 * the stall guard — `stallMs` without a byte on stdout, armed at spawn and
 * reset on every chunk, SIGTERMs the child and reports `stalled` — and, once
 * the `result` has been seen, the result grace: the process gets
 * `resultGraceMs` to exit and is then killed with the result standing
 * (`lingered`, status 0, not stalled). A session waiting on a background task
 * is silent for as long as the task runs, so when the stall guard fires with
 * one alive it writes `onQuiet(minutes, tasks)` instead of killing, once per
 * silence: a session that answers it has shown it is alive, and one that does
 * not is killed at the next `stallMs`. A machine that slept is not a silent
 * session: a heartbeat every `SLEEP_TICK_MS` reads the wall clock, and when the
 * guard fires with a gap over `SLEEP_GAP_MS` inside the silence (the stall
 * timer can be the first to wake, so it looks too), it calls `onSleep(minutes)`
 * and re-arms for a full `stallMs` instead of killing.
 *
 * Codex (no `prompt`) keeps its positional prompt with stdin closed, and gets
 * neither a check-in nor a stall guard: nothing kills it.
 *
 * `spawn` and not `spawnSync`: two lanes run in this one process, and a
 * synchronous wait would hold the event loop for the whole session — the
 * second lane would never get to start. The output is collected here instead
 * of by `maxBuffer`, and capped rather than allowed to eat the machine.
 *
 * `logPath`, when given, gets every stdout chunk appended as it arrives: a
 * session that dies with the machine leaves its stream — its session id, its
 * context, its last words — on disk, where a person can read it. The log
 * is a record, not the session: a write
 * that fails is dropped and the session goes on. The resolved object carries
 * the `signal` the process ended on, if it did.
 *
 * `unsetEnv` names variables taken out of `env` before the child sees it: a
 * session on the plan is started without `ANTHROPIC_API_KEY` and
 * `ANTHROPIC_AUTH_TOKEN` even when the runner's own environment has them, so
 * an ambient provider API key cannot change its billing.
 */
export function streamSession({ bin, args, cwd, env, unsetEnv = [], prompt = null, checkInMs = 0, stallMs = 0, resultGraceMs = RESULT_GRACE_MS, checkIn = null, onQuiet = null, onSleep = null, onSpawn = null, logPath = null, spawn: spawnFn = spawn, maxRunMs = 0 }) {
  return new Promise((resolve) => {
    const piped = prompt != null;
    let childEnv = env;
    if (env && unsetEnv.length) {
      childEnv = { ...env };
      for (const name of unsetEnv) delete childEnv[name];
    }
    const child = spawnFn(bin, args, { cwd, stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: childEnv });
    // A record, not the session, so a throwing recorder must not end the run.
    if (child.pid && onSpawn) { try { onSpawn(child.pid); } catch { /* recorded elsewhere */ } }
    let logFd = null;
    if (logPath) {
      try { mkdirSync(dirname(logPath), { recursive: true }); logFd = openSync(logPath, 'a'); } catch { logFd = null; }
    }
    const logChunk = (chunk) => {
      if (logFd == null) return;
      try { writeSync(logFd, chunk); } catch { /* a record, not the session */ }
    };
    const closeLog = () => {
      if (logFd == null) return;
      try { closeSync(logFd); } catch { /* already closed */ }
      logFd = null;
    };
    const cap = 256 << 20;
    const collect = (stream, onChunk) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        if (size < cap) { chunks.push(chunk); size += chunk.length; }
        onChunk?.(chunk);
      });
      return () => Buffer.concat(chunks).toString('utf8');
    };
    const started = Date.now();
    let settled = false;
    let failure = null;
    let stalled = false;
    let lingered = false;
    let resultSeen = false;
    let stallTimer = null;
    let graceTimer = null;
    let checkInTimer = null;
    let deadlineTimer = null;
    let deadlineKill = null;
    let count = 0;
    // The background tasks claude last reported, and whether this silence has
    // already been asked about them.
    let tasks = [];
    let asked = false;
    // The heartbeat: a gap between two of its ticks over `SLEEP_GAP_MS` is a
    // sleep inside the silence, counted in `slept` until the guard reads it.
    let lastBeat = Date.now();
    let slept = 0;
    let beatTimer = null;
    const beat = () => {
      const now = Date.now();
      const gap = now - lastBeat;
      lastBeat = now;
      if (gap > SLEEP_GAP_MS) slept += gap - SLEEP_TICK_MS;
    };
    const stop = () => { clearTimeout(stallTimer); clearTimeout(graceTimer); clearInterval(checkInTimer); clearInterval(beatTimer); clearTimeout(deadlineTimer); clearTimeout(deadlineKill); };
    const send = (text) => {
      if (!piped || resultSeen || settled || !child.stdin?.writable) return;
      child.stdin.write(userMessageLine(text));
    };
    const armStall = () => {
      if (!stallMs || stalled || resultSeen || settled) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        // The gap is read here, before anything is decided: at wake the stall
        // timer can fire before the heartbeat tick that would have seen it.
        beat();
        if (slept > 0) {
          const minutes = Math.round(slept / 60_000);
          slept = 0;
          try { onSleep?.(minutes); } catch { /* a log line, not the session */ }
          armStall();
          return;
        }
        if (tasks.length && onQuiet && !asked) {
          asked = true;
          send(onQuiet(Math.round(stallMs / 60_000), tasks));
          armStall();
          return;
        }
        stalled = true;
        stop();
        child.kill('SIGTERM');
      }, stallMs);
    };
    // Lines are scanned for a `result` only while stdin is still open; a
    // partial line waits for the rest of it.
    const decoder = new StringDecoder('utf8');
    let partial = '';
    const onResultLine = () => {
      resultSeen = true;
      clearInterval(checkInTimer);
      try { child.stdin.end(); } catch { /* already closed */ }
      // The session has answered: from here the process has `resultGraceMs`
      // to exit, whatever it writes meanwhile and whether or not a stall
      // guard is set. The stall timer is dropped — the grace replaces it.
      clearTimeout(stallTimer);
      graceTimer = setTimeout(() => {
        if (settled) return;
        lingered = true;
        stop();
        child.kill('SIGTERM');
      }, resultGraceMs);
    };
    // The whole line is searched: claude writes a `result` event's `type`
    // after its usage, some 2 000 characters in, so a look at the head of the
    // line never saw one (2026-09-25).
    const scan = (chunk) => {
      logChunk(chunk);
      asked = false;
      slept = 0;
      armStall();
      if (!piped || resultSeen) return;
      const text = partial + decoder.write(chunk);
      const lines = text.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const isResult = line.includes('"type":"result"');
        if (!isResult && !line.includes('"subtype":"background_tasks_changed"')) continue;
        let event = null;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.subtype === 'background_tasks_changed') tasks = Array.isArray(event.tasks) ? event.tasks : [];
        // A resumed session whose background shell died with the previous
        // process opens with a `task_notification` and a `result` of zero turns
        // (`origin.kind: task-notification`). It answers nothing, and taking it
        // for the end killed msr-core-finish-measure on 2026-10-17. A
        // task-notification result with turns is a real end.
        else if (event?.type === 'result' && !tasks.length && event.num_turns !== 0) { onResultLine(); return; }
      }
    };
    const stdout = collect(child.stdout, scan);
    const stderr = collect(child.stderr);
    const done = (value) => { if (!settled) { settled = true; stop(); resolve(value); } };
    if (piped) {
      // A check-in written to a child that has just exited is an EPIPE on
      // the stream, not a crash of the runner and both its lanes.
      child.stdin.on('error', () => {});
      send(prompt);
      if (checkInMs && checkIn) {
        checkInTimer = setInterval(() => {
          if (settled || resultSeen) return;
          count += 1;
          send(checkIn(Math.round((Date.now() - started) / 60_000), count));
        }, checkInMs);
      }
    }
    if (stallMs) beatTimer = setInterval(beat, SLEEP_TICK_MS);
    armStall();
    // Explicit bounded planner sessions only. Signal the child started above,
    // never a process discovered by name; wait for close before releasing it.
    if (Number.isSafeInteger(maxRunMs) && maxRunMs > 0) deadlineTimer = setTimeout(() => {
      if (settled) return;
      stalled = true;
      deadlineKill = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1000);
      child.kill('SIGTERM');
    }, maxRunMs);
    child.on('error', (error) => {
      failure = error;
      if (!child.pid) { closeLog(); done({ status: 1, stdout: '', stderr: String(error.message), timedOut: false, stalled: false }); }
    });
    child.on('close', (status, signal) => {
      closeLog();
      done({
        status: stalled ? TIMEOUT_EXIT : (lingered ? 0 : (status ?? 1)),
        stdout: stdout(),
        stderr: stderr() || (failure ? String(failure.message) : ''),
        timedOut: stalled,
        stalled,
        lingered,
        signal: signal ?? null,
      });
    });
  });
}

export function realDeps(env = process.env) {
  return {
    env,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    git: (cwd, args, { env } = {}) => shGit(['-C', cwd, ...args], { env }),
    gh: (cwd, args) => sh('gh', args, { cwd }),
    // Why a `gh pr list` failed: a locked keychain or a bad token, two calls
    // of two seconds at most (github-backoff.js).
    diagnoseGithub: () => diagnoseGithub({ run: (cmd, args) => sh(cmd, args, { timeout: DIAGNOSE_TIMEOUT_MS }) }),
    exists: existsSync,
    // The runner's lock (runner-lock.js): every write of the merger's queue takes it.
    lock: (root, fn) => realLock(root, fn),
    // The one liveness test the page, `mc run start` and the loop's own
    // refusal all use, so a runner.json that names a pid means the same thing
    // to every reader of it.
    alive: pidAlive,
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    list: (path) => { try { return readdirSync(path); } catch { return []; } },
    // Files only, for the one caller that must not mistake a directory for an
    // item: `~/mc/intake/decisions-archive/` is an archive, not an inbox entry.
    files: (path) => {
      try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; }
    },
    write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
    append: (path, text) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, text); },
    // A rename, never a copy: an inbox file to its archive, a finished goal
    // to `goals/.archive/`, a dead runner's lane file to `runner/log/`.
    move: (from, to) => {
      try { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); return true; } catch { return false; }
    },
    // The chore pass's reaper: dev processes nobody owns any more.
    reapDevServers: () => reapDevServers({ dryRun: false }),
    // The chore pass's Docker sweep (docker.js): dead leases, labelled leftovers, the idle stop.
    dockerSweep: () => sweepDocker({}),
    // The two files that say a runner is here and a session is in flight. Whole
    // or not at all: `mc status` reads them while they are being written.
    writeJson: (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
    remove: (path) => { try { rmSync(path, { force: true }); } catch { /* already gone */ } },
    // A session's scratch directory (`~/mc/runner/scratch/`): made before the
    // session, and the directories in it that are old enough are taken by the
    // chore pass. `scratchDirs` lists directories only, with their age.
    mkdir: (path) => { mkdirSync(path, { recursive: true }); },
    scratchDirs: (path) => {
      try {
        return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory())
          .map((e) => ({ name: e.name, mtimeMs: statSync(join(path, e.name)).mtimeMs }));
      } catch { return []; }
    },
    // The bytes an unprivileged writer can still use on the volume holding
    // `path` — or its nearest existing parent, since scratch may not exist
    // yet. Null when nothing can be read.
    freeBytes: (path) => {
      for (let at = path; ; at = dirname(at)) {
        try { const fs = statfsSync(at); return Number(fs.bavail) * Number(fs.bsize); } catch { /* try the parent */ }
        if (dirname(at) === at) return null;
      }
    },
    // `kern.memorystatus_level`, the percent of memory free; null off macOS.
    freeMemoryPercent: () => freeMemoryPercent(),
    // Read-only files and directories go too (rm-tree.js): memoro's dependency cache is read-only.
    rmTree: (path) => rmTree(path),
    pid: process.pid,
    // `~/mc/runner/billing.json` and `billing-state.json` (billing.js): the
    // mode Martin set and the plan's windows the runner has seen. A dependency
    // so a test never reads or writes the machine's own.
    billing: {
      readState: () => readBillingState({ root: runnerDir(env) }),
      readApi: () => readBillingApi({ root: runnerDir(env) }),
      patchState: (patch) => patchBillingState(patch, { root: runnerDir(env) }),
    },
    // The model catalog (`models.json`, model-config.js) and the capacity snapshot (`model-capacity.json`,
    // model-capacity.js): local files, read at each class-routed launch (ruling 59). Codex's windows and
    // models are read by `refreshCodex` from the chore pass, once an hour, and by nothing else.
    catalog: () => readModels(env),
    capacity: { read: () => readCapacity({ root: runnerDir(env) }), write: (state) => writeCapacity(state, { root: runnerDir(env) }) },
    refreshCodex: () => refreshCodexCapacity({ root: runnerDir(env) }),
    attachDeps: (worktree) => attachRepoDepsAsync(worktree),
    role: readCanonRole,
    launch: resolveLaunch,
    // The two halves of `mc helper --intake`, so a round can be driven in a test with
    // no production behind it and no model in it. The drain itself is not a
    // dependency — it is handed `files`, `move` and `helperTurn` above, so a
    // test's filesystem is the one it archives into and the loop is measured
    // rather than replaced.
    collect: (options) => collectHelper({ env, ...options }),
    helperTurn: (options) => runHelperTurn({ env, ...options }),
    // The nightly's tick — every repository's whole suite, in order — with its
    // narration in `~/.memoro/mc/nightly/nightly.log`. A dependency so a test
    // can drive the chore without a suite behind it.
    nightlyTick: (options) => loggedTick({ env, ...options }),
    // `mc deps <repo>`'s reading, saved where `mc deps` and the page read it.
    // A dependency so a test drives the chore without npm or a remote.
    readDeps: (options) => readDeps({ env, refresh: true, ...options }),
    // `mc tidy --apply` (tidy.js): its list written, then removed from, and
    // Docker's images unused for three days on a runtime that is already up (`tidyDocker`). A dependency so a fixture without it
    // removes nothing on the machine running the suite.
    tidy: async () => ({ ...runTidy({ apply: true, env }), docker: await tidyDocker({ apply: true, env }) }),
    // runner.log to runner.log.1 past the limit (logger.js).
    rotate: (path, maxBytes) => rotateIfLarge(path, maxBytes),
    // The one door work lands through: the merger's queue (ruling 30), the
    // same call `mc merge` makes, in process because the runner is mc.
    // Dependencies so a test drives them without a real merger, suite or remote.
    queueMerge: (options) => queueMerge({ env, ...options }),
    startMerger: (options) => startMerger({ env, ...options }),
    pendingMerges: (root) => { try { return parseQueue(readFileSync(mergesPath(root), 'utf8')); } catch { return []; } },
    // The session — `streamSession` below. The session's Bash tool gets a
    // ten-minute ceiling instead of claude's two-minute default. Measured
    // 2026-09-01..03: with two minutes, a session ran `npm test` in the
    // background and polled it in `sleep` loops of 120 s — 212 such calls,
    // 1.9 h of 12.5 h tool time — and 17 calls were killed on the timeout
    // itself. A suite run is one call now. The same ten minutes is why
    // `DEFAULT_STALL_MINUTES` is twenty.
    //
    // `options.env` is what the runner adds for this session — `MC_GOAL`,
    // `MC_ROLE` and the rest, so `mc goal log` and `mc merge` inside it know
    // which goal they are on, and `MC_SCRATCH`, a directory outside the
    // worktree for its probes. `options.unsetEnv` is taken out of the merged
    // environment by `streamSession`.
    session: (options) => streamSession({
      ...options,
      env: { ...withoutSessionIdentity(env), BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '600000', ...(options.env || {}) },
    }),
    // `mc run --update`: this runner's replacement, on the code that is on
    // disk now. Node read its whole module graph at process start, so the only
    // way to run new code is to be a new process — the same argument list,
    // detached so it outlives this one, and the same stdio, which for a runner
    // `mc run start` spawned is the append handle on runner.log. `extra` is
    // `MC_RUN_SUCCESSOR_OF`, which lets it start beside this one (`runLoop`).
    respawn: ({ env: extra = {} } = {}) => {
      const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'inherit', env: { ...env, ...extra } });
      child.unref();
      return child.pid ?? null;
    },
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

/* --------------------------------------------------------------- runner */

export function createRunner({ merge = true, deps = realDeps() } = {}) {
  const root = workRoot(deps.env);
  // The goals under `~/mc/programs/`, read through the runner's own env and
  // file reads: the process's env is not the runner's in a test, and a suite
  // run by the merger inherits MC_WORK_ROOT from the runner, so the runner's
  // tests once queued the real programmes' work beside their fixture's and
  // one hung for hours waiting for a STOP it never wrote (2026-10-19).
  const goals = () => programsGoals({ home: programsHome(deps.env), list: deps.list, read: deps.read });
  const paths = {
    log: join(root, 'runner', 'log'),
    scratch: runnerScratchDir(deps.env),
    runs: join(root, 'runner', 'log', 'runs.tsv'),
    runnerLog: join(root, 'runner', 'log', 'runner.log'),
    stop: join(root, 'runner', 'STOP'),
    // `mc run --update` leaves this one. It is read where STOP is read — at a
    // round boundary — because it means the same kind of thing: finish what
    // you are in, then do as you are told. See run-control.js.
    update: join(root, 'runner', 'UPDATE'),
    // What is running, for anyone who asks. runner.json says a runner is
    // here and names the pid to test; `current-<repo>.json` exists only
    // while that lane's session is in flight — one file per lane, because two
    // sessions run side by side. runs.tsv gets its row when the session is over —
    // that is too late to answer "what is running now", which is why these
    // exist.
    runner: join(root, 'runner', 'runner.json'),
    // With more than one lane per repository (`mc lanes`), the first keeps
    // the file's old name and the rest number themselves, so the page —
    // which reads `current-*.json` by name — needs no new rule.
    currentFor: (repo, lane = 0) => join(root, 'runner', lane ? `current-${repo}-${lane}.json` : `current-${repo}.json`),
    currents: () => deps.list(join(root, 'runner')).filter((file) => /^current-.+\.json$/u.test(file)).map((file) => join(root, 'runner', file)),
    // The repositories GitHub could not be asked about, and when to ask
    // again (github-backoff.js). The page draws its RUNNER line from it.
    github: join(root, 'runner', GITHUB_STATE),
    // Present while the disk is too full for a session to start; the page draws
    // its line.
    disk: join(root, 'runner', RUNNER_DISK),
    // Present while too little memory is free for a session to start.
    memory: join(root, 'runner', RUNNER_MEMORY),
  };
  const writeJson = deps.writeJson || ((path, value) => deps.write(path, `${JSON.stringify(value, null, 2)}\n`));
  const remove = deps.remove || (() => {});
  const pid = deps.pid ?? process.pid;
  const repos = defaultRepos(deps.env);
  const stamp = () => deps.now().toISOString().replace(/\.\d{3}Z$/u, 'Z');
  // When a lane last skipped for disk, and when that last ran a tidy.
  let diskSkippedAt = null;
  let lastDiskTidyAt = null;
  const say = (text) => {
    const line = `${stamp()}  ${text}`;
    deps.append(paths.runnerLog, `${line}\n`);
    deps.log(line);
  };
  const gitOut = (cwd, args) => { const r = deps.git(cwd, args); return r.ok ? String(r.stdout ?? '').trimEnd() : null; };
  // The lock every write of the merger's queue takes (runner-lock.js), through
  // this runner's dependencies: the real one only where the dependencies are
  // (`deps.lock`), because a test's work root is not a directory.
  const lock = deps.lock || ((_root, fn) => fn());
  const alive = deps.alive || pidAlive;

  // Sticky: a STOP read once is a STOP for the rest of this run, whether or
  // not the file is still there. 2026-10-07 a STOP written three seconds
  // after a handover was read by eleven lanes and the chore loop, which exited
  // without a word, and removed ten minutes later — before the one lane that
  // had passed its check read it. That runner then ran twenty minutes on one
  // lane with 31 pieces of work ready, looking busy. STOP ends the runner, not the
  // lanes that happened to look.
  let stopSeen = false;
  const stopRequested = () => stopSeen || (stopSeen = deps.exists(paths.stop));
  // The origin/main shas `noticeNewCode` has already spoken about, so a
  // checkout that cannot be handed over is said once, not every pass.
  const codeNoticed = new Set();
  // Held from the moment a handover begins: `handOver` removes UPDATE as its
  // first act, and a runner that has handed over takes nothing new for the
  // rest of its life (`runLoop`, ruling 28). Let go only when the handover
  // failed and this runner goes on.
  let updateHeld = false;
  const updateRequested = () => updateHeld || deps.exists(paths.update) || Boolean(replaced());
  const holdUpdate = (on) => { updateHeld = Boolean(on); };
  /**
   * The live runner runner.json names when it is not this one, or null: a
   * runner `mc run start` (or `--update` on a stopping runner) started to take
   * over from this one (run-control.js `takeOver`). It reads as an UPDATE
   * already handed over — this runner takes no new session, finishes the ones it
   * holds, and leaves runner.json alone — because that is what it is, done
   * from outside rather than by this runner itself.
   */
  function replaced() {
    let named = null;
    try { named = JSON.parse(deps.read(paths.runner) ?? ''); } catch { return null; }
    const other = Number(named?.pid);
    if (!Number.isInteger(other) || other <= 0 || other === pid) return null;
    return alive(other) ? { pid: other } : null;
  }

  /**
   * The 5-hour Claude quota is one budget for everything this runner starts
   * on the plan. An intake turn refused on it sleeps here (`runIntakeDrain`),
   * and a second caller joins that same sleep: one sleep, not two, and no turn
   * spent to be told the same thing again. A goal session refused on it
   * refuses its provider instead (`refuseProvider`), so the next goal routes
   * past it.
   */
  let quotaSleep = null;
  /**
   * Sleep until one minute after the reset the refusal named, or thirty
   * minutes when it named none. A pause of days goes in slices, and between
   * two of them STOP and UPDATE end it — the runner is not deaf for a week.
   *
   * The slices are `UPDATE_POLL_MS` long, not thirty minutes: measured
   * 2026-10-07, every lane went to sleep at 18:30:58 and the UPDATE written
   * at 18:41 waited for the slice to end. An UPDATE already present ends the
   * pause before any sleep — a runner told to update has nothing to wait for
   * a quota for, and when it is quiet the handover is the next thing it does.
   *
   * A lost login is the same budget in another word: every lane's claude is
   * the same login, so every lane sleeps on it, and `why` is the line that
   * says so instead of the quota's.
   */
  async function quotaPause(until = null, why = null) {
    if (quotaSleep) { await quotaSleep; return; }
    const start = deps.now().getTime();
    const named = until instanceof Date && until.getTime() > start;
    const total = named ? until.getTime() + 60_000 - start : QUOTA_SLEEP_MS;
    say(why ? `${why} — every lane sleeping ${QUOTA_SLEEP_MS / 60000}m` : (named
      ? `quota seen — every lane sleeping until ${new Date(start + total).toISOString()} (the refusal's reset)`
      : `quota/rate limit seen — every lane sleeping ${QUOTA_SLEEP_MS / 60000}m`));
    quotaSleep = (async () => {
      let slept = 0;
      for (;;) {
        if (stopRequested() || updateRequested()) return;
        // The clock and the sum of the slices: the clock is right when the
        // machine slept through some of it, the sum ends a clock that stands.
        const remaining = Math.min(start + total - deps.now().getTime(), total - slept);
        if (remaining <= 0) return;
        const slice = Math.min(remaining, UPDATE_POLL_MS);
        await deps.sleep(slice);
        slept += slice;
      }
    })();
    try { await quotaSleep; } finally { quotaSleep = null; }
  }

  /**
   * The capacity snapshot (model-capacity.js) and what the runner does with it
   * (ruling 59). A deps without one reads as nothing observed: a claude plan may
   * be bootstrapped, codex is unavailable, and nothing is written.
   */
  const capacity = deps.capacity ?? { read: () => normaliseCapacity(null), write: () => {} };
  /** One observation or refusal written to the snapshot; a write that fails is said, and the session goes on. */
  function observeCapacity(change) {
    try { capacity.write(change(capacity.read())); } catch (error) { say(`capacity not recorded (${error?.message || error})`); }
  }
  /**
   * A provider refused a session until the reset the refusal named, or the
   * quota sleep from now when it named none. Only that provider is refused: the
   * other is still a candidate, which is how a goal's class runs on codex the
   * launch after claude refused.
   */
  function refuseProvider(provider, quotaReset) {
    const nowMs = deps.now().getTime();
    const until = quotaReset instanceof Date && quotaReset.getTime() > nowMs ? quotaReset : new Date(nowMs + QUOTA_SLEEP_MS);
    observeCapacity((state) => applyRefusal(state, provider, until.toISOString()));
    say(`${provider} refused until ${until.toISOString()}`);
  }
  /** The candidate a work class runs on now, from the local catalog and snapshot (`chooseCandidate`). No turn, no account read. */
  function routeClass(cls, { avoid = null, catalog = null } = {}) {
    try {
      const chosen = chooseCandidate({ cls, catalog: catalog ?? deps.catalog(), capacity: capacity.read(), now: deps.now(), avoid });
      // A class sent to the API reserve waits instead when that provider's API is off.
      const tool = chosen?.candidate?.tool;
      if (chosen?.billing === 'credits' && tool && deps.billing?.readApi?.()?.[tool] === false) {
        return { ok: false, transient: true, class: cls, reason: `${chosen.why}; ${tool} API off`, retry_at: null };
      }
      return chosen;
    } catch (error) {
      return { ok: false, transient: true, class: cls, reason: error?.message || String(error) };
    }
  }
  /**
   * Codex's windows and models, read at most once an hour (`CODEX_POLL_MS`).
   * Called by the chore pass, which is also the start: with no snapshot ever
   * taken, the first call is due. Read-only, and no session asks it anything. A
   * failed read is kept as the snapshot's failure and said; it never stops the
   * chores.
   */
  async function refreshCodexDue() {
    if (!deps.refreshCodex) return;
    const codex = capacity.read().providers.codex;
    const tried = [codex.observed_at, codex.failure?.at].map((at) => Date.parse(at || '')).filter(Number.isFinite);
    if (tried.length && deps.now().getTime() - Math.max(...tried) < CODEX_POLL_MS) return;
    try {
      const got = await deps.refreshCodex();
      say(got?.ok ? 'codex capacity read — its windows and models are noted' : `codex capacity not read: ${got?.why || 'no answer'} — the last snapshot stands`);
    } catch (error) {
      say(`codex capacity not read: ${error?.message || error} — the chores go on`);
    }
  }

  /* --------------------------------------------------------------- sessions */

  const lastLine = (r) => String(r.stderr || '').trim().split('\n').at(-1) || String(r.stdout || '').trim() || 'no reason given';

  /** One row in runs.tsv, header written the first time. Sessions and the chores. */
  function logRun(row) {
    if (!deps.exists(paths.runs)) deps.write(paths.runs, `${tsvHeader()}\n`);
    deps.append(paths.runs, `${tsvRow(row)}\n`);
  }

  const dashes = { turns: '-', input: '-', output: '-', cacheRead: '-', cacheWrite: '-', session: '-' };

  /**
   * What `deps.session` is handed besides the argument list: the prompt for
   * stdin, the check-in interval with the text it writes, and the stall
   * guard. A codex session gets none of it — its prompt is its last
   * positional and nothing watches it — so its stdin stays closed.
   */
  function watchFor(launch, settings, { prompt, name, onCheckIn = null, checkInText = goalCheckInPrompt }) {
    if (launch.id === 'codex') return {};
    return {
      prompt,
      checkInMs: settings.checkInMinutes * 60_000,
      stallMs: settings.stallMinutes * 60_000,
      checkIn: (minutes, count) => {
        say(`${name}: check-in ${count} at ${minutes} min`);
        onCheckIn?.(count, minutes);
        return checkInText({ minutes, count });
      },
      onQuiet: (minutes, tasks) => {
        say(`${name}: silent ${minutes} min with ${tasks.length} background task(s) running — asked, not killed`);
        return quietPrompt({ minutes, tasks });
      },
      onSleep: (minutes) => { say(`${name}: machine slept ${minutes} min — stall guard re-armed`); },
    };
  }

  /**
   * A session's three log files under one stem: the stream as it came
   * (`.jsonl` — already there when the session streamed into it, and then
   * left as it is), the result read from it alone (`.json`, the summed object
   * `scripts/measure-steps.py` reads — absent when there was none), and
   * stderr (`.json.err`, where it always was).
   */
  function writeSessionLogs(stem, result) {
    if (!deps.exists(`${stem}.jsonl`)) deps.write(`${stem}.jsonl`, result.stdout);
    // A session `mc merge` ended has no result line; its turns and usage are
    // read from the stream instead (`streamSummary`, `subtype: 'killed'`).
    const summed = sessionResult(result.stdout) || streamSummary(result.stdout);
    if (summed) deps.write(`${stem}.json`, `${JSON.stringify(summed)}\n`);
    deps.write(`${stem}.json.err`, result.stderr);
  }

  /* ------------------------------------------------------------- archiving */

  /**
   * The finished goals (`done` or `dropped`) that have been finished for 24
   * hours (`goalArchiveDue`), archived as `mc goal
   * archive` archives one (`archiveGoal`): the worktrees and the branch go
   * through git, the directory moves to `goals/.archive/`, a row goes to
   * `goals/goal_log.md`. A goal the archive refuses stays, and the refusal is
   * written into its LOG.md once, as a runner entry, not at every pass.
   */
  function archiveGoalsDue() {
    convertAfter();
    const all = goals();
    const now = deps.now();
    for (const goal of all) {
      if (goal.problems.length || !FINISHED.includes(goal.stage)) continue;
      if (!goalArchiveDue({ goal, nowMs: now.getTime() }).due) continue;
      const result = archiveGoal(goal, {
        home: programsHome(deps.env), git: deps.git, gh: deps.gh, known: () => repos.map((repo) => repo.path),
        move: (from, to) => { if (!deps.move(from, to)) throw new Error('the move failed'); },
        appendText: (path, text) => deps.append(path, text), read: deps.read, list: deps.list, write: deps.write, now,
      });
      if (result.refused) { refuseGoalOnce(goal, result.refused); continue; }
      say(`${goalName(goal)}: ${goal.stage} — archived to ${result.to}`);
      for (const move of result.renumbered) say(`${goalName(move.goal)}: phase ${move.from} → ${move.to}`);
    }
  }

  /** `archiveGoal`'s refusal of a finished goal, written into its LOG.md unless the log already says the same last. */
  function refuseGoalOnce(goal, why) {
    const comment = `not archived — ${why}`;
    if (goal.log.findLast((entry) => entry.tool === 'runner' && entry.comment?.startsWith('not archived'))?.comment === comment) return;
    const entry = { at: logStamp(deps.now()), tool: 'runner', model: null, stage: goal.stage, status: goal.status, done: null, comment, next: null };
    appendEntry({ dir: goal.dir, entry, read: deps.read, write: deps.write });
    say(`${goalName(goal)}: ${comment}`);
  }

  /**
   * The day's collect, run at the top of a round. Returns 'ran', 'failed' or
   * null when it was not due.
   *
   * It is not a goal session: it opens no worktree, touches no
   * branch, calls no model, and its rows in runs.tsv carry `helper` in both the
   * name and the kind column. `helperDue` is the whole gate, and those rows are
   * the whole state — one per repository, written whether the collect succeeded
   * or failed, which is how a failed collect stays unretried for the rest of the
   * day.
   *
   * Reading the digest is no longer part of this. The digest lands in the inbox
   * like anything else somebody put there, and `runIntakeDrain` takes it in its
   * turn — which is what lets a round drain without collecting, and collect
   * without the day's reading being the only reading there is.
   */
  async function runHelperDay() {
    const due = helperDue({ tsv: deps.read(paths.runs) || '', now: deps.now() });
    if (!due.due) return null;
    const t0 = deps.now().getTime();
    const took = () => Math.round((deps.now().getTime() - t0) / 1000);
    say('helper: the day\'s digest');

    // One digest per repository. memoro's production is the deployed service;
    // memoro-cli's is this machine, and until 2026-08-30 nothing read the
    // second — every failure in mc itself was found by a person noticing it.
    //
    // A repository that fails does not take the other down with it. The whole
    // reason the collect step reports per section instead of failing as a
    // unit is that these sources do not share a failure domain, and two
    // repositories share one even less.
    let outcome = null;
    for (const repo of HELPER_REPOS) {
      let digest = null;
      try {
        digest = await deps.collect({ now: deps.now(), repo });
      } catch (error) {
        say(`helper: ${repo}: the collect step failed — ${error?.message || error}. Not retried today.`);
        outcome = 'failed';
      }
      if (digest) {
        say(`helper: ${digest.path} — ${describeDigest(digest.data)}`);
        for (const note of digest.data.notes || []) say(`helper: ${repo}: ${note}`);
        for (const [section, source] of unreadableSections(digest.data)) say(`helper: ${repo}: ${section} not read — ${source.error}`);
        if (outcome !== 'failed') outcome = 'ran';
      }
      logRun({
        ts: stamp(), name: HELPER_NAME, kind: HELPER_KIND, exit: digest ? 0 : 1, seconds: took(), pr: '-',
        ...dashes, note: collectNote({ repo, digest }),
      });
    }
    return outcome;
  }

  /**
   * `mc tidy --apply` (tidy.js), once a day by its own runs.tsv row, and in
   * the first chore pass after a lane skipped for disk — that one at most
   * once per `TIDY_DISK_MIN_INTERVAL_MS`, remembered in memory. Shaped like
   * `runDepsDaily`: the row is written however it went. Returns 'ran',
   * 'failed' or null when it was not due.
   */
  async function runTidyDaily() {
    const now = deps.now().getTime();
    const due = nightlyDue({ tsv: deps.read(paths.runs) || '', now: deps.now(), kind: TIDY_KIND });
    const forDisk = diskSkippedAt !== null && (lastDiskTidyAt === null || now - lastDiskTidyAt >= TIDY_DISK_MIN_INTERVAL_MS);
    if ((!due.due && !forDisk) || !deps.tidy) return null;
    if (forDisk) { lastDiskTidyAt = now; diskSkippedAt = null; }
    const took = () => Math.round((deps.now().getTime() - now) / 1000);
    let outcome = null;
    let docker = null;
    let failure = null;
    try {
      const ran = await deps.tidy();
      outcome = ran?.outcome || null;
      docker = ran?.docker || null;
    } catch (error) { failure = error?.message || String(error); }
    const freed = outcome?.freed || 0;
    const items = outcome?.removed || 0;
    const kept = outcome?.kept || 0;
    logRun({
      ts: stamp(), name: TIDY_KIND, kind: TIDY_KIND, exit: failure ? 1 : 0, seconds: took(), pr: '-',
      ...dashes,
      note: `freed=${freed},items=${items},kept=${kept}`,
    });
    const why = forDisk ? 'a lane skipped for disk' : 'daily';
    say(failure
      ? `tidy (${why}): failed — ${failure}`
      : `tidy (${why}): freed ${(freed / 1e9).toFixed(2)} GB in ${items} items, kept ${kept} on re-check${dockerNote(docker)}`);
    return failure ? 'failed' : 'ran';
  }

  /**
   * The deps of every repository mc knows, read once a day: `mc deps <repo>`
   * with no reuse, saved where `mc deps` and the page find it. Returns 'ran',
   * 'failed' (a repository could not be read; the others were) or null when
   * it was not due.
   *
   * Shaped like `runNightly` below: `nightlyDue` with its own kind is the
   * whole gate and the row is the whole state, written however it went, so a
   * repository that cannot be read is not retried until tomorrow. About a
   * minute a repository, most of it `npm view`.
   */
  async function runDepsDaily() {
    const due = nightlyDue({ tsv: deps.read(paths.runs) || '', now: deps.now(), kind: DEPS_KIND });
    if (!due.due || !deps.readDeps) return null;
    const t0 = deps.now().getTime();
    const took = () => Math.round((deps.now().getTime() - t0) / 1000);
    say(`deps: reading every repository${due.why ? ` — ${due.why}` : ''}`);
    const read = [];
    const failed = [];
    for (const repo of repos) {
      if (stopRequested() || updateRequested()) break;
      try {
        const { reading } = await deps.readDeps({ repoPath: repo.path, repo: repo.name });
        const counts = reading.audit?.counts || {};
        say(`deps: ${repo.name} at ${String(reading.sha).slice(0, 7)} — ${counts.critical || 0} critical, ${counts.high || 0} high`);
        read.push(repo.name);
      } catch (error) {
        say(`deps: ${repo.name} not read — ${error?.message || error}`);
        failed.push(repo.name);
      }
    }
    logRun({
      ts: stamp(), name: DEPS_NAME, kind: DEPS_KIND, exit: failed.length ? 1 : 0, seconds: took(), pr: '-',
      ...dashes,
      note: `${failed.length ? `failed,${failed.join('+')}` : `success,${read.length}-read`}`
        + `${read.length + failed.length < repos.length ? ',stopped' : ''}`,
    });
    return failed.length ? 'failed' : 'ran';
  }

  /**
   * The nightly's tick: a full run of every repository mc knows, once a day.
   * Returns 'ran', 'stopped', 'failed' or null when it was not due.
   *
   * A chore beside the helper's and shaped like it: `nightlyDue` is the whole
   * gate and the row in runs.tsv is the whole state, written whether the tick
   * measured, skipped or threw, so a tick that failed is not retried ten
   * minutes later. The difference is the cadence — a day since the last tick,
   * not an hour of the clock — and the length: a tick is about twenty minutes,
   * which is why it is the last thing a chore pass does.
   *
   * It is a meter. It commits nothing, pushes nothing, writes nothing inside a
   * repository, and a gate round a lane holds ends the tick rather than being
   * waited for (`nightlyTick`). What it adds to the runner is that `mc run stop`
   * reaches it: STOP (and UPDATE, which drains the runner) are asked before
   * each repository, so a tick under way starts no further suite.
   */
  async function runNightly() {
    const due = nightlyDue({ tsv: deps.read(paths.runs) || '', now: deps.now() });
    if (!due.due) return null;
    const t0 = deps.now().getTime();
    const took = () => Math.round((deps.now().getTime() - t0) / 1000);
    say(`nightly: a full run of every repository${due.why ? ` — ${due.why}` : ''}`);
    let outcome = 'ran';
    let note = '';
    try {
      const tick = await deps.nightlyTick({
        say: (message) => say(`nightly: ${message}`),
        shouldStop: () => stopRequested() || updateRequested(),
      });
      const runs = tick?.runs || [];
      const unchanged = runs.filter((run) => run.stopped_at === 'unchanged').length;
      note = `success,${runs.length - unchanged}-measured,${unchanged}-unchanged`
        + `${tick?.skipped ? ',skipped-behind-a-round' : ''}${tick?.stopped ? ',stopped' : ''}`;
      if (tick?.stopped) {
        outcome = 'stopped';
        say(`nightly: stopped — ${runs.length} repositor${runs.length === 1 ? 'y' : 'ies'} read, the rest wait for the next tick`);
      }
    } catch (error) {
      const reason = error?.message || String(error);
      say(`nightly: the tick failed — ${reason}. Not retried until the next is due.`);
      note = `tick-failed,${reason}`;
      outcome = 'failed';
    }
    logRun({
      ts: stamp(), name: NIGHTLY_NAME, kind: NIGHTLY_KIND, exit: outcome === 'failed' ? 1 : 0, seconds: took(), pr: '-',
      ...dashes, note,
    });
    return outcome;
  }

  /**
   * The inbox, drained: the oldest files in `~/mc/intake/` up to
   * `INTAKE_PER_ROUND`, one headless turn each, each one archived under
   * `~/mc/runner/log/intake/<date>/` the moment its turn ends.
   *
   * There is no day gate here and there is not meant to be — the question is
   * *is there a file?*, and a round asks it every time. Thirteen files is
   * therefore five rounds rather than thirteen days, and a round with an empty
   * inbox costs a directory listing.
   *
   * The row is `kind: intake` with the **file** in the name column: a reader of
   * runs.tsv who cannot tell thirteen turns apart has no record at all, and the
   * name column is the column for naming the thing a row is about. `intakeNote`
   * carries the outcome.
   */
  async function runIntakeDrain() {
    const out = await drainIntake({
      env: deps.env,
      now: deps.now,
      limit: INTAKE_PER_ROUND,
      deps: {
        files: deps.files,
        move: deps.move,
        turn: deps.helperTurn,
        stop: stopRequested,
        onTurn: async ({ file, turn, archived, seconds }) => {
          logRun({
            ts: stamp(), name: file, kind: INTAKE_KIND, exit: turn.status ?? 1, seconds, pr: '-',
            turns: turn.turns ?? '-', input: turn.input ?? '-', output: turn.output ?? '-',
            cacheRead: turn.cacheRead ?? '-', cacheWrite: turn.cacheWrite ?? '-', session: turn.session ?? '-',
            note: intakeNote(turn),
          });
          for (const note of turn.groundNotes || []) say(`intake: ${note}`);
          say(turn.ok
            ? `intake: ${file} — ${describeTurn(turn)} (${seconds}s)`
            : `intake: ${file} — the turn did not finish: ${turn.reason || turn.note} (${seconds}s)`);
          // The one way the drain fails to terminate, so it is said out loud
          // rather than inferred from the same file appearing every round.
          if (!archived) say(`intake: ${file} could not be moved out of the inbox — the next round will take it again`);
          if (turn.quota) await quotaPause(turn.quotaReset);
        },
      },
    });
    if (out.left) say(`intake: ${out.left} file(s) still waiting`);
    return out;
  }

  /**
   * The machine's cap: at most `mc run lanes` sessions in flight anywhere, over
   * every repository and kind at once. The total is read from `lanes.json`
   * each time a slot is taken, so a new one applies to the next start without
   * a restart.
   *
   * The lane loops are that many already (`runLoop`'s `reconcile`), so in one
   * runner the count only matters in the overlap of a handover, when another
   * live runner is still finishing what it held. It is a count in two parts.
   * This process's own sessions are claims, held in `running`: a count of
   * `current-*.json` files would be the wrong instrument for them, because the
   * file is written after the session begins, so two lanes reading it in one
   * tick both see a free slot and both start. Another live runner's sessions
   * are counted by their lane files (`stepsHeld`), because after a handover
   * that runner takes no new work and its count only falls — a predecessor
   * finishing its last session while the successor starts is how two runners
   * held up to twice the cap (ruling 28).
   *
   * Taken at the last moment before the session rather than at the pick: most
   * readings between the two end in a refusal that spends no session at all.
   *
   * Admission to a free slot is FIFO. The durable waiting list also lets the
   * operator inspect held lanes.
   */
  let running = 0;
  let seen = { held: 0, cap: null };
  /** The total as `lanes.json` says it now: an integer above 0. */
  function capNow() {
    const lanes = laneTotal(deps);
    return Number.isInteger(lanes) && lanes > 0 ? lanes : DEFAULT_LANES;
  }
  /**
   * Take a slot, or don't — in one tick, with no await between the test and the
   * take. `stepsHeld` reads its files synchronously, so that holds here too.
   */
  const waitingPath = join(root, 'runner', 'waiting.json');
  const waiters = [];
  const saveWaiters = () => writeJson(waitingPath, { waiters });
  function takeSlot(name, waiter = null) {
    const cap = capNow();
    const held = running + stepsHeld().filter((h) => h.other).length;
    seen = { held, cap };
    if (held >= cap || (waiters.length && waiters[0] !== waiter)) return false;
    running += 1;
    return true;
  }
  const dropSlot = () => { running -= 1; };
  /** STOP, UPDATE and failed waits retire their tickets. No await separates
   * admission from taking a slot. */
  async function waitForSlot(name, { repo = null, lane = 0 } = {}) {
    if (takeSlot(name)) return 'ok';
    const waiter = { name, repo, lane, pid, since: stamp() };
    waiters.push(waiter);
    try {
      saveWaiters();
      say(`${name}: ${seen.held} of ${seen.cap} sessions in flight on this machine — waiting for a lane`);
      for (;;) {
        await deps.sleep(TOTAL_POLL_MS);
        if (stopRequested()) return 'stop';
        if (updateRequested()) return 'update';
        if (takeSlot(name, waiter)) return 'ok';
      }
    } finally {
      waiters.splice(waiters.indexOf(waiter), 1);
      // The file is for reading: failing to write it must not leak a taken slot.
      try { saveWaiters(); } catch (error) { say(`${name}: runner/waiting.json not written — ${error.message}`); }
    }
  }

  /**
   * One goal is in flight in one lane at a time, whatever the lanes' count
   * says. The first lane's session has written nothing yet that says the goal
   * is taken when a second lane picks, so the claim lives in this process,
   * where the lanes are: the pick takes it in the same tick it chooses
   * (`goalPass`), and a second lane picking a moment later cannot choose the
   * same goal. Two sessions in one worktree is the failure this refuses.
   */
  const claims = new Set();
  const claimRepos = new Map();
  /** The billing of a launch: the route's when it sent the class to the API reserve, otherwise the plan's until a window is full or the plan has refused. */
  async function billingFor(launch, route) {
    return route?.billing === 'credits' ? { billing: 'credits', why: route.why } : billingRoute({
      provider: launch.id === 'codex' ? 'codex' : 'claude',
      capacity: capacity.read(), state: deps.billing?.readState?.(), api: deps.billing?.readApi?.(), now: deps.now(),
    });
  }

  /**
   * What a refusal says about the billing it came on: a plan refusal is
   * `plan.refused_until` — its reset, or `QUOTA_SLEEP_MS` from now when it
   * named none — which moves the next launch to the API; an exhausted or
   * rejected credit is unusable for `CREDITS_RETRY_MS`, or until the date a
   * spent workspace limit names (`creditsUntil`, ruling 45 § 1). A 429 on a
   * credits session is the API's own rate limit and touches neither. Returns
   * `{ from, to }` when the next launch would get another billing than this
   * one ran on — a hand-over instead of a sleep — or null.
   */
  function recordRefusal({ name, launch, route }, { interrupted: kind, quota, quotaReset, creditsUntil }, billing) {
    if (launch.id !== 'claude-code' || !deps.billing?.patchState) return null;
    const nowMs = deps.now().getTime();
    try {
      if (quota && billing === 'plan') {
        const until = quotaReset instanceof Date && quotaReset.getTime() > nowMs ? quotaReset : new Date(nowMs + QUOTA_SLEEP_MS);
        deps.billing.patchState({ plan: { refused_until: until.toISOString() } });
      } else if ((kind === 'credits' || kind === 'key' || (quota && route)) && billing === 'credits') {
        const named = creditsUntil instanceof Date;
        const reset = named && creditsUntil.getTime() > nowMs ? creditsUntil
          : quota && quotaReset instanceof Date && quotaReset.getTime() > nowMs ? quotaReset
            : new Date(nowMs + (quota ? QUOTA_SLEEP_MS : CREDITS_RETRY_MS));
        const until = reset.toISOString();
        const why = kind === 'credits' ? (named ? 'workspace API usage limit reached' : 'credit balance too low') : kind === 'key' ? 'API key rejected' : 'API rate limit reached';
        deps.billing.patchState({ credits: { unusable_until: until, why } });
        say(`${name}: API reserve refused (${why}); recorded retry time ${until}`);
      } else {
        return null;
      }
    } catch (error) {
      say(`${name}: the refusal was not recorded (${error.message})`);
    }
    const next = billingRoute({ provider: launch.id === 'codex' ? 'codex' : 'claude', capacity: capacity.read(), state: deps.billing.readState?.(), api: deps.billing.readApi?.(), now: deps.now() });
    return next.billing === billing ? null : { from: billing, to: next.billing };
  }

  /** The plan's 5-hour and seven-day windows, as a claude stream last carried them: for status and subscription routing, and for the class router's snapshot (ruling 59). */
  function noteWindows({ name, launch }, stdout) {
    if (launch.id !== 'claude-code') return;
    if (deps.billing?.patchState) {
      const windows = planWindows(stdout);
      try {
        if (windows) deps.billing.patchState({ plan: { ...windows, seen: stamp() } });
      } catch (error) {
        say(`${name}: the plan's windows were not recorded (${error.message})`);
      }
    }
    observeCapacity((state) => observeClaudeStream(state, stdout, deps.now()));
  }

  /**
   * The goals a lane could start now, as `pickWork` candidates: those the
   * runner starts a session on (`goalSession`: `build · ready`, `review ·
   * ready`, `finish · ready`, and `merge · ready` after a red while its pull
   * request is out of the merger's line), on one of `repos` (its first repository),
   * held by nobody — a current file on this machine, or a claim while its lane
   * is on the way to writing one — and, for a review, with a model it may run
   * on (`reviewRoute`). A review that cannot run now is left out, so it does
   * not stand in front of every other goal; why is said once, when it changes.
   * A goal waits from its last log entry. A goal in a phase after the one its
   * programme is in is no candidate (`phaseOpen`): it keeps its stage and is
   * picked once every goal in a lower phase is done or dropped, the goals of
   * one phase side by side. A goal still written with `after` is given its
   * phase first (`convertAfter`).
   */
  function goalWork({ repos: names, passed }) {
    settleLanded();
    convertAfter();
    const held = new Set([...claims, ...passed, ...stepsHeld().map((item) => item.name)]);
    const may = (goal) => {
      if (goal.stage !== 'review' || goal.status === 'blocked') return true;
      const why = reviewRoute(goal).reason ?? null;
      const name = goalName(goal);
      if (why && reviewWaits.get(name) !== why) say(`${name}: its review waits — ${why}`);
      if (why) reviewWaits.set(name, why); else reviewWaits.delete(name);
      return !why;
    };
    const merge = inLine(deps.pendingMerges ? deps.pendingMerges(root) : []);
    const all = goals();
    return all
      .filter((goal) => goalSession(goal, merge) !== null
        && names.includes(goal.repos[0]) && !held.has(goalName(goal)) && phaseOpen(goal, all) && may(goal)
        && (goalSession(goal, merge) !== 'plan' || !programmePlanHeld(goal.programme)))
      .map((goal) => {
        const kind = goalSession(goal, merge);
        return { name: goalName(goal), repo: goal.repos[0], kind, variant: kind === 'plan' ? null : 'goal', since: goal.log.at(-1)?.at ?? '', resumed: false, goal };
      });
  }

  /**
   * The session a goal gets, by its stage (`goalSession`): `review` in
   * review, `plan` in finish or merge, else `build`. Only a candidate of
   * `goalWork` comes here, so the merger's line is not asked again.
   */
  function goalKind(goal) {
    if (goal.status === 'blocked' || goal.reason === 'next_step') return 'plan';
    if (goal.stage === 'review') return 'review';
    return goal.stage === 'finish' || goal.stage === 'merge' ? 'plan' : 'build';
  }

  /** One plan session at a time per programme, including a predecessor runner. */
  function programmePlanHeld(programme) {
    return claims.has(`plan:${programme}`) || stepsHeld().some((held) => held.programme === programme && held.kind === 'plan');
  }

  const planReceipt = (programme) => join(root, 'runner', 'programme-plan', `${programme}.json`);

  /** Completion is stable across archive moves; proposals and timers do not wake plan. */
  function programmeWork(names, passed) {
    const home = programsHome(deps.env);
    const all = goals();
    const out = [];
    for (const programme of deps.list(home)) {
      const own = all.filter((goal) => goal.programme === programme);
      if (own.some((goal) => goal.problems.length || goal.stage !== 'done')) continue;
      const archive = join(home, programme, 'goals', '.archive');
      const completed = [...own, ...deps.list(archive).map((name) => {
        const raw = deps.read(join(archive, name, GOAL_FILE));
        if (raw === null) return null;
        const parsed = parseGoal(raw);
        return { ...parsed, goal: name, log: parseLog(deps.read(join(archive, name, LOG_FILE)) ?? '') };
      }).filter((goal) => goal && goal.stage !== 'dropped')];
      if (!completed.length || completed.some((goal) => goal.problems?.length || goal.stage !== 'done')) continue;
      const name = `plan:${programme}`;
      if (passed.has(name) || programmePlanHeld(programme)) continue;
      const key = JSON.stringify(completed.map((goal) => [goal.goal, goal.created ?? null, stageSince(goal)]).sort(([a], [b]) => a.localeCompare(b)));
      let receipt;
      try { receipt = JSON.parse(deps.read(planReceipt(programme)) ?? 'null'); } catch { receipt = null; }
      if (receipt?.key === key) continue;
      const repo = completed.flatMap((goal) => goal.repos ?? []).find((repo) => names.includes(repo));
      if (!repo) continue;
      const goal = { programme, goal: null, dir: join(home, programme), reason: 'next_step', stage: null, status: 'ready', repos: [repo], class: 'large', log: [], completionKey: key };
      out.push({ name, repo, kind: 'plan', variant: null, since: '', resumed: false, goal });
    }
    return out;
  }

  /** Planning uses the available Opus/Sol medium candidate with most headroom. */
  function planRoute() {
    return { ...routeClass('large', { catalog: { large: HEADLESS_PLAN_CANDIDATES } }), class: 'plan' };
  }

  /**
   * One goal session, claimed for its length: `{ ran, name, goal }`, `{ stop }`,
   * or `{ ran: 0 }` when it did not start.
   */
  async function goalPass(goal, { lane, label }) {
    const name = goal.reason === 'next_step' ? `plan:${goal.programme}` : goalName(goal);
    const planning = goalKind(goal) === 'plan';
    claims.add(name);
    claimRepos.set(name, goal.repos[0]);
    if (planning) claims.add(`plan:${goal.programme}`);
    let outcome;
    try {
      outcome = await runGoal(goal, { lane });
    } finally {
      claims.delete(name);
      claimRepos.delete(name);
      if (planning) claims.delete(`plan:${goal.programme}`);
    }
    if (outcome === 'stop') return { ran: 0, stop: true };
    if (outcome !== 'ran') return { ran: 0 };
    const ran = { ran: 1, name, step: null, goal: true };
    if (stopRequested()) {
      say(`${label}: STOP — ${name} has ended, this lane takes nothing more; ${stillHeld()}`);
      return { ...ran, stop: true };
    }
    return ran;
  }

  /** The reason each goal's review last waited on, so it is said once. */
  const reviewWaits = new Map();
  // When `settleLanded` last asked GitHub, epoch ms.
  let lastSettle = -Infinity;

  /**
   * The route a goal's review runs on: the first review candidate (`mc model`)
   * that can run on its plan now, as `{ ok, route, settings }`, or `{ reason }`
   * when it may not run now. A candidate whose model is the goal's last build
   * entry's — the heading's `<tool> <model>` — is taken only when no other
   * candidate can run on its plan; a review never waits for want of another
   * model (`chooseReview`, model-choice.js).
   */
  function reviewRoute(goal) {
    const built = lastBuildEntry(goal.log);
    const route = routeClass(REVIEW_CLASS, { avoid: built?.model ? { tool: built.tool, model: built.model } : null });
    if (!route.ok) return { reason: route.reason };
    return { ok: true, route, settings: routedSettings(null, null, { kind: 'goal', candidate: route.candidate }) };
  }

  /**
   * The open pull request on a goal's branch, as `{ number, head }`, or
   * `{ error }` when GitHub cannot say, or null when there is none.
   */
  function goalPr(repo, branch) {
    const asked = deps.gh(repo.path, ['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number,headRefOid']);
    if (!asked.ok) return { error: lastLine(asked) || 'gh failed' };
    try {
      const [pr] = JSON.parse(asked.stdout || '[]');
      return pr ? { number: pr.number, head: pr.headRefOid } : null;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Goals written before phases, with `after`, given their phase by the depth
   * of that chain, and goals written before stages given theirs from their
   * status and log (`phaseGoals`, as `mc goal convert` does), each
   * with a runner entry. A pass with nothing to convert writes nothing.
   */
  function convertAfter() {
    const answers = phaseGoals({ home: programsHome(deps.env), list: deps.list, read: deps.read, write: deps.write, now: deps.now(), tool: 'runner' });
    for (const answer of answers) say(answer.problems ? `goal:${answer.name}: not converted — ${answer.problems.join('; ')}` : `goal:${answer.name}: phase ${answer.phase}, ${answer.stage} · ${answer.status}${answer.from ? ` (was ${answer.from})` : ''}`);
  }

  /**
   * Goals whose every pull request (`prs`) has landed,
   * set `done` — however each landed: the merger, `mc merge --docs`, `--admin`,
   * or on GitHub by hand. The merger sets done itself when the pull request it
   * lands is the goal's last; this pass is for the rest, and asks GitHub at
   * most every `SETTLE_EVERY_MS`, only for goals that are not finished and
   * carry pull requests. A pull request GitHub cannot say about
   * leaves the goal as it is.
   */
  function settleLanded() {
    const at = deps.now().getTime();
    if (at - lastSettle < SETTLE_EVERY_MS) return;
    lastSettle = at;
    for (const goal of goals()) {
      if (goal.problems.length || FINISHED.includes(goal.stage) || !goal.prs?.length) continue;
      const stateOf = ({ repo: repoName, pr }) => {
        const repo = repos.find((item) => item.name === repoName);
        if (!repo) return null;
        const asked = deps.gh(repo.path, ['pr', 'view', String(pr), '--json', 'state']);
        if (!asked.ok) return null;
        try { return JSON.parse(asked.stdout || 'null')?.state ?? null; } catch { return null; }
      };
      // Recover the execution of an existing merge decision, including a
      // process that stopped after saving the stage but before queueing all PRs.
      // Red jobs belong to a session and are never reset here.
      if (goal.stage === 'merge' && goal.status === 'ready' && !mergeAnswered(goal.log.at(-1))) {
        const pending = deps.pendingMerges ? deps.pendingMerges(root) : [];
        for (const item of goal.prs) {
          if (pending.some((job) => job.repo === item.repo && Number(job.pr) === Number(item.pr))) continue;
          if (goal.log.some((entry) => String(entry.done ?? '').startsWith(`${item.repo}#${item.pr} landed `))) continue;
          const repo = repos.find((entry) => entry.name === item.repo);
          try {
            deps.queueMerge({ root, repo: item.repo, repoPath: repo.path, pr: item.pr,
              holder: { name: `goal:${goalName(goal)}` },
              goal: { programme: goal.programme, goal: goal.goal, dir: goal.dir }, now: deps.now() });
          } catch (error) { say(`${goalName(goal)}: ${item.repo}#${item.pr} could not be queued (${error.message})`); }
        }
      }
      const settled = prsLanded(goal.prs, stateOf);
      if (!settled.done) continue;
      goalState(goal, goalName(goal), { stage: 'done' }, {
        done: `landed ${settled.landed.join(', ')}`,
        comment: settled.closed.length ? `closed without landing: ${settled.closed.join(', ')}` : null,
      });
    }
  }

  /** A runner entry with a stage or status change (`{ stage, status }`), said. */
  function goalState(goal, name, change, fields) {
    const entry = { at: logStamp(deps.now()), tool: 'runner', model: null, done: null, comment: null, next: null, ...fields };
    const set = setGoalState({ dir: goal.dir, ...change, entry, read: deps.read, write: deps.write });
    const words = [change.stage, change.status].filter(Boolean).join(' · ');
    say(set.problems ? `${name}: could not be set ${words} (${set.problems.join('; ')})` : `${name}: ${stageWords(set.goal)} — ${fields.done ?? fields.comment}`);
  }

  /** The goal as GOAL.json has it now, after a session: `{ stage, status }`, the record's when it does not parse. */
  function stateNow(goal) {
    const parsed = parseGoal(deps.read(join(goal.dir, GOAL_FILE)) ?? '');
    return parsed.problems ? { stage: goal.stage, status: goal.status } : { stage: parsed.stage, status: parsed.status };
  }

  /**
   * After a review session. The review decides (`canon/roles/review-session.md`):
   * its verb moved the goal to `merge`, all registered PRs sent to merge, or to
   * `finish`; the runner reads neither its words nor any file. A review that
   * ended with the goal still in `review` died (a crash, a limit): the goal
   * stays `review · ready` with the runner's entry, and the next review runs;
   * a second that dies in the same `review` sets `review · blocked`.
   */
  function afterReview(goal, name) {
    const now = stateNow(goal);
    if (now.stage !== 'review') { say(`${name}: the review moved it to ${now.stage}`); return; }
    if (now.status !== 'ready') return;
    const log = parseLog(deps.read(join(goal.dir, LOG_FILE)) ?? '');
    if (reviewDiedBefore(log)) {
      goalState(goal, name, { status: 'blocked' }, { comment: `${REVIEW_DIED_TEXT}, a second time — a blocked plan session takes it` });
      return;
    }
    goalState(goal, name, {}, { comment: `${REVIEW_DIED_TEXT} — a review runs again` });
  }

  /**
   * After a headless plan session on `finish` or on a red in `merge`. In
   * `finish` it publishes and moves the goal to `merge`, drops it, or sets
   * it blocked; one that ends with the goal still `finish · ready` sets it
   * `finish · blocked`, so no second one starts. In `merge` it takes the
   * red and queues the pull request again: one in the merger's line gets the
   * runner's entry (the red is taken, so it wakes no session again); one not
   * in line sets `merge · blocked`.
   */
  function afterPlan(goal, name, { stage, reason }) {
    const now = stateNow(goal);
    if (reason === 'blocked' && now.stage === stage && stage !== 'merge' && now.status === 'ready') {
      say(`${name}: plan resolved the blocker; retry ${stage}`);
      return;
    }
    if (reason === 'blocked' && now.stage === stage && now.status === 'blocked') {
      goalState(goal, name, { status: 'Martin' }, { comment: 'plan left the obstacle unresolved; Martin needs to inspect LOG.md and the session log' });
      return;
    }
    if (now.stage !== stage || now.status !== 'ready') { say(`${name}: plan left it ${now.stage} · ${now.status}`); return; }
    if (stage === 'finish') {
      goalState(goal, name, { status: 'blocked' }, { comment: 'the finish session ended with the goal still in finish — a blocked plan session takes it' });
      return;
    }
    const merge = inLine(deps.pendingMerges ? deps.pendingMerges(root) : []);
    const queued = (goal.prs ?? []).some((item) => merge.some((entry) => entry.repo === item.repo && Number(entry.pr) === Number(item.pr)));
    if (queued) goalState(goal, name, {}, { done: 'plan session took the red; the pull request is in the merger\'s line again' });
    else goalState(goal, name, { status: reason === 'blocked' ? 'Martin' : 'blocked' }, { comment: 'the plan session on the red ended with nothing in the merger\'s line — inspect its log before retrying' });
  }

  /**
   * Every repository's worktree of a goal is there, or the reason one is not.
   * Anyone may work in a goal's worktree, so one that has gone is made again
   * rather than refused.
   */
  function placeGoalWorktrees(goal, name) {
    for (const repoName of goal.repos) {
      const path = join(goal.dir, repoName);
      if (deps.exists(path) && deps.git(path, ['rev-parse', '--is-inside-work-tree']).ok) continue;
      const repo = repos.find((item) => item.name === repoName);
      if (!repo) return `${repoName} is not a repository this runner knows`;
      say(`${name}: ${path} is not a worktree — creating it on goal/${goal.goal}`);
      const added = addGoalWorktree({ git: deps.git, bare: repo.path, path, goal: goal.goal });
      if (!added.ok) return `${repoName}'s worktree could not be made (${String(added.stderr ?? '').trim() || 'git failed'})`;
    }
    return null;
  }

  /**
   * The runner's own log entry, for a build session that left none: stage
   * and status unchanged. Three of them in a row in `build` move the goal to
   * `finish · ready`, for a plan session to finish or let go — the guard
   * against a session that fails the same way for ever (the loop that ran
   * 2 803 times); there is no attempt counter, only the log.
   */
  function goalWithoutWord(goal, name, comment) {
    const { dir } = goal;
    const now = stateNow(goal);
    appendEntry({ dir, entry: { at: logStamp(deps.now()), tool: 'runner', model: null, ...now, done: null, comment, next: null }, read: deps.read, write: deps.write });
    say(`${name}: ${comment}`);
    const last = inStage(parseLog(deps.read(join(dir, LOG_FILE)) ?? ''), 'build').slice(-3);
    if (now.stage !== 'build' || now.status !== 'ready' || last.length < 3 || last.some((item) => item.tool !== 'runner')) return;
    goalState(goal, name, { stage: 'finish' }, { comment: 'three sessions ended without a word — see the logs under runner/log; a plan session finishes it' });
  }

  /**
   * One goal session: the lane and total caps, the class routing and the
   * billing, in the goal's worktree with the goal role. Returns 'ran', 'stop'
   * or a `skipped` word. A goal in `review` gets a review
   * session instead: the review role (`review-session:goal`), on the review model (`reviewRoute`),
   * with its pull request and head (MC_REVIEW_HEAD), and `mc goal stage
   * merge` executes its decision, with `afterReview` after it. A goal in `finish`, or in
   * `merge` after a red, gets a headless plan session and `afterPlan`.
   *
   * A session cut off by the API is not resumed: it ends, its goal is picked
   * again, and the next session reads `LOG.md` and the branch. The worktree
   * gets no checkpoint: anyone may work in it, so a session that dies leaves
   * its work where it was, in the tree. Nothing is merged, aborted or
   * committed here for the same reason.
   */
  async function runGoal(goal, { lane = 0 } = {}) {
    const programmeTurn = goal.reason === 'next_step';
    const reason = programmeTurn ? 'next_step' : goal.status === 'blocked' || goal.stage === 'merge' ? 'blocked' : 'finish';
    const name = programmeTurn ? `plan:${goal.programme}` : goalName(goal);
    const logPath = join(goal.dir, LOG_FILE);
    const [repoName] = goal.repos;
    const worktree = join(goal.dir, repoName);
    const kind = goalKind(goal);
    const review = kind === 'review';
    const planning = kind === 'plan';
    if (planning && reason === 'blocked') {
      const entries = inStage(parseLog(deps.read(logPath) ?? ''), goal.stage);
      const reset = entries.findLastIndex((entry) => entry.tool === 'person' && entry.status === 'ready');
      if (entries.slice(reset + 1).filter((entry) => entry.comment === 'starting blocked recovery').length >= 3) {
        goalState(goal, name, { status: 'Martin' }, { comment: 'three blocked recoveries in this stage did not keep it moving; inspect LOG.md before another retry' });
        return 'skipped:recovery-limit';
      }
    }
    const roleName = review ? REVIEW_ROLE : planning ? PLAN_ROLE : BUILD_ROLES.goal;
    const role = deps.role(roleName);
    if (!role?.overlay) { say(`${name}: ${roleFileText(roleName)} is missing on this machine, skip`); return 'skipped:role-missing'; }
    const routed = review ? reviewRoute(goal) : { route: planning ? planRoute() : routeClass(goal.class) };
    if (review && !routed.ok) { say(`${name}: its review waits — ${routed.reason}`); return 'skipped:no-capacity'; }
    const { route } = routed;
    if (!route.ok) { say(`${name}: ${route.reason} — skip`); return 'skipped:no-capacity'; }
    const settings = routed.settings ?? routedSettings(null, null, { kind: 'goal', candidate: route.candidate });
    const launch = deps.launch(settings.tool);
    if (!launch?.ok) { say(`${name}: ${settings.tool} is not available on this machine (${launch?.hint || launch?.reason}), skip`); return 'skipped:tool-missing'; }
    // A plan session stands in the programme's directory, beside the goal; it
    // may go into the goal's worktree and finish it (`canon/roles/plan-session.md`).
    const cwd = programmeTurn ? goal.dir : planning ? dirname(dirname(goal.dir)) : worktree;
    const lost = planning ? null : placeGoalWorktrees(goal, name);
    if (lost) { goalWithoutWord(goal, name, `no session started: ${lost}`); return 'skipped:worktree'; }
    // A goal's branch is made when it can start: one made at `mc goal new` in a
    // later phase is remade from origin/main before its first build, if unbuilt.
    if (kind === 'build' && !lastBuildEntry(goal.log)) {
      remakeUnbuiltBranches({ git: deps.git, dir: goal.dir, goal: goal.goal, repos: goal.repos, say: (repo, text) => say(`${name}: ${repo} ${text}`) });
    }
    const branch = programmeTurn ? null : goalBranch({ git: deps.git, dir: goal.dir, goal: goal.goal, repo: repoName });
    const repo = repos.find((item) => item.name === repoName);
    let pr = null;
    if (review) {
      pr = repo ? goalPr(repo, branch) : { error: `${repoName} is not a repository this runner knows` };
      if (pr?.error) { say(`${name}: its pull request could not be read (${pr.error}) — skip`); return 'skipped:github'; }
      if (!pr) {
        goalState(goal, name, { stage: 'finish' }, { comment: `in review, but ${branch} has no open pull request — a plan session finishes it` });
        return 'skipped:no-pr';
      }
    }
    const attached = planning ? { ok: true } : await deps.attachDeps(worktree);
    if (!attached.ok) say(`${name}: dependencies could not be attached — ${attached.why}`);
    const slot = await waitForSlot(name, { repo: repoName, lane });
    if (slot === 'stop') { say(`STOP file present (${paths.stop}) — not starting ${name}`); return 'stop'; }
    if (slot !== 'ok') { say(`${name}: UPDATE while waiting for a lane — starting no session, skip`); return 'skipped:update'; }
    const picked = await billingFor(launch, route);
    if (picked.billing === 'unavailable') {
      dropSlot();
      say(`${name}: Anthropic credits unavailable (${picked.why}) — skip`);
      return 'skipped:no-capacity';
    }

    // The brief is the goal as `mc goal show` renders it; a record from a test without one has none.
    const brief = goal.title ? renderGoalText(goalOfRecord(goal)) : null;
    const prompt = programmeTurn
      ? `You are the headless plan session for programme ${goal.programme} (reason: next_step). All its goals are done. Read ${cwd}/README.md, its proposals/ and proposals/archive/, and the completed goals. Decide the next step toward the programme aim, or explicitly decide to do nothing now. Create ready goals only for justified work. Archive handled or irrelevant proposals with their outcome and reason. Record your decision in ${cwd}/PLAN.md. Other programme wakeups belong to mc manager. No goal is assigned to this session.`
      : review
      ? goalReviewPrompt({ name: `${goal.programme}/${goal.goal}`, dir: goal.dir, worktree, branch, pr: pr.number, head: pr.head, brief })
      : planning
      ? goalPlanPrompt({ name: `${goal.programme}/${goal.goal}`, dir: goal.dir, worktree, branch, stage: goal.stage, reason, why: goal.log.at(-1), brief })
      : goalPrompt({ name: `${goal.programme}/${goal.goal}`, dir: goal.dir, worktree, branch, brief });
    const instructions = instructionsFor(launch.id, role.overlay);
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: settings.model, effort: settings.effort, advisor: settings.advisor, instructions, prompt, profileArgs, cache: role.cache });
    const ts = stamp().replace(/[-:]/gu, '');
    // A goal's name holds a `/`, which a file stem may not.
    const stem = programmeTurn ? `plan-${goal.programme}-next-step-${ts}` : `goal-${goal.programme}-${goal.goal}-${ts}`;
    const out = join(paths.log, stem);
    const entriesBefore = parseLog(deps.read(logPath) ?? '').filter((entry) => entry.tool !== 'runner').length;
    say(`${name}: ${kind} starting (${describeSettings(launch.shortName, settings)}, ${describeWatch(launch.id, settings)})${picked.billing === 'credits' ? ` · on credits (${picked.why})` : ''} · ${planning ? 'plan' : `class ${goal.class}`}: ${route.basis} (${route.why})`);
    const t0 = deps.now().getTime();
    // There exactly as long as the session is, so in flight and slot are one
    // fact, and the eligibility of this goal is that same fact.
    const currentPath = paths.currentFor(repoName, lane);
    const current = {
      name, ...(planning ? { reason } : {}), step: null, kind, variant: planning ? null : 'goal', programme: goal.programme, repo: repoName, lane, tool: settings.tool, model: settings.model,
      effort: settings.effort, advisor: settings.advisor, class: goal.class, billing: picked.billing,
      check_in_minutes: launch.id === 'codex' ? null : settings.checkInMinutes, check_ins: 0,
      started: stamp(), pid, worktree: cwd,
      role: roleRecord({ name: role.name || roleName, source: roleSourceOf(role) || 'canon', overlay: role.overlay, instructions }),
    };
    writeJson(currentPath, current);
    const scratch = join(paths.scratch, stem);
    let scratchEnv = {};
    try {
      deps.mkdir(scratch);
      scratchEnv = { MC_SCRATCH: scratch };
    } catch (error) {
      say(`${name}: no scratch directory (${scratch}): ${error.message} — starting without MC_SCRATCH`);
    }
    let result;
    try {
      if (planning && reason === 'blocked') goalState(goal, name, {}, { comment: 'starting blocked recovery' });
      if (programmeTurn) writeJson(planReceipt(goal.programme), { key: goal.completionKey, at: stamp(), outcome: 'started' });
      const tool = gatewayLaunch({ provider: launch.id === 'codex' ? 'codex' : 'claude', model: settings.model, bin: launch.spec.bin, args, billing: picked.billing });
      result = await deps.session({
        bin: tool.bin,
        args: tool.args,
        cwd,
        logPath: `${out}.jsonl`,
        ...watchFor(launch, settings, {
          prompt, name, checkInText: planning ? goalPlanCheckInPrompt : goalCheckInPrompt,
          onCheckIn: (count) => writeJson(currentPath, { ...current, check_ins: count }),
        }),
        env: {
          // Nobody watches: the hook refuses Martin's acts (HEADLESS_RULES).
          MC_HEADLESS: '1',
          MC_ROLE: roleName, MC_PROGRAMME: goal.programme, ...(planning ? { MC_PLAN_REASON: reason } : {}),
          // A plan session is in no worktree: neither MC_REPO nor MC_WORKAREA.
          ...(programmeTurn ? {} : { MC_GOAL: `${goal.programme}/${goal.goal}` }), ...(planning ? {} : { MC_REPO: repoName, MC_WORKAREA: worktree }), MC_TOOL: settings.tool,
          // The review uses this head as context; the Stop hook reads when it began.
          ...(review ? { MC_REVIEW_HEAD: pr.head, MC_REVIEW_PR: String(pr.number), MC_SESSION_STARTED: new Date(t0).toISOString() } : {}),
          ...(settings.model ? { MC_MODEL: settings.model } : {}),
          ...scratchEnv,
        },
        unsetEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY', 'OPENAI_API_KEY', 'MC_CODEX_API_KEY'],
      });
    } finally {
      remove(currentPath);
      dropSlot();
    }
    const seconds = Math.round((deps.now().getTime() - t0) / 1000);
    writeSessionLogs(out, result);
    noteWindows({ name, launch }, result.stdout);
    const read = readSessionOutput({ toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut, stalled: result.stalled, now: deps.now() });
    recordRefusal({ name, launch, route }, read, picked.billing);
    const provider = launch.id === 'codex' ? 'codex' : 'claude';
    if ((read.quota || (provider === 'claude' && read.interrupted === 'login')) && picked.billing === 'plan') refuseProvider(provider, read.quotaReset);
    const spoke = parseLog(deps.read(logPath) ?? '').filter((entry) => entry.tool !== 'runner').length > entriesBefore;
    if (programmeTurn) writeJson(planReceipt(goal.programme), { key: goal.completionKey, at: stamp(), outcome: read.note });
    else if (planning && !read.quota && !read.interrupted) afterPlan(goal, name, { stage: goal.stage, reason });
    else if (review) afterReview(goal, name);
    else if (!spoke) goalWithoutWord(goal, name, `session ended without a log entry (exit ${result.status}, ${seconds} s)`);
    const note = programmeTurn || spoke ? read.note : `${read.note},no-log`;
    logRun({ ts: stamp(), name, kind: runsKind({ kind, variant: planning ? null : 'goal' }), exit: result.status, seconds, pr: '-', turns: read.turns, input: read.input, output: read.output, cacheRead: read.cacheRead, cacheWrite: read.cacheWrite, session: read.session, note, landSeconds: null, model: settings.model, cls: planning ? '-' : goal.class, tool: settings.tool, effort: settings.effort, billing: picked.billing });
    say(`${name}: ${kind} done rc=${result.status} ${seconds}s turns=${read.turns} note=${note}`);
    return 'ran';
  }


  /** `github.json`: the repositories whose last ask failed, by name. Absent is none. */
  function readGithub() {
    try {
      const state = JSON.parse(deps.read(paths.github) || '{}');
      return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    } catch { return {}; }
  }

  function writeGithub(state) {
    if (Object.keys(state).length) writeJson(paths.github, state);
    else remove(paths.github);
  }

  /**
   * The merger's side of the world, read with it (ruling 30). A queue with
   * jobs and no merger alive is a merger that was killed — the machine slept,
   * somebody ended it — and one is started here, so a queued pull request
   * never waits on somebody typing `mc merge` again.
   */
  function wakeMerger() {
    const pending = inLine(deps.pendingMerges ? deps.pendingMerges(root) : []);
    const mayGo = pending.length && nextJob(pending, { now: deps.now().getTime() });
    if (!mayGo || !deps.startMerger || readMerger({ root, alive })) return;
    const started = deps.startMerger({ root });
    say(`merger: ${pending.length} pull request${pending.length === 1 ? '' : 's'} queued and no merger running — ${started.pid ? `started pid ${started.pid}` : `could not start one (${started.error || 'no pid'})`}`);
  }

  /**
   * Every repository fetched and asked what is open, once: one `gh pr list`
   * per repository, where the network is already being paid for by the fetch
   * beside it. What GitHub says goes to the page's cache (`mergePrs`); a
   * repository GitHub could not be asked for is named in `prsFailed` and
   * backed off (github-backoff.js). `only` narrows it to one repository —
   * what a lane re-reads, so two lanes never fetch the same repository at the
   * same moment. Returns `{ prs, prsFailed }`.
   */
  function askGithub({ only = null } = {}) {
    wakeMerger();
    const prs = [];
    const prsFailed = [];
    const github = readGithub();
    const answered = [];
    for (const repo of repos) {
      if (only && repo.name !== only) continue;
      if (!deps.exists(gitDirOf(repo))) continue;
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      // A repository whose last ask failed is not asked again until its
      // backoff has run out (github-backoff.js): every ask at a locked keychain
      // left a modal and a process behind (2026-09-20).
      const held = github[repo.name];
      if (held && !mayAsk(held, deps.now())) {
        prsFailed.push(repo.name);
        say(`${repo.name}: GitHub not asked — ${held.attempts} failure(s) since ${held.since}, next ask at ${nextAskAt(held)}`);
        continue;
      }
      const asked = deps.gh(repo.path, PR_LIST_ARGS);
      try {
        if (!asked.ok) throw new Error(asked.stderr.trim().split('\n').at(-1) || 'gh pr list failed');
        prs.push(...JSON.parse(asked.stdout || '[]').map((pr) => ({ repo: repo.name, ...pr })));
        answered.push(repo.name);
        if (held) {
          delete github[repo.name];
          writeGithub(github);
          say(`${repo.name}: GitHub answers again after ${held.attempts} failure(s) since ${held.since}`);
        }
      } catch (error) {
        prsFailed.push(repo.name);
        const diagnosis = deps.diagnoseGithub ? deps.diagnoseGithub() : null;
        github[repo.name] = failedAsk(held, { at: stamp(), error: error?.message || error, diagnosis });
        writeGithub(github);
        const cause = GITHUB_CAUSES[diagnosis?.cause];
        say(`${repo.name}: GitHub could not be asked what is open (${error?.message || error})${cause ? ` — ${cause.label}, run: ${cause.fix}` : ''} — next ask at ${github[repo.name].next_ask}`);
      }
    }
    // What GitHub just said is what the page draws, rather than whatever the
    // last `mc --fresh` heard (page-cache.js `mergePrs`). A cache that cannot
    // be written costs the page its freshness and the pass nothing.
    try {
      mergePrs({
        root,
        repos: answered,
        prs: prs.filter((pr) => answered.includes(pr.repo)),
        now: deps.now(),
        read: (path) => deps.read(path),
        write: writeJson,
      });
    } catch { /* the page says how old its cache is */ }
    return { prs, prsFailed };
  }

  /**
   * What a free lane takes next, on every repository (`pickWork`,
   * lane-pick.js): the goals `goalWork` says could start, each with its kind
   * and how long it has waited, against the repositories of the sessions
   * already in flight. Goals are the only work there is (2026-11-03).
   *
   * What this adds to the rule is what only the running process knows: what
   * the lanes are holding, and what this pass has already been refused on —
   * a name (`passed`), or a whole repository whose refusal was about the
   * moment (`waited`).
   */
  function nextWork({ repo = null, passed = new Set(), waited = new Map(), carry = null } = {}) {
    const others = stepsHeld().filter((held) => held.other);
    const names = (repo ? [repo] : repos.map((item) => item.name)).filter((name) => !waited.has(name));
    const items = [...goalWork({ repos: names, passed }), ...programmeWork(names, passed)];
    const held = [...claimRepos.values(), ...others.map((item) => item.repo)].filter(Boolean);
    const priorities = new Map();
    for (const item of items) {
      const programme = item.goal.programme;
      if (!priorities.has(programme)) priorities.set(programme, readProgrammePriority(programme, { home: programsHome(deps.env), read: deps.read }));
      item.priority = priorities.get(programme);
    }
    return pickWork({ items, held, lanes: capNow(), carry });
  }

  /**
   * The sessions in flight on this machine, one per `current-*.json`: its
   * `name`, the `pid` of the runner holding it, and `other` when that is a
   * live runner that is not this one — the runner a handover replaced,
   * finishing what it held. A file naming a dead pid is nobody's: it is moved
   * to `runner/log/` and said, not returned — a lane killed with its runner
   * never reaches the `finally` that removes its file (`runGoal`).
   */
  function stepsHeld() {
    return paths.currents().flatMap((path) => {
      let held = null;
      try { held = JSON.parse(deps.read(path) ?? ''); } catch { held = null; }
      const owner = Number(held?.pid);
      const known = Number.isInteger(owner) && owner > 0;
      const foreign = known && owner !== pid;
      if (foreign && !alive(owner)) {
        const to = join(paths.log, `dead-${basename(path, '.json')}-${owner}.json`);
        if (!deps.move?.(path, to)) remove(path);
        say(`lane file ${basename(path)} names pid ${owner}, which is gone — ${held?.name || 'nothing named'}; moved to log/${basename(to)}`);
        return [];
      }
      const lane = Number.isInteger(held?.lane) && held.lane > 0 ? held.lane : 0;
      return [{ path, programme: held?.programme, kind: held?.kind, name: held?.name || null, repo: held?.repo || null, lane, pid: known ? owner : null, other: foreign }];
    });
  }

  /**
   * What this runner still has in flight, for the lines a stopping lane
   * writes: until 2026-10-10 each lane that finished its last session wrote
   * `runner exit on STOP`, five times in seven minutes, while the runner went
   * on with a session for another hour.
   */
  function stillHeld() {
    const own = stepsHeld().filter((held) => held.pid === pid).map((held) => held.name || 'a session');
    return own.length ? `the runner still finishes ${own.join(', ')}` : 'nothing else is in flight';
  }

  /**
   * The other runner holding a session in this lane, or null when nothing
   * does. A lane is a number, not a repository: its file is named for the
   * repository of the session in it (`paths.currentFor`), so a successor's lane
   * waits while its predecessor holds any session under the same number. A
   * file from before the total names a lane within its repository, and is
   * read the same way.
   */
  function laneHolder(lane) {
    return stepsHeld().find((held) => held.other && held.lane === lane) || null;
  }

  /**
   * One pass of one lane: the first goal nothing stops, run — and the answer,
   * so the lane knows whether to pick again at once or to wait.
   *
   * Returns `{ ran, stop, waited, name, goal }`. `ran` is 0 or 1: a pass ends
   * when a session has run, because the goals it was picked from have moved
   * on, and the next pick must be made against them as they are now. `waited`
   * is a refusal about the machine (disk, memory) — the lane sleeps and asks
   * again. A goal that did not start is passed over for the rest of this pass
   * and the lane takes the next one, so one stuck goal does not stand in front
   * of the rest.
   *
   * `last` is the `{ name }` this lane ran a moment ago, which the picker
   * weighs (`pickWork`'s `carry`). `passed` seeds the names this pass already
   * has an answer for — which is how a test drives a lane without a clock.
   */
  async function pass({
    repo = null, lane = 0, tag = null, last = null, passed: already = [],
  } = {}) {
    const label = tag || repo || 'run';
    const passed = new Set(already);
    if (!diskRoom()) {
      diskSkippedAt = deps.now().getTime();
      return { ran: 0, waited: 'skipped:disk' };
    }
    if (!memoryRoom()) return { ran: 0, waited: 'skipped:memory' };
    for (;;) {
      if (stopRequested()) return { ran: 0, stop: true };
      // A runner that has handed over finishes the pass it is in and picks
      // nothing more (`runLoop`).
      if (updateRequested()) return { ran: 0 };
      const pick = nextWork({ repo, passed, carry: last?.name });
      if (!pick) return { ran: 0 };
      // A goal's build or review, or the plan session a blocked goal wakes: the only work a lane takes.
      say(`${label}: next — ${pick.name} (${pick.variant ? `${pick.kind} ${pick.variant}` : pick.kind})`);
      const ran = await goalPass(pick.goal, { lane, label });
      if (ran.ran || ran.stop) return ran;
      passed.add(pick.name);
    }
  }

  /**
   * Whether the volume where `MC_SCRATCH` is made has room for a session to
   * start. Read once per pass, before anything is picked: under
   * `DISK_MIN_BYTES` the line is said and written to `disk.json` for the
   * page, and the pass starts nothing. Check-ins and landings of sessions
   * already running are not in a pass, so they go on. No reader, or a volume
   * that cannot be read, is room: a guess must not stop the runner.
   */
  function diskRoom() {
    let free = null;
    try { free = deps.freeBytes ? deps.freeBytes(paths.scratch) : null; } catch { free = null; }
    if (free == null || free >= DISK_MIN_BYTES) {
      if (deps.exists(paths.disk)) remove(paths.disk);
      return true;
    }
    // Rounded down, so a disk just under the line never reads as at it.
    const line = `disk: ${(Math.floor((free / 2 ** 30) * 10) / 10).toFixed(1)} GiB free, below ${DISK_MIN_BYTES / 2 ** 30} GiB — no session started`;
    say(line);
    writeJson(paths.disk, { at: stamp(), free_bytes: free, line });
    return false;
  }

  /**
   * Whether enough memory is free for a session to start, read once per pass
   * after `diskRoom`: under `MEMORY_MIN_FREE_PERCENT` the line is said and
   * written to `memory.json` for the page, and the pass starts nothing. No
   * reader, or no reading, is room.
   */
  function memoryRoom() {
    let free = null;
    try { free = deps.freeMemoryPercent ? deps.freeMemoryPercent() : null; } catch { free = null; }
    if (!Number.isFinite(free) || free >= MEMORY_MIN_FREE_PERCENT) {
      if (deps.exists(paths.memory)) remove(paths.memory);
      return true;
    }
    const line = `memory: ${free}% free, below ${MEMORY_MIN_FREE_PERCENT}% — no session started`;
    say(line);
    writeJson(paths.memory, { at: stamp(), free_percent: free, line });
    return false;
  }

  /**
   * What the runner does around its lanes, in its own loop: the day's
   * collect, the inbox drained, every repository fetched and asked what is
   * open, finished goals archived, the machine swept, and the daily jobs.
   */
  async function chores() {
    if (stopRequested()) return;
    // runner.log to runner.log.1 past RUNNER_LOG_MAX_BYTES, before this pass says anything.
    try { deps.rotate?.(paths.runnerLog, RUNNER_LOG_MAX_BYTES); } catch { /* the log goes on growing */ }
    dropPredecessor();
    await runHelperDay();
    await runIntakeDrain();
    askGithub();
    // `askGithub()` has just fetched every repository, mc's own checkout among
    // them, so origin/main is as fresh as it gets without another fetch.
    noticeNewCode();
    // A goal finished for 24 hours is archived (`goal-archive.js`); a programme never is.
    archiveGoalsDue();
    await reapOrphans();
    await sweepDockerChore();
    sweepScratch();
    await refreshCodexDue();
    await runTidyDaily();
    // Last: the nightly is the long one, and nothing above should wait twenty
    // minutes behind it. The deps reading goes first: a minute a repository,
    // and not to be left a day behind by a tick that a STOP ends.
    await runDepsDaily();
    await runNightly();
  }

  /**
   * The dev processes nobody owns any more (`dev-reap.js`). A reaper failure
   * never stops a round: it is said and the pass goes on. Only when a deps
   * object carries one — a test fixture without it reaps nothing on the
   * machine running the suite.
   */
  async function reapOrphans() {
    if (!deps.reapDevServers) return;
    try {
      const reaped = (await deps.reapDevServers() || []).filter((entry) => entry.done === 'reaped');
      if (reaped.length) say(`reap: ${reaped.length} orphaned dev process(es) removed`);
    } catch (error) {
      say(`reap: failed — ${error?.message || error}`);
    }
  }

  /**
   * The container runtime's sweep (`sweepDocker`, `docker.js`): dead leases,
   * labelled leftovers, and the idle stop of an OrbStack mc started. A sweep
   * failure never stops a pass: it is said and the pass goes on. Only when a
   * deps object carries one — a test fixture without `dockerSweep` touches no
   * Docker on the machine running the suite.
   */
  async function sweepDockerChore() {
    if (!deps.dockerSweep) return;
    try {
      const outcome = await deps.dockerSweep();
      if (outcome?.line) say(outcome.line);
    } catch (error) {
      say(`docker: sweep failed — ${error?.message || error}`);
    }
  }

  /**
   * The scratch directories no session is likely to want any more: every
   * directory directly under `~/mc/runner/scratch/` not touched for two days.
   * Nothing outside that directory is looked at, and a name that is not a
   * directory is left.
   */
  function sweepScratch() {
    const cutoff = deps.now().getTime() - SCRATCH_KEEP_MS;
    let removed = 0;
    for (const dir of deps.scratchDirs(paths.scratch)) {
      if (dir.mtimeMs < cutoff && deps.rmTree(join(paths.scratch, dir.name))) removed += 1;
    }
    if (removed) say(`scratch: ${removed} director${removed === 1 ? 'y' : 'ies'} older than two days removed`);
  }

  /**
   * runner.json — a runner is here, and this is the pid to test for life.
   *
   * And the commit it started on, when mc runs from a checkout: a runner
   * executes the code it was spawned with, not what the checkout holds now, so
   * the page can only say *an update is available* if the runner said what it
   * is (the page's MC line). Absent from an install with no checkout.
   */
  //
  // A successor names its `predecessor` — the runner it took over from, which
  // is still finishing what it held — until that pid is gone
  // (`dropPredecessor`), so `mc run stop` and the page find both.
  let marked = null;
  // `args` are the flags it runs with, for a take-over that keeps them
  // (`mc run --update` on a stopping runner); `takeover` says this runner
  // stands down when runner.json names another (`replaced`), which is what
  // makes taking over from it safe (run-control.js `takeOver`).
  const markRunner = ({ predecessor = null, args = [] } = {}) => {
    const dir = mcCheckout({ exists: deps.exists });
    const commit = dir ? gitOut(dir, ['rev-parse', '--short', 'HEAD']) : null;
    marked = {
      pid, started: stamp(), ...(commit ? { commit } : {}), args, takeover: true, ...(predecessor ? { predecessor } : {}),
    };
    writeJson(paths.runner, marked);
  };
  const dropPredecessor = () => {
    const before = marked?.predecessor;
    if (!before || alive(before.pid)) return;
    const { predecessor: _gone, ...rest } = marked;
    marked = rest;
    writeJson(paths.runner, marked);
    say(`pid ${before.pid}, the runner this one took over from, has finished what it held and exited`);
  };
  /**
   * New code on origin/main of mc's own checkout is an UPDATE this runner
   * writes itself (Martin, 2026-10-18): landing a pull request is enough, and
   * the handover that follows is the ordinary one (ruling 28). Only on a
   * checkout that is clean and fast-forwards — a handover there would start
   * the successor on the old code — and one line per origin/main sha.
   */
  function noticeNewCode() {
    const dir = mcCheckout({ exists: deps.exists });
    if (!dir || !marked?.commit || updateRequested()) return;
    const main = gitOut(dir, ['rev-parse', '--short', 'origin/main']);
    if (!main || sameCommit(main, marked.commit) || codeNoticed.has(main)) return;
    codeNoticed.add(main);
    const dirty = gitOut(dir, ['status', '--porcelain']);
    const ff = deps.git(dir, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).ok;
    if (dirty || !ff) {
      say(`update: origin/main is ${main} and this runner is on ${marked.commit}, but ${dir} ${dirty ? 'has uncommitted changes' : 'has diverged from origin/main'} — not handing over; mc run --update once it is clean`);
      return;
    }
    deps.write(paths.update, `${stamp()}\n`);
    say(`update: origin/main is ${main} and this runner is on ${marked.commit} — UPDATE written by the runner; it hands over at its next look`);
  }
  // A lane file another live runner holds is not a leftover: it is the
  // runner a handover replaced, still in that session.
  //
  // runner.json only when it is this runner's, or names nobody alive: a runner
  // that was taken over leaves the file to the one that took over, which
  // until 2026-10-10 nothing could do while this one still ran.
  const clearRunner = () => {
    if (!replaced()) remove(paths.runner);
    for (const held of stepsHeld()) if (!held.other) remove(held.path);
  };

  return {
    paths, repos, say, pass, nextWork, claims, chores, runHelperDay, runIntakeDrain, runDepsDaily, runTidyDaily, runNightly, askGithub, stopRequested,
    updateRequested, holdUpdate, replaced, stillHeld, stepsHeld, laneHolder, pid, markRunner, dropPredecessor, clearRunner,
  };
}

/**
 * The loop: `mc run lanes` lane loops, each taking the next work of any kind
 * on any repository (`nextWork`) until a STOP file appears or an UPDATE hands
 * over — or, under `--once`, one session and out.
 */
export async function runLoop({
  once = false, merge = true, idleSleepMs = 600_000,
  // The flags this run was started with, as typed, kept in runner.json so a
  // take-over can start its replacement with the same ones.
  args = [],
  // The machine's sleep, held for the length of the run. On by default,
  // because a runner that stops because the laptop dozed is the failure this
  // exists for and nobody would think to ask for the flag beforehand.
  awake = true,
  deps = realDeps(),
} = {}) {
  // The total is read live; this reading is only for the start line. It is
  // read by `reconcile` on every poll slice, which starts the lanes that are
  // missing, by each lane at the top of a pass, which ends a lane above it,
  // and by `takeSlot` each time a session is about to start.
  const laneSetting = laneTotal(deps) || DEFAULT_LANES;
  const runner = createRunner({ merge, deps });
  // runner.json read before it is written. `markRunner()` below is a
  // statement, not a claim anyone checked, so until now a second `mc run` in
  // the same work root simply overwrote the first and became invisible to
  // every reader of mc's state — measured 2026-09-02, when two runners handed
  // the same work to two sessions in one worktree 100 seconds apart. `mc run
  // start` has always refused on exactly this; the same `readRunner` answers
  // here, so the two cannot disagree about who is running.
  //
  // `--once` is refused too. It is a person watching one session rather than
  // an unattended loop, but the collision is the same one: one session, one
  // worktree, one `git add -A`, and a second session that can only stand
  // down. There is nothing about being watched that makes that safe.
  const isAlive = deps.alive || pidAlive;
  let held = readRunner({ paths: runner.paths, read: deps.read, alive: isAlive });
  // runner.json already naming this process is the start that spawned it
  // (run-control.js `spawnRunner`, or `handOver`), which writes the file the
  // moment the pid exists so nobody sees no runner in the second this one
  // takes to load. What it names as the predecessor is the runner this one is
  // taking over from.
  const ours = held?.pid === runner.pid;
  const named = ours && held.predecessor?.alive ? held.predecessor : null;
  if (ours) held = named ? { ...named, alive: true } : null;
  // The one live holder that is no refusal: the runner that has just handed
  // over to this one, which says so in the environment it spawned this
  // process with (`handOver`, `takeOver`). It keeps finishing the sessions it
  // holds; this one starts at once beside it (ruling 28).
  const successorOf = Number(deps.env?.MC_RUN_SUCCESSOR_OF);
  const replacing = held?.alive && Number.isInteger(successorOf) && successorOf === held.pid ? held : null;
  // STOP at start. A successor finding one was stopped during its own
  // handover, and obeys it. Anybody else finds the one the last stop left,
  // and removes it — the way `mc run start` always has, so a foreground
  // `mc run` and a background one are the same switch. Read straight from the
  // disk: `stopRequested` is sticky, and a STOP read here must not outlive
  // its removal.
  if (deps.exists(runner.paths.stop)) {
    if (Number.isInteger(successorOf) && successorOf > 0) {
      runner.say(`STOP file present (${runner.paths.stop}) — a stop came during the handover; this runner does not start`);
      if (ours) deps.remove(runner.paths.runner);
      return 2;
    }
    if (!held?.alive) {
      deps.remove(runner.paths.stop);
      runner.say('removed the STOP the last stop left');
    }
  }
  if (held?.alive && !replacing) {
    const stopping = deps.exists(runner.paths.stop);
    runner.say(`a runner is already ${stopping ? 'stopping' : 'running'} — pid ${held.pid}${held.started ? `, started ${held.started}` : ''}`);
    runner.say(stopping
      ? 'mc run start takes over from it at once · or wait for it to exit'
      : 'mc run stop ends it · mc run --update restarts it on the newest code');
    return 2;
  }
  // A file naming a pid that is gone is a killed runner's leftovers, not a
  // reason nothing can start: it is cleared and said, the way `mc run start`
  // clears it. `clearRunner()` takes the `current-<repo>.json` files with it,
  // which are the same runner's other leftovers and would otherwise draw a
  // session that has not been running for hours.
  if (held && !replacing && !ours) {
    runner.clearRunner();
    runner.say(`cleared runner.json — the pid it named (${held.pid}) is gone`);
  }
  runner.say(`runner start (mc run, merge=${merge ? 1 : 0} once=${once ? 1 : 0})`);
  if (replacing) runner.say(`update: taking over from pid ${replacing.pid} — it finishes the sessions it holds, this runner starts every lane it does not`);
  // Before the first round, so a run that is going to be unattended is already
  // holding the assertion by the time anybody walks away from it. `--once` is
  // a person watching one session and does not need it.
  //
  // Nothing releases this: `caffeinate -w <pid>` watches this process and
  // exits when it does, including when it is killed with a signal no handler
  // can see. A `finally` here would be a worse version of that, and would not
  // run in exactly the case that matters.
  if (awake && !once) {
    const held = (deps.keepAwake || keepAwake)({ pid: process.pid, onAC: (deps.onACPower || onACPower)() });
    runner.say(held.ok
      ? `staying awake (caffeinate ${held.flags.join(' ')} pid ${held.pid}) — ${held.note}`
      : `NOT staying awake (${held.reason}) — this machine may sleep mid-run: ${held.note}`);
  }
  runner.markRunner({ args, ...(replacing ? { predecessor: { pid: replacing.pid, started: replacing.started || null } } : {}) });
  // A handover is the one exit that must not clear runner.json: the runner it
  // handed to has already written its own, and removing it on the way out
  // would leave the page saying nothing is running while something is.
  let handedOver = false;
  // When the handover happened, for the ten-minute line that follows it.
  let drainMark = null;
  // The sessions this runner holds: its own lane files, not its successor's.
  const ownInFlight = () => runner.stepsHeld().filter((held) => held.pid === runner.pid);
  // `mc run --update`, once per runner however many lanes read it: the first
  // loop to see UPDATE starts the handover and every other one awaits the
  // same answer. From that moment the UPDATE is held (`holdUpdate`), so no
  // loop of this runner takes a session again even though `handOver` has removed
  // the file. A handover that could not start its successor (`handOver`'s
  // `{ ok: false }`) releases it: the UPDATE is taken away, it is said, and
  // the lanes go on with the code this runner holds.
  let handing = null;
  const update = () => handing || (handing = (async () => {
    runner.holdUpdate(true);
    // Taken over from outside: the handover is already done, by whoever
    // started the runner runner.json now names. Nothing to spawn.
    const by = runner.replaced();
    if (by) {
      handedOver = true;
      drainMark = deps.now().getTime();
      runner.say(`taken over by pid ${by.pid} — finishing ${ownInFlight().length} session(s) in flight, taking nothing new`);
      return true;
    }
    const handed = await (deps.handOver || handOver)({
      paths: runner.paths, deps, say: runner.say, predecessor: runner.pid, finishing: ownInFlight().length,
    });
    if (handed.ok) { handedOver = true; drainMark = deps.now().getTime(); return true; }
    runner.holdUpdate(false);
    deps.remove(runner.paths.update);
    handing = null;
    const commit = readRunner({ paths: runner.paths, read: deps.read, alive: () => true })?.commit;
    runner.say(`update: could not hand over — this runner keeps going on ${commit || 'the code it holds'}; mc run --update to try again`);
    return false;
  })());
  try {
    if (!once) {
      // The unattended run: `mc run lanes <n>` loops, each on its own clock,
      // each taking the next work of any kind on any repository (`pass`). The
      // chores a round used to do around its lanes run in their own loop
      // beside them. STOP and UPDATE are read between picks.
      //
      // The lanes take from one picture of everything that could start and
      // claim what they pick (`claims`), so two never hold one goal. Until 2026-11-02 there were `per_repo` loops on each repository,
      // capped by `--total`; a lane on a repository with nothing to do sat
      // idle while the other repository's work waited. Now a free lane takes
      // the next work wherever it is, and no repository takes every lane
      // while another waits (`pickWork`, lane-pick.js).
      runner.say(`lanes: ${laneSetting} in total, across every repository`);
      //
      // UPDATE hands over at once (ruling 28): the checkout is fast-forwarded,
      // the successor is started on the new code, and this runner takes no
      // new session — it finishes the passes it is in and exits, leaving
      // runner.json and the lane files to the successor. The successor starts
      // every lane whose file this runner does not hold, waits on the ones it
      // does (`laneHolder`). For a session's length two runners overlap, and runner.json
      // says so (`predecessor`).
      //
      // Three versions preceded this. On 2026-09-04, in the morning, a lane
      // that read UPDATE after an idle round left its loop and *sat*, so the
      // idle lanes took no work for the whole of a busy lane's session. Then idle
      // lanes were let to keep taking work until a quiet moment — and with
      // four lanes in steady work the quiet moment never came: an UPDATE the
      // runner wrote for itself at 09:30 was still pending two hours later,
      // running old code the whole time. Martin then chose the drain (A) over
      // an immediate handover with two runners (B): no lane started a session
      // and the handover came when nothing was in flight anywhere — which
      // left every idle lane idle for up to a session's length on every update.
      // Ruling 28 took B.
      //
      // After the handover this runner says every ten minutes what it still
      // holds — once for the runner, from whichever loop looks first, not
      // once per lane. The words are `drainWaiting`'s, the ones
      // `mc run --update` prints.
      // An idle lane's ten minutes, and the chore loop's, in slices of
      // `UPDATE_POLL_MS`: a STOP or an UPDATE ends the wait within thirty
      // seconds rather than at its end. Measured 2026-10-10: STOP at
      // 06:47:23, the chore loop read it at 06:50:43 — and a lane that has
      // just gone to sleep would have read it ten minutes late, with nothing
      // anywhere saying the order had been seen.
      //
      // Each slice also reconciles the lane set with the total, so every idle
      // lane and the idle chore loop look once per `UPDATE_POLL_MS` with no
      // loop of their own. `until` ends the wait early for a lane that a
      // lowered total has retired.
      const nap = async (ms, { until = () => false } = {}) => {
        for (let left = ms; left > 0; left -= UPDATE_POLL_MS) {
          if (runner.stopRequested() || runner.updateRequested() || until()) return;
          reconcile();
          await deps.sleep(Math.min(left, UPDATE_POLL_MS));
        }
      };
      const lanesNow = () => laneTotal(deps) || DEFAULT_LANES;
      const drainPaths = { dir: dirname(runner.paths.update), update: runner.paths.update, runner: runner.paths.runner };
      const drainTick = () => {
        if (!handedOver) return;
        const state = drainState({ paths: drainPaths, read: deps.read, list: deps.list, now: deps.now(), alive: isAlive });
        const own = state.inFlight.filter((held) => held.pid === runner.pid);
        if (own.length === 0) return;
        const now = deps.now().getTime();
        if (now - drainMark < DRAIN_TICK_MS) return;
        drainMark = now;
        runner.say(`update: pid ${runner.pid} still ${drainWaiting({ ...state, inFlight: own })}`);
      };
      const lane = async (index) => {
        // A lane at or above the total as `lanes.json` says it now. Read only
        // at the top of a pass, so a lane in a session finishes it, and a pass
        // already waiting for a slot still runs its session. Index 0 never
        // retires: the total is at least 1.
        const retired = () => index >= lanesNow();
        // The last line this lane said about having taken nothing. An idle
        // lane looks every ten minutes and would otherwise write the same
        // sentence 144 times a day; it says it once and then goes quiet until
        // something changes.
        let quietLine = null;
        // What this lane ran a moment ago, which the next pick weighs (`pass`).
        let last = null;
        for (;;) {
          const tag = `lane ${index + 1}`;
          if (runner.updateRequested()) {
            if (await update()) return { update: true };
            continue;
          }
          // A lane above a lowered total leaves between passes. A successor's
          // lane waiting on its predecessor's session below is not in one, so
          // it leaves here too.
          if (retired()) {
            runner.say(`${tag}: lanes is now ${lanesNow()} — this lane exits`);
            return { retired: true };
          }
          // A successor's lane whose number the runner it replaced still holds:
          // that runner is in a session there, and this lane starts when it ends.
          const holder = runner.laneHolder(index);
          if (holder) {
            const line = `${tag}: waiting for pid ${holder.pid} to finish ${holder.name || 'its session'}`;
            if (line !== quietLine) { runner.say(line); quietLine = line; }
            await deps.sleep(UPDATE_POLL_MS);
            if (runner.stopRequested()) { runner.say(`${tag}: STOP — this lane exits; ${runner.stillHeld()}`); return { stop: true }; }
            continue;
          }
          const r = await runner.pass({ lane: index, tag, last });
          // A lane that leaves says so: eleven silent exits are what made a
          // one-lane runner look like a busy one (2026-10-07). `pass` has
          // already said it when a session ran first.
          if (r.stop) { if (!r.ran) runner.say(`${tag}: STOP — taking nothing, this lane exits; ${runner.stillHeld()}`); return { stop: true }; }
          // A session ran: the goals it was picked from have moved on, so the
          // next pick is made at once rather than after a sleep nobody is
          // waiting for.
          if (r.ran) { quietLine = null; last = { name: r.name }; continue; }
          // Nothing ran, and the sleep below is ten minutes.
          last = null;
          const line = r.waited
            ? `${tag}: waiting — ${r.waited === 'skipped' ? 'nothing could be started this pass' : r.waited.slice('skipped:'.length)}`
            : `${tag}: nothing to run — sleeping`;
          if (line !== quietLine) { runner.say(line); quietLine = line; }
          if (runner.updateRequested()) continue;
          await nap(idleSleepMs, { until: retired });
          if (runner.stopRequested()) { runner.say(`${tag}: STOP — this lane exits; ${runner.stillHeld()}`); return { stop: true }; }
        }
      };
      // The chore loop is the one that is never in a session, so after a
      // handover it is the ticker while the lanes sit in their sessions.
      const choreLoop = async () => {
        for (;;) {
          if (runner.stopRequested()) { runner.say('chores: STOP — exiting'); return {}; }
          if (runner.updateRequested()) {
            if (!(await update())) continue;
            while (ownInFlight().length > 0 && !runner.stopRequested()) {
              drainTick();
              await deps.sleep(UPDATE_POLL_MS);
            }
            return {};
          }
          await runner.chores();
          reconcile();
          await nap(idleSleepMs);
        }
      };
      // The live lane set, keyed by index: `reconcile` starts each lane below
      // the total that is not running, and a lane above it leaves
      // the set when it retires, so a later raise starts it again. After the
      // first call nothing starts once STOP or UPDATE is read or the runner
      // has handed over. The first call starts every lane whatever it finds,
      // as the fixed set did: each lane answers a STOP or an UPDATE present
      // at start itself, and a lane started later would be one the loop
      // below has already stopped waiting for.
      const live = new Map();
      let starting = true;
      function reconcile() {
        if (!starting && (runner.stopRequested() || runner.updateRequested() || handedOver)) return;
        const n = lanesNow();
        for (let index = 0; index < n; index += 1) {
          const key = `lane#${index}`;
          if (live.has(key)) continue;
          live.set(key, lane(index).then((result) => ({ key, result })));
          if (!starting) runner.say(`lanes: ${n} in total now — lane ${index + 1} started`);
        }
      }
      // Until STOP, or until a handover that took and the sessions this runner
      // held have all ended.
      const chores = choreLoop();
      reconcile();
      starting = false;
      const results = [];
      while (live.size) {
        const { key, result } = await Promise.race(live.values());
        live.delete(key);
        results.push(result);
      }
      results.push(await chores);
      if (results.some((r) => r.stop)) { runner.say(`runner exit on STOP — pid ${runner.pid} has ended; mc run start starts the next`); return 0; }
      runner.say(`every session pid ${runner.pid} held has ended — exiting`);
      return 0;
    }
    // `--once`: one pick over every repository, and out. One lane, no chores
    // — a person watching one session, which is what the flag is for. A goal
    // that does not start is passed over and the next tried, as a lane does.
    const r = await runner.pass({ tag: 'once' });
    if (r.stop) { runner.say(`runner exit on STOP — pid ${runner.pid} has ended; mc run start starts the next`); return 0; }
    runner.say(r.ran ? 'once: exiting' : 'once: nothing to run');
    return 0;
  } finally {
    if (!handedOver) runner.clearRunner();
  }
}
