/**
 * The gate round, as a machine.
 *
 * The rule it enforces: a test the change reaches is either green, or the
 * round is red — unless it is red on main too and the change does not touch
 * it (ruling 44 § 4, below). Main is not measured to find that out: ruled by
 * Martin on 2026-08-31, after the differential form spent half of every
 * round's wall clock, a second worktree and a second `npm ci` answering it.
 * What is measured is the diff: the test files the repository's selector says
 * the change reaches, and the command gates it named beside them.
 *
 * The round, in order, stopping at the first red step:
 *
 *  1. take the repository's lease, so two rounds cannot measure against each
 *     other's moving main;
 *  2. read what the pull request actually is, from `gh`;
 *  3. heal mc's standing measurement checkout — its head with the current base
 *     merged into it, so what is measured is the state after merging rather
 *     than the state the author last saw;
 *  4. run what the repository's selection reached — or, with `full`, the
 *     whole suite the repository *declared*, which is the only reading here
 *     that is about the code rather than about a change. Declared, not
 *     inferred from `npm test`: that inference is what made `--full` run 6
 *     files of memoro's 2,018 and summarise them as everything;
 *  5. run the command gates the repository's selection named;
 *  6. give the lease back, whatever happened.
 *
 * There is no merge in here, and not behind a flag either. This module answers
 * one question — is this change red — and a module that could also merge would
 * be one `if` away from a round that merged on a verdict it had not finished
 * forming. Merging lives in `repo-merge.js`, which runs this and acts on the
 * report; keeping it out of here is load-bearing rather than tidy, and a test
 * asserts against this file's source that it stays out.
 *
 * It says what it measured, never "the pull request is good". Reading the diff
 * against its contract is judgement, and judgement is not mechanical; a
 * passing suite carrying an unescalated design decision is exactly the mistake
 * that conflation would license.
 *
 * Main's health is not investigated on a PR's clock (Martin, 2026-11-04).
 * Completed main-only runs record exact-SHA standing failures. A PR may read
 * that evidence for unchanged test files with the same failing names, but never
 * checks out main, reproduces its failures or walks its history. Missing or stale
 * evidence fails closed; it is not proof that this PR introduced the failure.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { claimLease, releaseLease } from './repo-lease.js';
import { cancelledFiles, killedFiles, redFiles, redNames, redNamesIn, redTests, sameFailure, tapTotals } from './tap-red.js';
import { readMainRed, recordMainRed, redAt } from './selector-miss.js';
import { currentHolder } from './work-identity.js';
import { describeRunning, noteGatePhase, releaseGateLock, takeGateLock } from './gate-lock.js';
import { runShell as runShellAsync, runTool } from './child-async.js';
import { runAsync as runGitAsync } from './git.js';
import { measurementCheckout, measurementCheckoutPath } from './measurement-checkout.js';
import { log } from './logger.js';
import { mcHome, workGatePath, workRoot } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';
import { dependencyTree } from './dependency-tree.js';
import { regenerateDerived } from './repo-derived.js';
import { ensureSharedDeps } from './shared-deps.js';
import { prepareCacheDir, prepareCandidate } from './prepare-cache.js';
import { duplicateRow } from './archive-plan.js';
import { readRounds, recordRound } from './repo-round-log.js';
import { TIMES_REPORTER, outputCut, recordTestTimes, recordTooSlow, progressTracker, runProgress, slowTests, testsMeasured } from './test-times.js';
import { UNKNOWN, declarationFor, gateLaneOf, repoDeclarationPath, tablePath } from './repo-gate-table.js';
import { intakeDir, programmeNames, programmeProposalsDir, proposalsDir } from './helper-collect.js';
import { GATE_MEASUREMENT_VERSION, commandIdentity, findGreen, findGreenForHead, gateConfiguration, selectionHash } from './gate-greens.js';
import { ensure as ensureDocker, needsDocker, release as releaseDocker } from './docker.js';
import { repoNameOf } from './repos.js';
import { nodeTestScript, scriptTimeoutAt, timeoutMs as positiveMs, timeoutValues } from './gate-local.js';

export const GATE_SCHEMA = 'mc-repo-gate';
export const GATE_VERSION = 1;

/**
 * Thrown by a phase that would start after the round was stopped from outside
 * (`runGate`'s `signal`). The round catches it and ends `stopped_at: 'gone'`.
 */
export class RoundAborted extends Error {}

/** The reason an aborted signal carries, as the round words it. */
function abortReason(signal) { return String(signal?.reason?.message || signal?.reason || 'the round was stopped'); }

/**
 * Where the throwaway worktree lives: under the work root, never inside the
 * repository.
 *
 * It lived under `mcHome()` until 2026-09-03, which is somewhere no dependency
 * tree is — so the candidate ran the same five-files-short suite every
 * workarea used to, and paid an `npm ci` of its own to stop doing it. The work
 * root is where mc keeps the one tree (`paths.js`, `WORK_GATE` beside
 * `SHARED_DEPS`), and a candidate two directories under it resolves that tree by
 * node's own parent walk.
 */
export function gateRoot(env = process.env) {
  return workGatePath(env);
}

/**
 * Run the gate round and report what it found.
 *
 * Everything the round touches outside this process is injectable — `git`,
 * `gh`, and the suite runner — because the one thing that cannot be asserted
 * in a test suite is a real forty-minute suite run against a real remote. The
 * defaults are the real thing.
 *
 * `holder` is read once, here, from wherever the caller is standing. The round
 * spends its life in temporary worktrees outside the work root, and a lease
 * taken from in there would be held by `user@host` instead of by the area
 * doing the work — a lease nobody can find the owner of. Nothing below ever
 * changes this process's working directory; every command is given its `cwd`.
 */
export async function runGate({
  repoPath,
  pr,
  // Several pull requests measured as one candidate (A3, 2026-08-23): with
  // eleven in the queue and every round 5–13 minutes holding the suite
  // right, the round — not the computation — was the bottleneck. One tree
  // with all of them merged in, the suite once, and each pull
  // request's own tests still run by themselves so the batch never hides
  // which one carried which test. `pr` alone is the single-PR round it
  // always was.
  prs = null,
  // The whole suite on one tree, instead of the files the diff reaches. It is
  // the one reading here that is about the code rather than about a change,
  // and with no pull request it measures the default branch as fetched. Asked
  // for by `mc test <repo> --full`, and taken on an interval by `mc test
  // nightly`, which calls this function with this flag rather than copying
  // what it does.
  full = false,
  // The round log's own word for what this round is (`check`, `merge`,
  // `full`, `nightly`, …) — the same word `noteGatePhase` and `takeGateLock`
  // write beside the pid, so a reader of the lock sees what a reader of the
  // round log sees. Left null, it is guessed from `full` below, which is
  // right for every caller that never named one (nightly's whole-suite
  // round included) and wrong for none: an explicit `mode` always wins.
  mode = null,
  tests = null,
  holder = currentHolder(),
  root = mcHome(),
  env = process.env,
  git = null,
  gh = null,
  suite = null,
  // How the command gates the selection named are run (`commandShell` when
  // null): asynchronous, after the suite has finished.
  shell: gateShell = null,
  // The `{ ensure, release }` a command gate that `needs: ['docker']` is given;
  // null means src/mc/docker.js's own, and a test hands in a fake.
  docker = null,
  // The pid a Docker lease and the `mc.holder` label name: the process running
  // this round, which is the merger's pid in a merge.
  holderPid = process.pid,
  onProgress = () => {},
  // Stops the round from outside: step 2 of round-abort, the merger's watch.
  signal = null,
  clock = () => Date.now(),
  // Monotonic milliseconds for the intervals (`report.intervals`); the wall clock
  // above stays the round's record. Injected so a test can make both deterministic.
  monotonic = () => globalThis.performance.now(),
  // How the round's ceiling is armed: `(fire, ms) => cancel`, a timer of `ms`
  // by default. A test hands in one it fires itself, at the moment its stuck
  // child is reached, rather than waiting the ceiling out.
  armCeiling = (fire, ms) => {
    const timer = setTimeout(fire, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  // Poll progress independently of the ceiling; injectable for the fixture clock.
  armStall = (fire, ms) => {
    const timer = setInterval(fire, Math.min(1000, ms));
    timer.unref?.();
    return () => clearInterval(timer);
  },
  // Whether the round owns the lease or is running inside somebody else's.
  //
  // The merge step has to hold one lease across the gate *and* the merge — a
  // round that let go in between would be measuring against a main another
  // round was free to move. So it claims first and passes `holdLease: false`,
  // and this module neither takes nor gives back what it did not claim.
  holdLease = true,
  // Whether the round installs its own SIGINT/SIGTERM handler, which gives
  // the lease and the round lock back and exits. `mc test` and `mc merge
  // --check` want that. The merger does not: its own handler lets the jobs in
  // flight finish, and a round that exits under it would end them all. With
  // `false` the `finally` below gives both back.
  signals = true,
  // Read already-measured exact-base health, without replaying main (2026-11-04).
  readMainEvidence = readMainRed,
  // Explicit receipt binding for a caller that has one; null is every round today.
  evidence = null,
  candidateCwds = undefined,
} = {}) {
  const startedAt = clock();
  const origin = monotonic();
  // Where the repository may keep what it learns about its own tests between
  // rounds (MC_SELECTION_STATE), and whether this round may write there
  // (MC_SELECTION_STATE_WRITE). A directory under mc's home per repository,
  // never inside it: the candidate is healed before every round, so a
  // selector that learns from its runs has nowhere else to keep it. Written
  // only by a whole-suite run of the default branch as fetched — the nightly,
  // or a person's `--full` — because that is the one tree that is main and not
  // somebody's unlanded change. Every round reads it. What goes in it is the
  // repository's business; mc only gives it a place.
  env = selectionState(env, {
    root, repoPath, writes: Boolean(full) && pr == null && !(Array.isArray(prs) && prs.length),
  });
  // A dev server this round's tests start waits in the admission queue as a
  // gate round, which goes ahead of screenshots after two minutes (`dev-queue.js`).
  // A session's `mc gate` has named its round already; a merge round names its own.
  if (!env.MC_GATE_ROUND) env = { ...env, MC_GATE_ROUND: `gate-${process.pid}-${startedAt}` };
  // The narration goes two places. `onProgress` is the operator's stderr and
  // scrolls away with the pane; the log keeps it under this run's id, so a
  // round that is killed still says how far it had got and what it had decided
  // by then — the thing that was missing on 2026-08-30. One funnel, so a line
  // cannot reach one and miss the other.
  // The repository's lane (gate-lock.js), which this round's lock is in.
  const lane = gateLaneOf(repoPath);
  const say = (message) => {
    log('gate.say', { text: message });
    noteGatePhase({ root, message, lane });
    try { onProgress(message); } catch { /* progress is a courtesy */ }
  };

  // Bound to the `env` this round was given rather than to the process's own.
  // A round that took an environment and then resolved its binaries against a
  // different one is answering a question nobody asked, and it is why a test
  // that put a stub `gh` on the PATH still reached the real one.
  // The round-wide stall signal exists before any child starts, and bounds
  // every await even when an injected child ignores its signal.
  const deadlineController = new AbortController();
  const stopSignal = deadlineController.signal;
  // Reporter progress names unfinished work and detects forward motion.
  const progress = progressTracker();
  const pendingTestRuns = new Set();
  let lastProgress = clock();
  let progressSeen = JSON.stringify([]);
  const progressed = () => { lastProgress = clock(); };
  const activeCommands = new Set();
  const activePhases = new Set();

  // The signal a child is started with: the caller's and the stall detector's, read
  // when the child starts, which is after `signal` is combined below.
  const childSignal = () => signal;
  // A child may ignore its signal (a stub, a process that never reads it). The
  // round must not wait for it past a stall, so the wait is cut there and
  // the round unwinds through `RoundAborted`; the child is still signalled.
  const untilStopped = (value) => new Promise((resolve, reject) => {
    const stop = () => reject(new RoundAborted(abortReason(stopSignal)));
    if (stopSignal.aborted) {
      Promise.resolve(value).catch(() => {});
      return stop();
    }
    stopSignal.addEventListener('abort', stop, { once: true });
    Promise.resolve(value).then((done) => {
      stopSignal.removeEventListener('abort', stop);
      resolve(done);
    }, (thrown) => {
      stopSignal.removeEventListener('abort', stop);
      reject(thrown);
    });
  });
  const bounded = (call) => (...args) => stopSignal.aborted
    ? Promise.reject(new RoundAborted(abortReason(stopSignal))) : untilStopped(call(...args));
  const run = (tool) => (args, options = {}) => runTool(tool, args, { cwd: options.cwd, env, signal: childSignal() });
  // The raw git is kept for the workspace's own clean-up, which runs after the
  // stall signal has fired and must not be cut short by it.
  const askGitRaw = git || ((args, options = {}) => runGitAsync(options.cwd, args, { env }));
  const askGit = bounded(askGitRaw);
  const askGh = bounded(gh || run('gh'));
  // The selector's resource classes, once the round has read them: a file
  // classed `sqlite` or `heavy` runs after the standard batch, `heavy` one at
  // a time, as memoro's own runner runs it (gate-round-under-load, item 6).
  let fileClasses = {};
  const runShell = gateShell || commandShell;

  const numbers = (Array.isArray(prs) && prs.length ? prs : [pr]).filter((n) => n !== null && n !== undefined).map(Number);
  const batch = numbers.length > 1;
  // `mc test <repo> --full` names no pull request: there is nothing to merge
  // in, and the one tree is the default branch as fetched.
  const wholeSuite = Boolean(full);
  const gateMode = mode || (wholeSuite ? 'full' : 'merge');
  // The round's lanes, answered once, and the load they were answered at: a
  // merge, check or full round runs at least `MERGE_LANES_MIN`, a session's
  // gate the free cores (`testLanes`). The round record names both.
  const load = Math.round(loadavg()[0] * 10) / 10;
  const lanes = testLanes({ env, load, mode: gateMode });
  // `where` names this round in the too-slow file (`recordTooSlow`): its pull requests, or the whole suite.
  const timesOf = { root, repo: lane, where: numbers.length ? numbers.map((n) => `#${n}`).join(' ') : 'full', track: progress.track, complete: progress.complete };
  // Every test the round's runs measured, all on the candidate: the ones over the
  // slow-test indicator are named in the report (`slow_tests`), never its red.
  const measuredTests = [];
  const runSuite = async (options) => {
    const result = await (suite || ((one) => realSuite({ ...one, env, lanes, signal, times: timesOf })))(options);
    measuredTests.push(...(result?.tests || []));
    progressed();
    return result;
  };
  const runTests = async (options) => {
    const ownProgress = progressTracker();
    const request = { files: options.files || [], progress: ownProgress };
    pendingTestRuns.add(request);
    const times = { ...timesOf,
      track: (file) => { progress.track(file); ownProgress.track(file); },
      complete: (file) => { progress.complete(file); ownProgress.complete(file); },
    };
    const result = await (tests || realTests)({ env, lanes, classes: fileClasses, signal, ...options, times });
    progressed();
    measuredTests.push(...(result?.tests || []));
    if (tapTotals(result.tap).finished && !result.aborted && !result.timedOut && !result.error) pendingTestRuns.delete(request);
    return result;
  };
  const label = numbers.length ? (batch ? numbers.map((n) => `#${n}`).join(' ') : `#${numbers[0]}`) : 'the whole suite';
  // What a command gate that needs Docker is leased and labelled with.
  const dockerIo = docker || { ensure: ensureDocker, release: releaseDocker };
  const dockerLabel = { run: `${gateMode} ${label}`, repo: repoNameOf(repoPath) };

  const report = {
    schema: GATE_SCHEMA,
    version: GATE_VERSION,
    repo: repoPath,
    // What was measured, as a word: the diff a pull request makes, or the
    // repository's own suite on one tree.
    full: wholeSuite,
    pr: { number: numbers[0] ?? null, head: null, base: null, head_sha: null, title: null },
    // The batch, when there is one: every pull request's facts and its own
    // tests, in the order they were merged into the candidate. Null for a
    // single round, whose facts are `pr` and whose tests are `pr_tests`.
    prs: batch ? numbers.map((number) => ({ number, head: null, base: null, head_sha: null, title: null, pr_tests: null })) : null,
    holder: holder.name,
    ok: false,
    merged: false,
    stopped_at: null,
    reason: null,
    command: null,
    declaration: null,
    // The branch the candidate was measured against, and the commit it stood
    // at when the round fetched. Not a measurement of it — nothing is run
    // there — but `mc merge` has to know whether the ground moved between the
    // round and the landing, and this is the ground.
    base: null,
    // What the round measured, when the repository selects by diff: the files
    // the change reaches. Null when the repository has no `select`, or when
    // `--full` asked for the whole suite instead.
    selection: null,
    // What the round ran when it ran a whole suite: the command, and whether
    // the repository declared it or it is the `npm test` fallback. Null when
    // a selection ran instead.
    full_suite: null,
    extra_gates: [],
    unmeasured: { files: [], gates: [] },
    alone: { files: [], gates: [] },
    // Previously measured exact-base health, read only after a candidate red.
    // Missing or stale evidence never triggers a main run or attribution walk.
    main_red: null,
    // The red files the round went on past: exact-base standing evidence, and
    // untouched by the change (ruling 44 § 4). Named in the verdict as not
    // counted; null when there were none.
    main_red_files: null,
    // What was red in the round and green when run once more alone, in the
    // files and command gates the declaration names `retry_once` (ruling 44
    // § 5): `{ files, names, gates }`. Null when nothing flipped.
    flipped: null,
    // The pull request's own tests: every `*.test.js` it adds or changes, run
    // on the candidate after the suite (D-0157). `files: []` when it touches
    // none, which is said rather than left blank.
    pr_tests: null,
    // The declared derived artifacts, regenerated after the merge: which
    // files changed, and the commit that carries them in the candidate. Null
    // when the repository declares none.
    derived: null,
    candidate: null,
    // The green `mc gate` recorded, when the round took it instead of
    // measuring (`gate-greens.js`): `{ mode: 'exact', at, session }` for this
    // exact tree and selection, or `{ mode: 'delta', at, session,
    // delta_paths, rerun_files, rerun_commands }` for the pull request's own
    // head tree with only what main's movement reaches run again (ruling 47).
    // Null when it measured the whole selection.
    reused: null,
    // The prefix trees of a batch candidate as it was built, `T_1..T_N`:
    // what main must be, byte for byte, after each landing. Null for a
    // single round; `T_N` equals `candidate.tree`.
    candidate_trees: null,
    // The verdict as a word a reader can branch on: `green`, `red`, or
    // `stopped`. There is no third pass any more — `no-new-red` was the
    // differential form's word for "no dirtier than main", and the round no
    // longer measures main to be able to say it.
    verdict: null,
    // Wall clock per step (A5). Four decisions about cost were taken one day
    // without a single number from the tool itself; the next one is measured.
    timings: {},
    // Every step as it ran, wall and monotonic, relative to the round's start for
    // the monotonic pair. Intervals can overlap (selection beside an earlier red), so their `ms` are not a breakdown of `duration_ms`.
    intervals: [],
    // The lanes the round's tests ran at and the load they were answered at
    // (`testLanes`); the round record names both.
    lanes,
    load,
    started_at: new Date(startedAt).toISOString(),
    finished_at: null,
    duration_ms: null,
  };
  // Every await is bounded by the stall signal, including a child that ignores it.
  const interval = (step, wallFrom, wallTo, monoFrom, monoTo) => {
    report.intervals.push({ step, start_wall: new Date(wallFrom).toISOString(), end_wall: new Date(wallTo).toISOString(),
      start_ms: monoFrom - origin, end_ms: monoTo - origin, ms: monoTo - monoFrom });
  };
  const timed = async (step, fn) => {
    if (signal?.aborted) throw new RoundAborted(abortReason(signal));
    const from = clock();
    const fromMono = monotonic();
    activePhases.add(step);
    try { return await untilStopped(fn()); } finally {
      activePhases.delete(step);
      const to = clock();
      report.timings[step] = (report.timings[step] || 0) + (to - from);
      interval(step, from, to, fromMono, monotonic());
      say(`${step} took ${seconds(report.timings[step])}`);
    }
  };

  const finish = (stoppedAt, reason) => {
    report.stopped_at = stoppedAt;
    const unmeasured = [...report.unmeasured.files, ...report.unmeasured.gates];
    report.reason = reason && ['red', 'pr-tests', 'selected-gate', 'extra-gate'].includes(stoppedAt) && unmeasured.length
      ? `${reason}; not measured in the initial run: ${unmeasured.join(', ')}` : reason;
    report.slow_tests = slowTests(measuredTests);
    report.ok = stoppedAt === null;
    report.verdict = verdictFor(report);
    const ended = clock();
    report.finished_at = new Date(ended).toISOString();
    report.duration_ms = ended - startedAt;
    return report;
  };

  if (holdLease) {
    // Taken for the length of this process, and it says so (lease-owner.js):
    // a round cut short by a kill leaves a lease its pid can answer for.
    const lease = claimLease({ repoPath, errand: `gate round for ${label}`, holder, ownerPid: process.pid, root });
    if (!lease.ok) {
      const held = lease.lease;
      return finish('lease', `${repoPath} is held by ${held.holder}${held.errand ? ` for “${held.errand}”` : ''}`);
    }
    say(`lease taken by ${holder.name}`);
  }

  // What this repository needs, read before any work is done. A round that
  // cannot know whether the suite will be complete is a round whose green
  // means nothing, so it stops here rather than after two suite runs. Read
  // before the lock.
  const declared = declarationFor(repoPath, { root, env });
  if (!declared.ok) {
    if (holdLease) releaseLease({ repoPath, holder, root });
    return finish('declaration', declared.reason);
  }

  // One gate round at a time per repository (gate-lock.js). A full suite
  // pins the cores for a minute and a half, and this round runs two; two
  // rounds at once make both slower and both flakier, and the flakiness lands
  // on whichever pull request happened to be measured.
  //
  // A file and a pid, and nothing else. What was here was "the suite right" —
  // a lease with an errand, a liveness verdict, a --force release, an inbox
  // message, a row on the page and four verbs of its own. Four hundred lines
  // of vocabulary for "one at a time", under a name nobody could say without
  // explaining it.
  const held = takeGateLock({ repo: repoFileSlug(repoPath), pr: numbers[0] ?? null, mode: gateMode, root, lane });
  if (!held.ok) {
    if (holdLease) releaseLease({ repoPath, holder, root });
    return finish(held.error ? 'reservation' : 'busy', held.error || describeRunning(held.running, lane));
  }
  const ownGateLock = held.took;
  if (ownGateLock) say(`gate round started (pid ${process.pid}) — one at a time in the ${lane} lane`);
  else say('the round lock could not be written — running anyway; another round could overlap this one');

  // The repository ceiling is information, not a verdict. Only no progress
  // for the stall window stops the group and releases its lane.
  const externalSignal = signal;
  signal = externalSignal ? AbortSignal.any([externalSignal, stopSignal]) : stopSignal;
  const roundTimeoutMs = declared.declaration.round_timeout_ms || suiteTimeoutMs(env);
  const stallMinutes = Number(env.MC_ROUND_STALL_MINUTES);
  const stallMs = Number.isFinite(stallMinutes) && stallMinutes > 0 ? stallMinutes * 60_000 : ROUND_STALL_MS;
  let stalled = false;
  let stallReason = null;
  const relativeFile = (file) => {
    const prefixes = [headDir, ...(existsSync(headDir) ? [realpathSync(headDir)] : [])];
    const prefix = prefixes.find(dir => file.startsWith(`${dir}/`));
    return prefix ? file.slice(prefix.length + 1) : file;
  };
  const pendingFiles = () => {
    const runs = progress.read();
    return [...new Set([...runs.unfinished.map(relativeFile), ...[...pendingTestRuns].flatMap(request => {
      const done = new Set(request.progress.read().finished.map(one => relativeFile(one.file)));
      return request.files.map(relativeFile).filter(file => !done.has(file));
    })])];
  };
  const stopStalled = (why) => {
    stalled = true;
    report.stalled_files = pendingFiles();
    report.stalled_gates = [...activeCommands];
    stallReason = `${why} — files in flight: ${nameSome(report.stalled_files) || 'none named'}; gates in flight: ${nameSome(report.stalled_gates) || 'none'}; phase: ${[...activePhases].join(', ') || 'final checks'}; load ${Math.round(loadavg()[0] * 10) / 10}`;
    deadlineController.abort(new Error(stallReason));
  };
  const cancelCeiling = armCeiling(() => {
    const runs = progress.read();
    const finished = runs.finished.length;
    say(`past its ${Math.ceil(roundTimeoutMs / 1000)} s ceiling at load ${Math.round(loadavg()[0] * 10) / 10} — ${finished} of ${finished + pendingFiles().length} files finished, going on`);
  }, roundTimeoutMs);
  const cancelStall = armStall(() => {
    const signature = JSON.stringify(progress.read().finished);
    if (signature !== progressSeen) { progressSeen = signature; progressed(); }
    if (clock() - lastProgress >= stallMs) stopStalled(`no progress for ${stallMs / 60_000} min`);
  }, stallMs);
  // A completed command is progress; its invocation names a stalled child.
  const trackedCommand = async (command, options) => {
    activeCommands.add(command);
    try { return await runShell(command, options); }
    finally { activeCommands.delete(command); progressed(); }
  };

  // Abort through the ordinary finally path so children stop before the
  // lane is released. Exiting inside the handler skips that path.
  const onSignal = (received) => {
    log('gate.killed', { repo: repoFileSlug(repoPath), signal: received, pr: label, holder: holder?.name || null });
    try {
      recordRound({
        ok: false, stopped_at: 'killed', reason: `cut short by ${received}`, repo: repoPath,
        ...(numbers.length > 1 ? { batch: { prs: numbers, merges: [] } } : { pr: { number: numbers[0] } }),
        holder: holder?.name || null, started_at: new Date(startedAt).toISOString(),
      }, { mode: gateMode, root });
    } catch { /* abort and cleanup still run */ }
    process.exitCode = 128 + (received === 'SIGINT' ? 2 : 15);
    deadlineController.abort(new Error(`cut short by ${received}`));
  };
  const caught = signals ? ['SIGINT', 'SIGTERM'] : [];
  for (const signal of caught) process.on(signal, onSignal);

  report.declaration = { source: declared.source, ...declared.declaration };

  const headDir = measurementCheckoutPath(repoPath, workRoot(env));

  try {
    // What the pull request actually is, rather than what the caller believes.
    // A number is all the caller has; the branch, its head, and the branch it
    // is aimed at all come from the forge.
    const all = [];
    for (const number of numbers) {
      const facts = await prFacts({ gh: askGh, git: askGit, repoPath, pr: number, say });
      if (!facts.ok) return finish('pr', facts.reason);
      all.push(facts.pr);
      say(`#${facts.pr.number} — ${facts.pr.head} into ${facts.pr.base}`);
    }
    const facts = { pr: all[0] || null };
    if (facts.pr) Object.assign(report.pr, facts.pr);
    if (batch) {
      for (const [index, item] of all.entries()) Object.assign(report.prs[index], item);
      // One base, or it is not one candidate: a tree with two pull requests
      // aimed at different branches measures nothing anybody will land.
      const bases = [...new Set(all.map((item) => item.base))];
      if (bases.length > 1) return finish('pr', `the batch aims at ${bases.length} different bases (${bases.join(', ')}) — one round per base`);
    }

    // Fresh, always. What is measured is the tree after the current base has
    // been merged in, and a stale remote-tracking ref is how a round measures
    // a main that moved an hour ago.
    const fetched = await timed('fetch', async () => askGit(['fetch', 'origin', '--prune'], { cwd: repoPath }));
    if (fetched.status !== 0) return finish('fetch', trim(fetched.stderr) || 'git fetch failed');

    // The branch the change is aimed at — or, with no pull request to ask it
    // of, the default branch as the remote itself names it. Assuming `main`
    // here would measure a tree nobody asked about on a repository that calls
    // it something else, so it is read, and a repository that will not say is
    // a stop.
    const baseRef = facts.pr ? `origin/${facts.pr.base}` : await defaultBaseRef({ git: askGit, repoPath });
    if (!baseRef) return finish('base', 'no pull request named a base and origin does not say which branch is its default');
    report.base = { ref: baseRef, commit: trim((await askGit(['rev-parse', baseRef], { cwd: repoPath })).stdout) || null };

    // What gets run: the test files the repository's selector says this change
    // reaches, or the repository's own whole suite. `full` asks for the second
    // on purpose; a repository with no `select` gets it either way.
    const selects = Boolean(declared.declaration.select) && !wholeSuite;
    const commandLine = suiteCommand({ repoPath, declaration: declared.declaration, root });
    if (!commandLine.ok && !selects) return finish('suite', commandLine.reason);
    report.command = selects ? declared.declaration.select : commandLine.command;
    // Which command produced a whole-suite reading, and which of the two
    // answers it is. "It was full" is not enough on its own any more: `npm
    // test` and a declared `suite` are both whole-suite runs and are not the
    // same run, and the round that reported 6 files as everything reported
    // `full: true` while it did it.
    //
    // Not the same field as `selection.full_suite`, which is the selector's
    // admission that it could not narrow a change. They are never both set:
    // this one exists only when no selection ran.
    if (!selects) report.full_suite = { command: commandLine.run, source: commandLine.source };

    const candidate = await measurementCheckout({
      repoPath, sha: facts.pr && !batch ? facts.pr.head_sha : baseRef,
      git: askGit, cwds: candidateCwds, root: workRoot(env),
    });
    if (!candidate.ok) return finish('worktree', candidate.reason);
    say(`using the merger's measurement checkout ${headDir}`);

    if (!facts.pr) {
      say(`measuring ${baseRef} as fetched — the whole suite, one tree`);
    } else if (!batch) {
      // The candidate is measured *after* merging the current base into it. A PR
      // that is green against the main its author branched from and red against
      // the main it is about to land on is exactly the collision this exists to
      // catch, and it is invisible if the head commit is tested on its own.
      const merged = await askGit(['merge', '--no-edit', baseRef], { cwd: headDir });
      if (merged.status !== 0) {
        return finish('merge', `#${facts.pr.number} conflicts with ${baseRef} — ${trim(merged.stdout) || 'merge failed'}`);
      }
      say(`merged ${baseRef} into the candidate`);
    } else {
      // The batch candidate is the base with every head merged in, in the
      // order given — the tree main would be after landing them in that
      // order. A conflict names the pull request that could not go in, so
      // the caller can fall back to one round per pull request and say so.
      report.candidate_trees = [];
      for (const item of all) {
        const merged = await askGit(['merge', '--no-edit', item.head_sha], { cwd: headDir });
        if (merged.status !== 0) {
          return finish('merge', `#${item.number} conflicts with ${baseRef} and the pull requests before it in the batch — ${trim(merged.stdout) || 'merge failed'}`);
        }
        // The prefix tree after each merge: T_i is what main must be after
        // landing the i-th pull request, byte for byte, if the sequential
        // squashes reproduce the build the suite measured. Only T_N was
        // measured; the chain is what makes each landing checkable the
        // second it happens rather than at the end (PM's ruling on the
        // tracks' disagreement, 2026-08-23).
        report.candidate_trees.push(trim((await askGit(['rev-parse', 'HEAD^{tree}'], { cwd: headDir })).stdout) || null);
        say(`merged #${item.number} (${item.head}) into the candidate`);
      }
    }

    // A project log that carries a row twice. `merge=union` on it keeps both
    // sides of a conflict, so a branch that merged main in can carry a copy
    // nobody sees (2026-10-10: one row five times on memoro's main). The
    // copy is in the branch's tree, so the red is the branch's to fix.
    const logPath = join(headDir, 'docs', 'project', 'project_log.md');
    if (existsSync(logPath)) {
      const twice = duplicateRow(readFileSync(logPath, 'utf8'));
      if (twice) {
        return finish('project-log', `project_log.md carries the same row twice: ${twice.date} ${twice.programme} ${twice.project} — delete the copy and push`);
      }
    }

    // The tree the candidate resolves through, made to match the candidate.
    //
    // This is the workareas' own mechanism (`shared-deps.js`), called on the
    // repository being measured — one `node_modules` at the work root, two
    // directories above the candidate, for the workareas and the gate
    // together. A candidate whose lockfile is the one that tree holds
    // resolves through it and nothing runs.
    //
    // Read from the candidate rather than from the repository's checkout,
    // because the candidate is what is being measured: a pull request that
    // changes `package-lock.json` gets a tree installed from *its* lockfile
    // instead of a round that cannot resolve what it added. That install goes
    // in the candidate's own `node_modules` (`ownTree`) — ignored by git, so
    // neither `git status` nor `scripts/affected-tests.js` sees it, and gone
    // with the worktree at the end of the round. Until 2026-10-18 it went
    // into the shared tree and left it at the pull request's lockfile, which
    // flipped the dependencies of every live session mid-session.
    //
    // It never stops the round. Whether the suite can resolve its
    // dependencies is measured below, from the candidate, and a measurement
    // beats a report of what an install thought it did.
    const deps = await untilStopped(ensureSharedDeps({
      repo: headDir, repoName: repoNameOf(repoPath), env, install: (cwd) => npmCiAsync(cwd, childSignal()), ownTree: headDir,
    }));
    if (deps.state === 'installed-own') say(`the candidate's own dependency tree was installed — ${deps.why}`);
    if (!deps.ok) say(`the candidate's dependency tree could not be installed — ${deps.why}`);

    // Whatever this repository needs before its suite can be believed. A
    // prepare that fails stops the round: a suite run on a tree that was not
    // prepared is exactly the incomplete run the declaration exists to
    // prevent. Once, now — it used to run in both worktrees, and on memoro
    // that was a second `npm ci` for a 492 MB tree every round.
    if (declared.declaration.prepare) {
      say(`preparing the candidate: ${declared.declaration.prepare}`);
      // `npm ci` may come from a tree installed from the same lockfile
      // (`prepare-cache.js`); the timing stays under `prepare` either way.
      const ready = await timed('prepare', async () => prepareCandidate({
        prepare: declared.declaration.prepare,
        headDir,
        cacheDir: prepareCacheDir({ repoPath, env }),
        shell: (command, options) => shell(command, { ...options, env, signal: childSignal() }),
        say,
      }));
      if (ready.status !== 0) {
        return finish('prepare', `${declared.declaration.prepare} failed in the candidate — ${trim(ready.stderr)}`);
      }
    }

    // A suite that cannot resolve its dependencies does not fail, it shrinks
    // (D-0152): the tests that need nothing run and print a number with the
    // right shape, and the rest are neither run nor counted as skipped. So it
    // is asked after preparation and before the run, from the candidate,
    // walking the parents the way node does — a tree above the worktree is a
    // tree, and this is what makes `~/mc/node_modules` usable here at all.
    //
    // There is no vouching branch any more. `prepare: null` used to buy a
    // declaration the right to run anyway, on the strength of a sentence in
    // the table — and this repository's sentence was false for months while
    // five files went unrun and uncounted, once per round, with the line
    // saying so read as reassurance. What the entry now says is what the
    // *round* must run, and whether the suite can resolve anything is
    // measured rather than declared.
    const tree = dependencyTree(headDir);
    if (tree.missing) {
      return finish('dependencies', `the candidate declares ${tree.declares} dependencies and cannot resolve `
        + `${tree.unresolved.length} of them from the worktree or any directory above it `
        + `(${nameSome(tree.unresolved)}) — a suite run there would count only what happens to run (D-0152)`);
    }

    // Files that are a function of the whole tree, regenerated on the tree
    // that is being measured (`repo-derived.js`). Merging the base in is what
    // makes them stale, so the branch cannot have them right on its own; the
    // regeneration is committed in the candidate, and `mc merge` puts the same
    // commit on the branch before it lands so main is still the measured tree.
    if (declared.declaration.derived.length) {
      const fresh = await timed('derived', async () => regenerateDerived({
        derived: declared.declaration.derived, cwd: headDir, env, git: askGit, say,
        shell: (command, options) => shell(command, { ...options, signal: childSignal() }),
      }));
      report.derived = {
        commands: declared.declaration.derived.map((item) => item.command),
        regenerated: fresh.regenerated || [],
        outside: fresh.outside || [],
        commit: fresh.commit || null,
      };
      if (!fresh.ok) return finish(fresh.kind === 'outside' ? 'derived-outside' : 'derived', fresh.reason);
      if (fresh.commit) {
        say(`regenerated ${fresh.regenerated.length} derived file${fresh.regenerated.length === 1 ? '' : 's'} after the merge and committed them in the candidate`);
        if (report.candidate_trees?.length) {
          report.candidate_trees[report.candidate_trees.length - 1] = trim((await askGit(['rev-parse', 'HEAD^{tree}'], { cwd: headDir })).stdout) || null;
        }
      } else {
        say('derived artifacts already current after the merge');
      }
    }

    // The test flags of the tree this round measures: the final candidate's
    // own `.mc/test.json`, read now — after the base merge and the derived
    // regeneration, before the previous red, the selection or the own tests
    // run — under the repository's identity, never under the directory's
    // name (`candidate`). Everything else in the declaration was read before
    // the lane was taken and stays as it was read; only the flags, and the
    // configuration a receipt is matched by, come from here. A refusal —
    // a malformed file, an override that loosens or drops the timeout
    // ambiguously — is a stop before any test is spawned.
    const measured = declarationFor(repoPath, { root, env, contentDir: headDir });
    if (!measured.ok) return finish('declaration', measured.reason);
    if (measured.notice) say(measured.notice);
    const flags = measured.declaration.pr_tests_flags || [];
    // The same resolution the session's `mc gate` makes, on the same declared flags and
    // the candidate's own script: what a green receipt is bound to, and what the tests
    // below are spawned with (`realTests` resolves the same way from `flags` and `headDir`).
    const plan = resolveTestPlan({ flags, script: testScriptOf(headDir) });
    if (plan.invalid) return finish('declaration', `timeout policy: ${plan.invalid} — nothing was run`);
    const is = facts.pr ? 'pr-head-with-base-merged-in' : 'base-branch-as-fetched';

    // What each pull request changed against the base, asked of git once a
    // round: the red that is main's needs it to know the change left a red
    // file alone, and the pull request's own tests need it to know what to run.
    const diffs = new Map();
    const changedBy = (head) => {
      if (!diffs.has(head)) diffs.set(head, prDiff({ git: askGit, cwd: headDir, baseRef, head }));
      return diffs.get(head);
    };
    // Every path the round's change touches — a batch's is the union of its
    // pull requests' — or null when one of them could not be read.
    const touchedPaths = async () => {
      const each = await Promise.all((batch ? all.map((item) => item.head_sha) : ['HEAD']).map(changedBy));
      return each.every((diff) => diff.ok) ? new Set(each.flatMap((diff) => diff.files)) : null;
    };
    // Red files that are main's, and the round goes on past them (ruling
    // 44 § 4): named, noted for the helper, and taken out of the candidate's
    // red so nothing downstream reads a green round as a red one.
    const mainRedGoesOn = (result) => {
      const files = result.red_files;
      report.main_red_files = [...new Set([...(report.main_red_files || []), ...files])];
      say(`${files.length} red file${files.length === 1 ? '' : 's'} red on main too, untouched by this change — not this round's red: ${files.join(', ')}`);
      result.red = [];
      result.red_files = [];
      result.red_tests = [];
      return null;
    };

    // A red the round measured, and whose red it is. `alone` records the
    // previous-red phase's candidate-only run; main is never run here.
    // Returns the finished report, or null when every red file is main's and
    // the change touches none of them: the round goes on.
    const retry = declared.declaration.retry_once || { files: [], gates: [] };
    // Shared by suite, previous-red and own-test phases, without granting an
    // own-test assertion any new exemption or retry policy.
    const classifyUnmeasured = (result) => {
      const killed = result.killed_files || [];
      const cancelled = result.cancelled_files || [];
      if (killed.length) report.killed_files = [...new Map([...(report.killed_files || []), ...killed].map(one => [one.file, one])).values()];
      if (cancelled.length) report.cancelled_files = [...new Set([...(report.cancelled_files || []), ...cancelled])];
      const cut = (result.red_tests || []).filter(test => {
        const match = /(?:test )?timed out after\s+(\d+)\s*ms/iu.exec((test.error || []).join(' '));
        return match && Number(match[1]) !== TEST_TIMEOUT_MS;
      });
      const files = [...new Set([...killed.map(one => one.file), ...cancelled, ...cut.map(test => test.file).filter(Boolean)])];
      const ignored = new Set([...(result.killed_red || []), ...(result.cancelled_red || []), ...cut.map(test => test.name)]);
      // Drop parent names only when every failing leaf under them was cut.
      for (const name of result.red) {
        const leaves = (result.red_tests || []).filter(test => test.name.startsWith(`${name} › `));
        if (leaves.length && leaves.every(test => ignored.has(test.name))) ignored.add(name);
      }
      for (const file of files) if (!report.unmeasured.files.includes(file)) report.unmeasured.files.push(file);
      result.red = result.red.filter(name => !ignored.has(name));
      result.red_tests = (result.red_tests || []).filter(test => !ignored.has(test.name));
      result.red_files = (result.red_files || []).filter(file => !files.includes(file) || result.red_tests.some(test => test.file === file));
      result.unmeasured = files;
      if (files.length) say(`not measured: ${files.join(', ')} — will run alone after the suite and gates`);
    };
    const stopRed = async (result, { alone = false, measuringAlone = false } = {}) => {
      if (!measuringAlone) classifyUnmeasured(result);
      if (!result.red.length) return null;
      const never = (result.red_tests || []).filter(test => /timed out after\s+600000\s*ms/iu.test((test.error || []).join(' ')));
      if (never.length) return finish('red', `never ends: ${never.map(test => test.name).join(', ')}`);
      // Every red file in it, and every red test located in one: a red name
      // no file accounts for is nobody's to excuse.
      const within = (files) => Boolean(result.red_files?.length)
        && result.red_files.every((file) => files.has(file))
        && (result.red_tests || []).every((test) => files.has(test.file));
      // Already matched to standing exact-base evidence and left untouched
      // during this round's previous-red phase: not asked twice.
      if (within(new Set(report.main_red_files || [])) && result.red_tests?.length
        && result.red_tests.every(test => report.main_red?.tests?.some(known => sameFailure(known, test)))) {
        return mainRedGoesOn(result);
      }
      // Red only in files declared to flip under load (ruling 44 § 5): run
      // once more alone on the candidate. Green, and the round goes on with
      // the flip recorded; whatever stays red is matched only to standing
      // exact-base evidence, never to a live base run.
      let retried = false;
      if (retry.files.length && within(new Set(retry.files))) {
        const headCommit = trim((await askGit(['rev-parse', 'HEAD'], { cwd: headDir })).stdout) || null;
        if (headCommit) {
          const files = result.red_files;
          say(`red only in ${files.join(', ')}, declared retry_once — running ${files.length === 1 ? 'it' : 'them'} once more alone`);
          const ran = await timed('retry once', () => redAt({
            git: askGit, tests: runTests, cwd: headDir, commit: headCommit, files, flags,
          }));
          if (ran.ok && !ran.red.length) {
            report.flipped = { ...(report.flipped || {}), files, names: [...result.red] };
            say(`green alone — ${files.join(', ')} flipped under load, not this round's red`);
            result.red = [];
            result.red_files = [];
            result.red_tests = [];
            return null;
          }
          if (ran.ok) {
            const stayed = new Set(ran.red);
            result.red_files = files.filter((file) => stayed.has(file));
            result.red_tests = (result.red_tests || []).filter((test) => stayed.has(test.file));
            const kept = new Set(result.red_tests.map((test) => test.name));
            if (kept.size) result.red = result.red.filter((name) => kept.has(name));
            retried = true;
            report.head_alone = { red: result.red_files };
            say(`red again alone: ${result.red_files.join(', ')}`);
          } else {
            say(`could not run them once more alone: ${ran.reason}`);
          }
        }
      }
      // No main execution callbacks are passed to the evidence reader. Main
      // health is measured independently, never reproduced or bisected here.
      if (alone || retried) report.head_alone = { red: result.red_files };
      if (facts.pr && result.red_files?.length) {
        report.main_red = await readMainEvidence({
          baseCommit: report.base.commit, files: result.red_files, root, repo: repoPath,
        });
        const proof = report.main_red;
        if (proof?.stopped) say(proof.stopped);
        const sameFailures = proof?.cached && result.red_tests?.length && result.red_tests.every((test) =>
          proof.tests.some((known) => sameFailure(known, test)));
        if (sameFailures && within(new Set(proof.red_on_main || []))) {
          const touched = await touchedPaths();
          if (touched && !result.red_files.some((file) => touched.has(file))) return mainRedGoesOn(result);
          say(touched ? 'this change touches a red file that is red on main — red as before'
            : 'could not read what this change touches — red as before');
        }
      }
      const hooks = (result.red_tests || []).filter((test) => /^(?:\w+ )?hook of .+ failed:$/u.test(test.error?.[0] || ''));
      const hookReasons = hooks.map((test) => {
        const kind = /^(\w+) hook of /u.exec(test.error[0])?.[1] || 'before';
        return `${test.file}: ${kind} hook failed — ${test.error[1] || 'unknown error'}`;
      });
      const errors = (result.red_tests || []).filter(test => !hooks.includes(test)).flatMap(test => test.error || []);
      return finish('red', `${result.red.length} test${result.red.length === 1 ? '' : 's'} red: ${nameSome(result.red)}${hookReasons.length ? `; ${hookReasons.join('; ')}` : ''}${errors.length ? ` — ${errors.join('; ')}` : ''}${mainRedClause(report.main_red)}`);
    };

    // The files this pull request's last round found red, alone on the
    // prepared candidate, before anything else is asked of it (ruling 44 § 2).
    // 283 pull requests needed more than one round, and each round began with
    // the whole selection although the one before had named its red files. A
    // red there is the round's red; green, and the round goes on as it always
    // did. A file the candidate no longer has is not run, and a batch has no
    // one previous round to read.
    if (facts.pr && !batch) {
      const previous = previousRedFiles({ root, repoPath, pr: facts.pr.number })
        .filter((file) => existsSync(join(headDir, file)));
      if (previous.length) {
        say(`the last round was red in ${previous.join(', ')} — running ${previous.length === 1 ? 'it' : 'them'} alone first`);
        const first = await timed('previous red', () => measureSelected({
          tests: runTests, git: askGit, cwd: headDir, files: previous, flags, say, is, signal,
        }));
        if (!first.ok) {
          report.previous_red = { files: previous, stopped: first.reason };
          say(`the previous red files could not be measured alone — the run ${first.reason}; measuring the selection`);
        } else if (first.result.red.length) {
          report.previous_red = { files: previous, red: first.result.red_files };
          report.candidate = first.result;
          report.candidate.tree = trim((await askGit(['rev-parse', 'HEAD^{tree}'], { cwd: headDir })).stdout) || null;
          say(`${first.result.red.length} red in the previous red files — the selection is not run`);
          const stop = await stopRed(first.result, { alone: true });
          if (stop) return stop;
          say(report.flipped ? 'the previous red files flipped green alone — measuring the selection'
            : 'the previous red files are main\'s red — measuring the selection');
        } else {
          report.previous_red = { files: previous, red: [] };
          say('previous red files green — measuring the selection');
        }
      }
    }

    // What this change reaches, asked of the repository rather than assumed.
    let selection = null;
    if (selects) {
      selection = await timed('selection', () => selectFiles({
        command: declared.declaration.select, cwd: headDir, env, say, mainOnly: declared.declaration.main_only, signal: childSignal(),
      }));
      if (!selection.ok) return finish('selection', selection.reason);
      fileClasses = selection.classes || {};
      report.selection = {
        command: declared.declaration.select,
        files: selection.files.length,
        // The selector's own admission that it could not narrow this change,
        // carried through so the verdict does not read as a saving it is not.
        full_suite: Boolean(selection.full),
        why: selection.why,
        // The command gates the same answer named. Counted here and listed in
        // `extra_gates`, where every gate this round ran is listed.
        commands: selection.commands.length,
        // The files themselves, so a later red on main can be checked against
        // what this round actually ran (`selector-miss.js`). A count cannot
        // answer "was this test selected?".
        selected: selection.files,
        // The digest of the selector's exact stdout (`selectFiles`'s `raw`): what the
        // selection was, byte for byte, without retaining the whole reason map here.
        raw_sha256: selection.raw?.sha256 ?? null,
      };
      say(`selection: ${selection.files.length} test file${selection.files.length === 1 ? '' : 's'} reached by this change`);
      if (selection.files.length === 0) {
        return finish('selection', 'the repository selected no test files for this change at all — that is not a measurement');
      }
    }

    // A green `mc gate` already measured this exact tree with this exact
    // selection (`gate-greens.js`): the suite and the selected command gates
    // are not run again. The pull request's own tests and the declared gates
    // still are, below. Only a single pull request's round: a batch candidate
    // is a tree no session stood in, and `--full` asks for a measurement.
    const receiptContext = await bindReceiptRepository(askGit, repoPath, evidence === null ? null : { ...evidence,
      configuration: gateConfiguration(measured.declaration, plan.flags, executionIdentity(plan)) });
    let reused = null;
    if (selection && facts.pr && !batch) {
      const tree = trim((await askGit(['rev-parse', 'HEAD^{tree}'], { cwd: headDir })).stdout) || null;
      const green = findGreen({
        root, repo: repoNameOf(repoPath), tree, selection: selection.hash, version: GATE_MEASUREMENT_VERSION, evidence: receiptContext,
        checks: { ...selection, flags: plan.flags, execution: executionIdentity(plan) },
      });
      if (green) {
        const at = await askGit(['rev-parse', 'HEAD'], { cwd: headDir });
        reused = {
          ok: true,
          result: {
            commit: at?.status === 0 ? String(at.stdout || '').trim() : null, is, exit_code: 0, totals: null,
            red: [], red_files: [], red_tests: [], selected: selection.files.length,
            killed_files: [], killed_red: [], cancelled_files: [], cancelled_red: [],
          },
        };
        report.reused = { mode: 'exact', at: green.at ?? null, session: green.session ?? null };
        say(`the candidate's tree ${tree.slice(0, 7)} was measured green by mc gate at ${green.at} with the same selection — not measured again`);
      }
    }

    // No exact match: main moved since the session's `mc gate`, as it does on
    // almost every round (11 hits in 513). Ruling 47 reuses the green measured
    // on the pull request's own head tree and runs only what can have changed
    // verdict. Sound exactly as far as the selector is, which every round
    // already trusts for every test it does not select:
    //
    //  - a test reached only by the pull request's diff was measured green on
    //    the pull request's tree, and main's movement touches nothing the
    //    selector says reaches it;
    //  - a test reached only by main's movement was measured green when those
    //    pull requests landed;
    //  - only a test reached by both — or newly selected on the candidate —
    //    can change verdict, and those are what run.
    //
    // Anything that goes wrong on the way is a fallback to the whole
    // selection, never a green.
    let rerun = null;
    if (selection && facts.pr && !batch && !reused && declared.declaration.select_changed_path) {
      const delta = await timed('delta', () => deltaFromGreen({
        git: askGit, cwd: headDir, root, repo: repoNameOf(repoPath), headSha: facts.pr.head_sha,
        baseCommit: report.base.commit, derived: report.derived?.commit ? report.derived.regenerated : [],
        command: declared.declaration.select, env, selection, evidence: receiptContext,
      }));
      if (delta.kind === 'fallback') {
        say(`delta reuse not taken — ${delta.reason}; measuring the whole selection`);
      } else if (delta.kind === 'reuse') {
        const { green } = delta;
        report.reused = {
          mode: 'delta', at: green.at ?? null, session: green.session ?? null,
          delta_paths: delta.paths.length, rerun_files: delta.files.length, rerun_commands: delta.commands.map((entry) => entry.packageScript),
        };
        const head = String(facts.pr.head_sha || '').slice(0, 7);
        if (!delta.files.length && !delta.commands.length) {
          const at = await askGit(['rev-parse', 'HEAD'], { cwd: headDir });
          reused = {
            ok: true,
            result: {
              commit: at?.status === 0 ? String(at.stdout || '').trim() : null, is, exit_code: 0, totals: null,
              red: [], red_files: [], red_tests: [], selected: selection.files.length,
              killed_files: [], killed_red: [], cancelled_files: [], cancelled_red: [],
            },
          };
          say(`#${facts.pr.number}'s head ${head} was measured green by mc gate at ${green.at}; main moved ${delta.paths.length} path${delta.paths.length === 1 ? '' : 's'} since, reaching none of the ${selection.files.length} selected file${selection.files.length === 1 ? '' : 's'} — not measured again`);
        } else {
          rerun = { files: delta.files, commands: delta.commands };
          say(`#${facts.pr.number}'s head ${head} was measured green by mc gate at ${green.at}; main moved ${delta.paths.length} path${delta.paths.length === 1 ? '' : 's'} since — running ${delta.files.length} of the ${selection.files.length} selected file${selection.files.length === 1 ? '' : 's'} and ${delta.commands.length} of ${selection.commands.length} command gate${selection.commands.length === 1 ? '' : 's'} again`);
        }
      }
    }
    // What the run below measures: the whole selection, or the delta's part.
    const runFiles = rerun ? rerun.files : selection?.files;
    const runCommands = rerun ? rerun.commands : selection?.commands;
    // A delta that reaches command gates and no test file: the files half is
    // the recorded green, not an empty run (which reports no tests and stops).
    const greenFiles = rerun && !rerun.files.length ? {
      ok: true,
      result: {
        commit: trim((await askGit(['rev-parse', 'HEAD'], { cwd: headDir })).stdout) || null, is, exit_code: 0, totals: null,
        red: [], red_files: [], red_tests: [], selected: 0,
        killed_files: [], killed_red: [], cancelled_files: [], cancelled_red: [],
      },
    } : null;

    // Gates follow the suite, never overlap its lanes (Martin, 2026-11-09).
    // The immutable base commit still reaches every command.
    const after = reused || greenFiles || (selection
      ? await timed('suite', () => measureSelected({ tests: runTests, git: askGit, cwd: headDir, files: runFiles, flags, say, is, signal }))
      : await timed('suite', () => measure({ suite: runSuite, git: askGit, cwd: headDir, command: commandLine.run, say, is })));
    const selectedGates = !reused && runCommands?.length ? await runSelectedCommands({
      commands: runCommands, cwd: headDir, env, mode: gateMode, baseRef: report.base.commit || baseRef, say, timed, clock, shell: trackedCommand,
      docker: dockerIo, holderPid, dockerLabel, root, signal,
    }) : [];
    if (signal?.aborted) {
      if (stalled) return finish('stalled', stallReason);
      return finish('gone', abortReason(signal));
    }
    report.extra_gates.push(...selectedGates);
    const gateInterrupted = gate => gate.exit_code === 124 || Boolean(gate.signal);
    const queueGate = gate => {
      if (!report.unmeasured.gates.includes(gate.name)) report.unmeasured.gates.push(gate.name);
    };
    selectedGates.filter(gateInterrupted).forEach(queueGate);
    let failedGates = selectedGates.filter(gate => !gate.ok && !gateInterrupted(gate));

    // The suite and every selected gate have now finished; a process bound is stalled.
    if (!after.ok) return finish(after.stalled ? 'stalled' : 'suite', `the run ${after.reason}${after.stalled ? `; files in flight: ${nameSome(pendingFiles()) || 'none named'}; load ${loadavg()[0]}` : ''}`);
    report.candidate = after.result;
    if (!facts.pr) recordMainRed({ root, repo: repoPath, commit: report.base.commit, result: after.result });
    // The measured tree's own hash, so a landing can later prove — not
    // assume — that main became exactly what was measured (track 3's
    // correction, 2026-08-23: "verified together" and "landed one at a
    // time" are two different claims, and only the first was measured).
    report.candidate.tree = trim((await askGit(['rev-parse', 'HEAD^{tree}'], { cwd: headDir })).stdout) || null;

    // Both halves have finished before reading standing main-red evidence.
    if (!reused) say(`${after.result.red.length} red`);
    if (after.result.red.length) {
      const stop = await stopRed(after.result);
      // The red names every gate that failed after the tests, so the session it goes to fixes them in one go (memoro #14169, 2026-10-24).
      if (stop?.stopped_at === 'red' && failedGates.length) stop.reason = `${stop.reason} — and ${failedGatesText(failedGates)}`;
      if (stop) return stop;
    }

    // Failed only in command gates declared to flip under load (ruling 44
    // § 5): those run once more, alone now the suite is done. All green, and
    // the round goes on with the flip recorded; otherwise red as below, on
    // the ones that failed again.
    if (failedGates.length && failedGates.every((gate) => retry.gates.includes(gate.name))) {
      const names = failedGates.map((gate) => gate.name);
      say(`only ${names.join(', ')} failed, declared retry_once — running ${names.length === 1 ? 'it' : 'them'} once more alone`);
      const again = await runSelectedCommands({
        commands: selection.commands.filter((entry) => names.includes(entry.packageScript)),
        cwd: headDir, env, mode: gateMode, baseRef: report.base.commit || baseRef, say, clock, shell: trackedCommand,
        docker: dockerIo, holderPid, dockerLabel, root, signal,
        timed: (step, fn) => timed('retry once', fn),
      });
      for (const gate of failedGates) {
        const second = again.find((one) => one.name === gate.name);
        gate.retry = second ? { ok: second.ok, exit_code: second.exit_code, duration_ms: second.duration_ms } : null;
      }
      failedGates = failedGates.filter((gate) => !gate.retry?.ok);
      if (!failedGates.length) {
        report.flipped = { ...(report.flipped || {}), gates: names };
        say(`green alone — ${names.join(', ')} flipped under load, not this round's red`);
      }
    }

    // A command gate the selection chose is a contract about this diff, and a
    // change that breaks one is red whatever its tests did. They all ran; the
    // stop names every one that failed rather than the first.
    if (failedGates.length) {
      return finish('selected-gate', failedGatesText(failedGates));
    }

    // The pull request's own tests (D-0157). The suite answers "did anything
    // else break?"; this answers "is this change proved?" — and a suite that
    // globs some directories and not others had answered neither for a PR
    // whose tests lived in one it did not glob: the same count as the day
    // before, with 114 new test lines. So every `*.test.js` the PR adds or
    // changes is run, wherever it lies, from the same diff that counts red.
    // A list of directories would fix yesterday's hole and make tomorrow's.
    if (facts.pr && !batch) {
      const own = await timed('pr tests', async () => ownTests({
        tests: runTests, cwd: headDir, changed: await changedBy('HEAD'), say, flags, classify: classifyUnmeasured,
      }));
      report.pr_tests = own.result;
      if (!own.ok) return finish(own.stalled ? 'stalled' : 'pr-tests', own.reason);
    } else if (batch) {
      // Each pull request's own tests, by itself: the files *it* adds or
      // changes against the base, run on the batch candidate. The suite ran
      // once for all of them; this is what keeps the batch from hiding which
      // pull request carried which test, and a red here names the one.
      for (const [index, item] of all.entries()) {
        say(`#${item.number}'s own tests`);
        const own = await timed('pr tests', async () => ownTests({
          tests: runTests, cwd: headDir, changed: await changedBy(item.head_sha), say, flags, classify: classifyUnmeasured,
        }));
        report.prs[index].pr_tests = own.result;
        if (!own.ok) return finish(own.stalled ? 'stalled' : 'pr-tests', `#${item.number}: ${own.reason}`);
      }
    }

    // Additional gates an operator declared, run on the candidate.
    //
    // They ran on both sides until 2026-08-31 and were judged by the delta,
    // for the reason the suite was: an extra gate run only on the candidate
    // had attributed a red main to the one PR in the room (#10909's round,
    // 2026-08-24). That protection is gone with the baseline, deliberately —
    // the ruling is that main's own red is not the round's question, and a
    // declared gate that is red on main is red here.
    //
    // The gates run in an environment that asks node's test runner for TAP,
    // the way the suite already does: node 24 writes its spec reporter to a
    // pipe (measured 2026-08-24 — `# tests` never appears), so without this
    // the red names silently degrade to exit codes on every gate that is a
    // node test. A command that is not node ignores the variable.
    const gates = declared.declaration.extra_gates || [];
    const gateEnv = { ...env, MC_GATE_ROUND: gateMode };
    delete gateEnv.NODE_TEST_CONTEXT;
    gateEnv.NODE_OPTIONS = `${String(env.NODE_OPTIONS || '').replace(/--test-reporter(-destination)?[=\s]\S+/gu, '').trim()} --test-reporter=tap`.trim();
    for (const gate of gates) {
      say(`extra gate ${gate.name}`);
      const outcome = await timed('extra gates', () => trackedCommand(gate.command, { cwd: headDir, env: gateEnv, signal }));
      const head = gateSide(outcome);
      report.extra_gates.push({
        // What an operator declared, as opposed to what the
        // repository's selector chose for this diff.
        source: 'declaration',
        name: gate.name,
        command: gate.command,
        ok: head.ok,
        exit_code: head.exit_code,
        ...(outcome.signal ? { signal: outcome.signal } : {}),
        ran: head.ran,
        // The red names when the gate printed TAP that finished, null when it
        // did not — the difference between "these failed" and "it failed".
        red: head.red,
        output: trim(outcome.stderr) || trim(outcome.stdout) || null,
      });
      if (gateInterrupted(report.extra_gates.at(-1))) { queueGate(report.extra_gates.at(-1)); continue; }
      if (!head.ran) return finish('extra-gate', `${gate.name} could not be run at all — that is not an approval`);
      if (!head.ok) {
        return finish('extra-gate', `${gate.name} failed (${trim(outcome.stderr) || `exit ${head.exit_code}`})`
          + (head.red?.length ? ` — ${head.red.length} red: ${nameSome(head.red)}` : ''));
      }
    }

    // The alone phase: every interruption is resolved here, serially. This
    // override is execution policy, not a loosening of the declaration floor.
    const aloneFlags = [...withoutConcurrency(withoutTimeouts(plan.flags)), `--test-timeout=${TEST_TIMEOUT_MS}`];
    const alonePlan = { ...resolveTestPlan({ flags: aloneFlags }), concurrencyDeclared: false };
    for (const file of report.unmeasured.files) {
      let kills = report.killed_files?.some(one => one.file === file) ? 1 : 0;
      for (;;) {
        const from = clock();
        const argv = nodeTestArgv({ plan: alonePlan, files: [file], lanes: 1, stdioBlocking: STDIO_BLOCKING });
        const ran = await timed('alone', () => measureSelected({
          tests: options => runTests({ ...options, flags: alonePlan.flags, plan: alonePlan, lanes: 1, env: { ...env, MC_TEST_LANES: '1' } }),
          git: askGit, cwd: headDir, files: [file], flags: alonePlan.flags, say, is, signal,
        }));
        const killed = Boolean(ran.result?.killed_files?.length);
        const row = { file, outcome: killed ? 'killed' : !ran.ok || ran.result.red.length ? 'failed' : 'passed', seconds: (clock() - from) / 1000, argv: ran.result?.batches?.[0]?.argv || argv };
        report.alone.files.push(row);
        progressed();
        if (killed) {
          if (++kills >= 3) return finish('stalled', `${file} killed from outside three times; load ${loadavg()[0]}`);
          continue;
        }
        if (!ran.ok) return finish(ran.stalled ? 'stalled' : 'red', `${file}: ${ran.reason}`);
        recordTooSlow({ root: workRoot(env), repo: lane, where: timesOf.where, tests: measuredTests });
        if (ran.result.red.length) {
          const stop = await stopRed(ran.result, { alone: true, measuringAlone: true });
          if (stop) { report.candidate = { ...ran.result, tree: report.candidate.tree }; return stop; }
        }
        break;
      }
    }
    for (const name of report.unmeasured.gates) {
      const original = report.extra_gates.find(gate => gate.name === name);
      let kills = 0;
      for (;;) {
        const from = clock();
        const [ran] = await runSelectedCommands({
          commands: [{ packageScript: name, ...selection?.commands?.find(entry => entry.packageScript === name),
            ...(original.source === 'declaration' ? { command: original.command } : {}) }],
          cwd: headDir, env, mode: gateMode, baseRef: report.base.commit || baseRef, say, timed, clock, shell: trackedCommand,
          docker: dockerIo, holderPid, dockerLabel, root, signal,
        });
        report.alone.gates.push({ name, outcome: gateInterrupted(ran) ? 'unmeasured' : ran.ok ? 'passed' : 'failed', seconds: (clock() - from) / 1000 });
        progressed();
        if (gateInterrupted(ran)) {
          if (++kills >= 2) return finish('stalled', `${name} interrupted three times; load ${loadavg()[0]}`);
          continue;
        }
        if (!ran.ok) return finish('selected-gate', failedGatesText([ran]));
        break;
      }
    }
    return finish(null, null);
  } catch (error) {
    if (error instanceof RoundAborted && stalled) return finish('stalled', stallReason);
    if (error instanceof RoundAborted) return finish('gone', error.message);
    throw error;
  } finally {
    cancelCeiling();
    cancelStall();
    for (const signal of caught) process.off(signal, onSignal);
    // Always, and last. A round that died half way through must not leave the
    // repository held by a session that is no longer running — but a round
    // running inside somebody else's lease gives back nothing, because the
    // holder is still using it.
    if (holdLease) {
      releaseLease({ repoPath, holder, root });
      say('lease released');
    }
    // And the round lock, only if this round wrote it, and only while it is
    // still ours — see releaseGateLock.
    if (ownGateLock) releaseGateLock({ root, lane });
  }
}

/**
 * What the round decided, as one word.
 *
 * Three of them, and no more. `no-new-red` was the differential form's pass —
 * "no dirtier than the branch it is aimed at" — and it took a second worktree
 * and half the round's wall clock to be able to say. A round now measures one
 * tree, so a pass is a pass: `green`.
 *
 * Anything a machine wants to branch on should branch on this rather than on
 * the prose.
 */
export function verdictFor(report) {
  if (report.stopped_at === 'red') return 'red';
  // A contract gate this change breaks is red, and the word a reader acts on
  // should not depend on whether a test or a command found it.
  if (report.stopped_at === 'selected-gate') return 'red';
  // A generator that writes outside what it declared is the change's to fix.
  if (report.stopped_at === 'derived-outside') return 'red';
  // So is a project log row its tree carries twice.
  if (report.stopped_at === 'project-log') return 'red';
  if (report.stopped_at !== null) return 'stopped';
  return 'green';
}

/**
 * The verdict as a headline.
 *
 * It used to carry a number — the standing red on the base — because "GREEN"
 * over fifty-five red names was the larger claim read out of the smaller one.
 * The round no longer measures the base, so there is no number to carry and no
 * second reading to guard against: green is green. What ran is a count on the
 * line under it, not a clause in here (2026-08-31).
 *
 * Except the red it went on past (ruling 44 § 4): test files red on main and
 * untouched by the change are not counted, and a green that does not say so
 * reads as a suite that passed.
 */
export function verdictHeadline(report) {
  const mainRed = report.main_red_files?.length || 0;
  const partly = report.reused?.mode === 'delta' && (report.reused.rerun_files || report.reused.rerun_commands?.length);
  return `GREEN — the test gate passes${scopeOf(report)}${report.reused ? (partly ? ' (the rest measured by mc gate)' : ' (measured by mc gate)') : ''}`
    + (mainRed ? ` — ${mainRed} test file${mainRed === 1 ? '' : 's'} red on main, not counted` : '');
}

/** The same statement mid-sentence, for a round that is narrating itself. */
export function verdictPhrase(report) {
  return `gate green${scopeOf(report)}`;
}

/**
 * How far the verdict reaches — the one clause of it a reader must act on.
 *
 * It used to carry the number too: *"measured over the 17 test files this
 * change reaches, not the whole suite"*. The number is still in the verdict,
 * as a count on the line saying what ran (`ranPhrase` in `commands/repo.js`),
 * which meets ruling 4's second condition without the prose around it. Ruled
 * 2026-08-31: the sentence was the part a reader had to weigh.
 *
 * What is left is an admission, and it stays because it changes what to do
 * with the verdict. A selector that gave up and returned everything must not
 * read as a narrow measurement — "the 258 files this change reaches" when 258
 * is the whole suite is true and misleading in the same breath. `--full` says
 * so for the same reason from the other side: it measured a branch, not a
 * change.
 */
function scopeOf(report) {
  // The command is on the `--full` line because "the whole suite" is now a
  // claim mc can be wrong about: it was `npm test` by assumption, and for one
  // of the two repositories mc knows that ran six files. Naming the command
  // makes the claim checkable from the verdict alone.
  if (report.full) {
    const command = report.full_suite?.command;
    return ` — over the whole suite, asked for by --full${command ? ` (${command})` : ''}`;
  }
  if (report.selection?.full_suite) return ' — over the whole suite: the selector could not narrow this change';
  return '';
}

/**
 * The whole suite, run once, with what failed read out of it.
 *
 * A run that never printed its totals did not finish — it died on a missing
 * dependency, a syntax error, a killed process — and its empty red set would
 * read as a clean sweep. With one side and nothing to compare against, that is
 * the whole verdict, so an unfinished run stops the round rather than counting
 * as evidence.
 */
async function measure({ suite, git, cwd, command, say, is }) {
  const at = await git(['rev-parse', 'HEAD'], { cwd });
  const run = await suite({ cwd, command, onLine: (line) => say(line) });
  if (run.aborted) return { ok: false, aborted: true, reason: 'was stopped before it finished' };
  const totals = tapTotals(run.tap);
  if (run.timedOut) return { ok: false, stalled: true, reason: `ran past ${Math.round(run.timeoutMs / 60_000)} min and was stopped — a test that never ends` };
  const cut = unexplainedCuts(run, null, cwd);
  if (cut.length) return { ok: false, reason: cutReason(cut) };
  if (!totals.finished) {
    return { ok: false, reason: 'never reached its own summary — the suite did not run to the end' };
  }
  if (!totals.tests) return { ok: false, reason: 'reported no tests at all' };
  return {
    ok: true,
    result: {
      // The commit of the throwaway worktree the run happened in — for a pull
      // request that is its head with the base merged into it, which is a
      // commit that exists nowhere but here and is easily mistaken for the
      // branch head. `is` says which one it is so nothing has to be inferred.
      commit: at?.status === 0 ? String(at.stdout || '').trim() : null,
      is,
      exit_code: run.code,
      totals,
      red: redNames(run.tap),
      // Each red test's failure, cut out of the run for whoever fixes it.
      red_tests: redTests(run.tap, null, { cwd }),
      // No file list to name them by: the locations as node wrote them.
      ...killedOf(run.tap, null),
    },
  };
}

/**
 * The test files this change reaches, and the command gates beside them, asked
 * of the repository.
 *
 * The command prints JSON carrying a `files` array; anything else is a stop
 * rather than an empty list, because an empty list and a list that could not be
 * read look identical to a comparison and only one of them is a measurement.
 *
 * `commands` is the other half of the same answer and was thrown away until
 * 2026-08-31: memoro's selector reported six of them on #11158 — i18n three
 * times, `sdk:check`, `css:lint`, `css:tokens`, 20.0 s in all — and no round
 * had run one since `select` was declared. A gate that reads half a selection
 * and reports a verdict is a gate that lies about what it checked.
 *
 * Run in the candidate worktree, so the diff it computes is the pull request's.
 * `run` is how the command runs, `shell` (a child) unless a test hands one in.
 */
export async function selectFiles({ command, cwd, env, say, signal, mainOnly = [], run: runCommand = shell }) {
  const run = await runCommand(command, { cwd, env, signal, timeoutMs: suiteTimeoutMs(env) });
  if (run.status !== 0) {
    return { ok: false, reason: `${command} failed in the candidate — ${trim(run.stderr) || run.error?.code || `exit ${run.status}`}` };
  }
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch {
    return { ok: false, reason: `${command} did not print JSON — a selection that cannot be read is not a selection` };
  }
  const files = parsed?.files;
  if (!Array.isArray(files)) {
    return { ok: false, reason: `${command} printed JSON with no \`files\` array` };
  }
  // What the repository measures on main only leaves a pull request's selection,
  // unless it is all that was selected: a gate that measures nothing says nothing.
  const named = files.map(String).filter(Boolean);
  const pullRequest = named.filter((file) => !mainOnly.includes(file));
  const clean = pullRequest.length ? pullRequest : named;
  // A selector may say it gave up and returned everything. memoro-cli's does
  // that whenever a changed path is not source it can trace, and the round has
  // to repeat the admission rather than present the whole suite as a narrow
  // measurement — "measured over the 258 files this change reaches" is true and
  // reads as a saving when 258 is the entire suite.
  const full = parsed?.why?.reason === 'full-suite';

  // The gates the selector named. A repository that reports none has none —
  // that is memoro-cli's own selector, and an absent field is not a fault. A
  // `commands` that is not a list, or an entry with no script to run, is the
  // same kind of unreadable as a missing `files`: it stops, because running
  // fewer gates than the repository asked for is exactly the silence this
  // whole reading exists to end.
  const declaredCommands = parsed?.commands;
  if (declaredCommands !== undefined && !Array.isArray(declaredCommands)) {
    return { ok: false, reason: `${command} printed a \`commands\` field that is not a list — a gate list that cannot be read is not a gate list` };
  }
  const commands = (declaredCommands || []).map((entry) => ({
    id: entry?.id ? String(entry.id) : null,
    packageScript: entry?.packageScript ? String(entry.packageScript) : null,
    passBaseRef: Boolean(entry?.passBaseRef),
    resourceClass: entry?.resourceClass ? String(entry.resourceClass) : null,
    selectedBy: Array.isArray(entry?.selectedBy) ? entry.selectedBy.map(String) : [],
    // The exit code the selector says means "this gate's environment is
    // missing here" (memoro #13803: `sql:reference:postgres` without Docker
    // exits 69). Null for every gate that did not declare one.
    unavailableExitCode: entry?.allowUnavailable && Number.isInteger(entry?.unavailableExitCode) ? entry.unavailableExitCode : null,
    // What the gate needs from the machine (memoro's selector: `needs: ['docker']`).
    // Empty for every gate that says nothing.
    needs: Array.isArray(entry?.needs) ? entry.needs.map(String) : [],
  }));
  const nameless = commands.filter((entry) => !entry.packageScript);
  if (nameless.length) {
    return {
      ok: false,
      reason: `${command} named ${nameless.length} command gate${nameless.length === 1 ? '' : 's'} with no packageScript — `
        + 'mc cannot run what the selection did not name, and skipping it would be a green over an unchecked contract',
    };
  }

  say(`selection read from ${command}${full ? ' — it fell back to the whole suite' : ''}`
    + (commands.length ? `, with ${commands.length} command gate${commands.length === 1 ? '' : 's'}: ${commands.map((entry) => entry.packageScript).join(', ')}` : ''));
  // The lane each file runs in, as the selector classifies it (memoro's
  // `resourceClasses`: standard, sqlite, heavy). Absent, every file is standard.
  const classes = plainObject(parsed?.resourceClasses)
    ? Object.fromEntries(Object.entries(parsed.resourceClasses).filter(([, value]) => typeof value === 'string'))
    : {};
  // The bytes the selector printed and the parsed whole, kept before any of the
  // normalisation above: `raw.content` is every field the selector said, `files`
  // and `commands` are only what this gate runs. `mainOnlyExcluded` is what the
  // pull-request filter took out, so the execution plan can say so.
  const text = String(run.stdout);
  const raw = { text, sha256: createHash('sha256').update(text).digest('hex'), content: parsed };
  const mainOnlyExcluded = pullRequest.length ? named.filter((file) => mainOnly.includes(file)) : [];
  return { ok: true, files: clean, commands, full, why: parsed?.why ?? null, hash: selectionHash(parsed), classes, raw, mainOnlyExcluded };
}

/** A caller's binding is not a substitute for the repository Git actually
 * opened. Missing/foreign identity disables receipt reuse, never measurement. */
async function bindReceiptRepository(git, cwd, evidence) {
  if (evidence === null) return null;
  let repository = null;
  try {
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
    if (common?.status === 0) repository = realpathSync(trim(common.stdout));
  } catch { /* unknown repository identity cannot reuse evidence */ }
  return { ...evidence, repository: repository && repository === evidence.repository ? repository : null };
}

/** More delta paths than this and the selector is not asked: the command line would be the risk. */
export const DELTA_PATHS_MAX = 4000;

/**
 * What a green `mc gate` on the pull request's own head tree leaves to run on
 * the candidate (ruling 47), as one of:
 *
 *  - `{ kind: 'none' }` — no such green, or one measured from a base main
 *    does not descend from: the round measures as it always did;
 *  - `{ kind: 'fallback', reason }` — the green is there, but something on
 *    the way failed: the round measures as it always did, and says why;
 *  - `{ kind: 'reuse', green, paths, files, commands }` — the delta paths
 *    (what main changed since `green.base`, and what the derived commit
 *    regenerated), and the selected files and command gates to run again:
 *    the candidate's selection reached by the delta too, or not measured by
 *    the green at all. Both empty means nothing needs running.
 *
 * The delta's reach is asked of the repository's own selector, the declared
 * `select` with ` --changed-path <p>` per path, read like `selectFiles`, and
 * run by `run` as there.
 */
export async function deltaFromGreen({ git, cwd, root, repo, headSha, baseCommit, derived = [], command, env, selection, evidence = null, run: runCommand = shell }) {
  if (!headSha || !baseCommit) return { kind: 'none' };
  const tree = await git(['rev-parse', `${headSha}^{tree}`], { cwd });
  const headTree = tree?.status === 0 ? trim(tree.stdout) : null;
  if (!headTree) return { kind: 'fallback', reason: `could not read the tree of ${String(headSha).slice(0, 7)}` };
  evidence = await bindReceiptRepository(git, cwd, evidence);
  const green = findGreenForHead({ root, repo, headTree, version: GATE_MEASUREMENT_VERSION, evidence });
  if (!green) return { kind: 'none' };
  const ancestor = await git(['merge-base', '--is-ancestor', green.base, baseCommit], { cwd });
  if (ancestor?.status === 1) return { kind: 'fallback', reason: `the green's base ${green.base.slice(0, 7)} is not an ancestor of ${baseCommit.slice(0, 7)}` };
  if (ancestor?.status !== 0) return { kind: 'fallback', reason: `git could not say whether ${green.base.slice(0, 7)} is an ancestor of ${baseCommit.slice(0, 7)}` };
  const diff = await git(evidence === null
    ? ['diff', '--name-only', green.base, baseCommit]
    : ['diff', '--name-only', '--no-renames', '-z', green.base, baseCommit], { cwd });
  if (diff?.status !== 0) return { kind: 'fallback', reason: `git could not diff ${green.base.slice(0, 7)}..${baseCommit.slice(0, 7)}` };
  const paths = [...new Set([
    ...(evidence === null ? String(diff.stdout || '').split('\n').map((line) => line.trim())
      : String(diff.stdout || '').split('\0')).filter(Boolean),
    ...(derived || []).map(String).filter(Boolean),
  ])].sort();

  // What the green measured, against what the candidate selects. A file or a
  // command gate it never ran is run whatever the delta reaches.
  const measuredFiles = new Set(green.files.map(String));
  const commandKey = evidence === null ? (entry) => entry.packageScript : commandIdentity;
  let measuredCommands;
  try {
    measuredCommands = evidence === null
      ? new Set((Array.isArray(green.commands) ? green.commands : []).map(String))
      : new Set(JSON.parse(readFileSync(green.receipt, 'utf8')).coverage.commands.map(commandIdentity));
  } catch { return { kind: 'fallback', reason: 'the measured receipt is no longer readable' }; }
  const fresh = (reached) => ({
    files: selection.files.filter((file) => reached.files.has(file) || !measuredFiles.has(file)),
    commands: selection.commands.filter((entry) => reached.commands.has(entry.packageScript) || !measuredCommands.has(commandKey(entry))),
  });
  if (!paths.length) return { kind: 'reuse', green, paths, ...fresh({ files: new Set(), commands: new Set() }) };
  if (paths.length > DELTA_PATHS_MAX) return { kind: 'fallback', reason: `main moved ${paths.length} paths since the green, more than ${DELTA_PATHS_MAX} to hand the selector` };

  const asked = `${command}${paths.map((path) => ` --changed-path ${shellQuote(path)}`).join('')}`;
  let run = null;
  try { run = await runCommand(asked, { cwd, env }); } catch (error) {
    return { kind: 'fallback', reason: `the selector could not be run for the delta (${error.message})` };
  }
  if (run?.status !== 0) {
    return { kind: 'fallback', reason: `the selector failed for the delta — ${trim(run?.stderr) || run?.error?.code || `exit ${run?.status}`}` };
  }
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch { return { kind: 'fallback', reason: 'the selector printed no JSON for the delta' }; }
  if (!Array.isArray(parsed?.files)) return { kind: 'fallback', reason: 'the selector printed no `files` array for the delta' };
  if (parsed.commands !== undefined && !Array.isArray(parsed.commands)) {
    return { kind: 'fallback', reason: 'the selector printed a `commands` field that is not a list for the delta' };
  }
  if (evidence !== null && (parsed.full || parsed.files.some((file) => typeof file !== 'string' || !file)
    || (parsed.commands || []).some((entry) => !entry?.packageScript))) {
    return { kind: 'fallback', reason: 'uncertain delta selection' };
  }
  const reached = {
    files: new Set(parsed.files.map(String).filter(Boolean)),
    commands: new Set((parsed.commands || []).map((entry) => String(entry?.packageScript ?? '')).filter(Boolean)),
  };
  return { kind: 'reuse', green, paths, ...fresh(reached) };
}

/** One argument for `sh -c`, single-quoted. */
function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/**
 * The command gates the selection named, run on the candidate and nowhere else.
 *
 * These are gates about the change rather than measurements of a tree:
 * `css:tokens` and `i18n:contract` take `--base-ref` and are differential in
 * themselves, so the base branch is a ref they are handed rather than a tree
 * anything is run in.
 *
 * Every one of them runs, and a failure does not end the loop. `ci.mjs` wrote
 * the reason down where it makes the same choice about tests: while anything
 * else is red, a skipped command gate hides every contract regression it would
 * have caught. Reported all, judged all.
 *
 * Invoked the way memoro's own `runPackageCommand` invokes them — `npm run
 * <packageScript>`, plus `-- --base-ref <ref>` when the selection said the
 * command takes one — so the gate runs the repository's command rather than an
 * approximation of it.
 */
async function runSelectedCommands({
  commands, cwd, env, baseRef, say, timed, clock, shell: run = commandShell,
  docker = null, holderPid = process.pid, dockerLabel = { run: null, repo: null }, root, signal = null, mode = 'merge',
}) {
  const results = [];
  // The one thing the round's environment must not carry in: node sets
  // NODE_TEST_CONTEXT inside a test run, and a command that inherits it
  // decides it is being required recursively and runs nothing at all — output
  // with no results and exit 0, which is the false green the whole module is
  // built to refuse. Everything else is the environment the round was given,
  // because that is what `runPackageCommand` passes.
  const commandEnv = { ...env, MC_GATE_ROUND: mode };
  delete commandEnv.NODE_TEST_CONTEXT;
  for (const entry of commands) {
    const invocation = entry.command || `npm run ${entry.packageScript}${entry.passBaseRef ? ` -- --base-ref ${baseRef}` : ''}`;
    // A gate that needs the container runtime is leased to this round before it
    // runs, and the lease goes back when it ends. A runtime that will not start
    // means the gate does not run: unavailable where the selector said it may
    // be, red where it did not.
    let up = null;
    if (docker && needsDocker(entry)) {
      say(`command gate ${entry.packageScript} needs docker — ensuring the runtime`);
      up = await timed('docker', () => docker.ensure({ pid: holderPid, run: dockerLabel.run, repo: dockerLabel.repo, root }));
      if (!up.ok) {
        const unavailable = entry.unavailableExitCode != null;
        results.push({
          source: 'selection',
          name: entry.packageScript,
          command: invocation,
          ok: unavailable,
          exit_code: 69,
          ran: false,
          ...(unavailable ? { unavailable: true } : {}),
          docker: up.reason,
          duration_ms: 0,
          resource_class: entry.resourceClass,
          selected_by: entry.selectedBy,
          output: `docker could not be started: ${up.reason}`,
        });
        say(`command gate ${entry.packageScript}: docker could not be started (${up.reason}) — ${unavailable ? 'unavailable on this machine, not counted red' : 'FAILED'}`);
        continue;
      }
    }
    say(`command gate ${entry.packageScript}`);
    const from = clock();
    const gateEnv = up
      ? { ...commandEnv, MC_DOCKER_HOLDER: String(holderPid), MC_DOCKER_RUN: dockerLabel.run || '', MC_DOCKER_REPO: dockerLabel.repo || '' }
      : commandEnv;
    let outcome;
    try {
      outcome = await timed('selected gates', async () => run(invocation, { cwd, env: gateEnv, signal }));
    } finally {
      if (up) docker.release(up.lease, { root });
    }
    const duration = clock() - from;
    const ran = outcome.status !== null && outcome.status !== undefined;
    // A gate the selector declared may be unavailable, exiting with exactly
    // that code: not a pass and not a red, but a gate this machine cannot run
    // (memoro's own `npm run ci` reads it the same way). It is reported as
    // unavailable and does not stop the round; under GitHub Actions the
    // repository's CI still fails on it.
    const unavailable = ran && entry.unavailableExitCode != null && outcome.status === entry.unavailableExitCode;
    results.push({
      // Which of the two kinds of gate this is. One list, because a reader
      // wants one list; the field is what tells an operator's declaration
      // apart from what the repository's selector chose for this diff.
      source: 'selection',
      name: entry.packageScript,
      command: invocation,
      ok: ran && (outcome.status === 0 || unavailable),
      exit_code: outcome.status ?? null,
      signal: outcome.signal || null,
      ran,
      ...(unavailable ? { unavailable: true } : {}),
      ...(up ? { docker: up.started ? 'started' : 'up' } : {}),
      duration_ms: duration,
      resource_class: entry.resourceClass,
      selected_by: entry.selectedBy,
      // The last thing it said, so a red gate names something. The full
      // output belongs in a log, not in a verdict.
      output: trim(outcome.stderr) || trim(outcome.stdout) || null,
    });
    const last = results[results.length - 1];
    say(`command gate ${entry.packageScript}: ${unavailable ? 'unavailable on this machine, not counted red' : last.ok ? 'passed' : `FAILED (exit ${last.exit_code})`} in ${seconds(duration)}`);
  }
  return results;
}

/**
 * The files the selection chose, run where the selection was asked for.
 *
 * Held to the suite's rule, and for the same reason — a run that never
 * summarised, or summarised nothing, is a stop rather than an approval. That
 * matters more here than for a full suite: a selected list is short enough that
 * "no tests ran" is an easy accident and an expensive one.
 */
async function measureSelected({ tests, git, cwd, files, flags, say, is, signal = null }) {
  const at = await git(['rev-parse', 'HEAD'], { cwd });
  const commit = at?.status === 0 ? String(at.stdout || '').trim() : null;
  const run = await tests({ cwd, files, flags, signal, onLine: (line) => say(line) });
  if (run.aborted) return { ok: false, aborted: true, reason: 'was stopped before it finished' };
  const totals = tapTotals(run.tap);
  if (run.timedOut) return { ok: false, stalled: true, reason: `ran past ${Math.round(run.timeoutMs / 60_000)} min and was stopped — a test that never ends` };
  const cut = unexplainedCuts(run, files, cwd);
  if (cut.length) return { ok: false, reason: cutReason(cut) };
  if (!totals.finished) {
    return { ok: false, reason: 'never reached its own summary — the selected files did not run to the end' };
  }
  if (!totals.tests) return { ok: false, reason: 'reported no tests at all' };
  return {
    ok: true,
    result: {
      commit, is, exit_code: run.code, totals, red: redNames(run.tap), red_files: redFiles(run.tap, files), selected: files.length,
      red_tests: redTests(run.tap, files), batches: run.batches || [],
      ...killedOf(run.tap, files),
    },
  };
}

/**
 * The files of a run something outside it killed, and the red names they
 * account for (`killed_red`), so the verdict can tell them from the change's.
 */
function killedOf(tap, files) {
  const killed = killedFiles(tap, files);
  // A killed file is the killer's: what it cancelled is not counted twice.
  const cancelled = cancelledFiles(tap, files).filter((file) => !killed.some((one) => one.file === file));
  return {
    killed_files: killed,
    killed_red: redNamesIn(tap, killed.map((one) => one.file)),
    cancelled_files: cancelled,
    cancelled_red: redNamesIn(tap, cancelled),
  };
}

/**
 * A killed file cannot finish its reporter output. Only a signal naming that
 * same file in the parent TAP explains its cut; every other incomplete file
 * still refuses measurement. Callers separately require nonempty TAP totals.
 */
function unexplainedCuts(run, files, cwd) {
  const killed = new Set(killedFiles(run.tap, files).map(one => resolve(cwd, one.file)));
  return (run.cut || []).filter(file => !killed.has(resolve(cwd, file)));
}

/**
 * The red files of a pull request's last recorded round (`gate-rounds.jsonl`),
 * or none: only when that round ended `red` and named them. A batch's line is
 * every pull request's red at once, so a last round that was a batch gives
 * none rather than another pull request's files.
 */
export function previousRedFiles({ root = mcHome(), repoPath, pr }) {
  const repo = repoNameOf(repoPath || '');
  const number = Number(pr);
  const last = readRounds({ root }).rounds
    .filter((round) => (round.phase === 'end' || !round.phase) && round.repo === repo && (round.prs || []).map(Number).includes(number))
    .at(-1);
  if (!last || last.prs.length !== 1 || last.stopped_at !== 'red' || !Array.isArray(last.red_files)) return [];
  return [...new Set(last.red_files.filter((file) => typeof file === 'string' && file))];
}

/** What a round says of the command gates the selection chose that failed: each by name and exit code. */
function failedGatesText(gates) {
  return `${gates.length} command gate${gates.length === 1 ? '' : 's'} the selection chose failed: `
    + `${gates.map((gate) => `${gate.name} (exit ${gate.exit_code})`).join(', ')}`;
}

/** Current producer: timeout-cancelled files with no other failure, not proof of overload.
 * `alone` renders historical reports only (retired 2026-11-04); no current caller supplies it. */
export function underLoadReason({ alone = [], cancelled = [] }) {
  const parts = [];
  if (alone.length) parts.push(`${alone.join(', ')} red in the round, green alone on the base and on the candidate`);
  if (cancelled.length) parts.push(`${cancelled.join(', ')} had tests cancelled and none failed`);
  return `${parts.join('; ')} — measured again`;
}

/**
 * What a pull request is, asked of the forge rather than assumed.
 *
 * Closed and merged ones are refused: a round against something already landed
 * measures nothing, and the answer it would give — green — is the one most
 * likely to be acted on.
 */
async function prFacts({ gh, git = null, repoPath, pr, say = () => {} }) {
  const asked = await gh(
    ['pr', 'view', String(pr), '--json', 'number,headRefName,baseRefName,headRefOid,state,title'],
    { cwd: repoPath },
  );
  if (asked.status !== 0) return { ok: false, reason: trim(asked.stderr) || `could not read #${pr}` };

  let raw = null;
  try { raw = JSON.parse(asked.stdout); } catch { return { ok: false, reason: `#${pr} came back as something other than JSON` }; }
  if (!raw?.headRefName || !raw?.baseRefName || !raw?.headRefOid) {
    return { ok: false, reason: `#${pr} did not say which branch it is` };
  }
  if (raw.state && raw.state !== 'OPEN') {
    return { ok: false, reason: `#${pr} is ${String(raw.state).toLowerCase()}, so there is nothing to gate` };
  }
  // The head as the branch actually stands, not as GitHub's API remembers
  // it. For some seconds after a push `headRefOid` is still the previous
  // commit, and a round started in that window measures the tree the push
  // replaced: on 2026-09-03 #11274, #11276 and #11275 each went red the
  // first time — the fix pushed a minute earlier was not in the candidate —
  // and green on the next round with nothing changed. `ls-remote` asks the
  // remote itself; an empty or failed answer leaves GitHub's word standing.
  let headSha = raw.headRefOid;
  if (git) {
    const remote = await git(['ls-remote', 'origin', `refs/heads/${raw.headRefName}`], { cwd: repoPath });
    const sha = remote.status === 0 ? String(remote.stdout || '').trim().split(/\s+/u)[0] : '';
    if (/^[0-9a-f]{40}$/u.test(sha) && sha !== headSha) {
      say(`#${pr} — GitHub still says ${headSha.slice(0, 7)}, origin/${raw.headRefName} is at ${sha.slice(0, 7)}: measuring the branch as pushed`);
      headSha = sha;
    }
  }
  return {
    ok: true,
    pr: {
      number: raw.number ?? Number(pr),
      head: raw.headRefName,
      base: raw.baseRefName,
      head_sha: headSha,
      title: raw.title ?? null,
    },
  };
}

/**
 * The repository's own definition of its whole suite — declared, or `npm test`.
 *
 * Still deliberately not mc's idea of how to run tests, and still deliberately
 * not a shorter command: what runs is what the repository means by "the
 * suite", so nobody keeps two definitions in agreement. What changed is where
 * that meaning is read from. `npm test` was taken as the whole suite by
 * assumption, and for memoro the assumption was false — its `npm test` is
 * `node scripts/testing/ci.mjs`, a diff-selector, and a `--full` round has no
 * diff, so it ran 6 files of 2,018 and summarised them as everything.
 *
 * So there are three answers, and the middle one is the point:
 *
 *  - a declared `suite` is the command, whichever of the three layers wrote
 *    it (`repo-gate-table.js`);
 *  - a declaration with `select` and no `suite` is a **stop**. A repository
 *    that declared a selector said, by declaring one, that `npm test` narrows
 *    — so mc has nothing honest to run for `--full` and says so, naming both
 *    fields. A stop is visible; a green off six files is not;
 *  - a declaration with neither keeps `npm test`, verbatim, exactly as before.
 *    Nothing claims to narrow there, so nothing can have narrowed it.
 *
 * `command` is for a reader and `run` is for the shell — for the `npm test`
 * answer they differ, because the script behind it is the part worth seeing.
 */
function suiteCommand({ repoPath, declaration = {}, root = mcHome() }) {
  const declared = typeof declaration.suite === 'string' && declaration.suite.trim()
    && declaration.suite !== UNKNOWN
    ? declaration.suite.trim()
    : null;
  if (declared) {
    return { ok: true, command: annotate(declared, repoPath), run: declared, source: 'declared' };
  }

  if (declaration.select) {
    return {
      ok: false,
      reason: `${repoNameOf(repoPath)} declares how it selects the tests a change reaches ("select": ${declaration.select}) `
        + 'but not what its whole suite is ("suite"), so --full has nothing to run. '
        + 'mc will not fall back to npm test here: a repository that declares a selector has already said that '
        + 'npm test narrows, and running it with no change to narrow against reports a handful of files as the whole tree. '
        + `Declare it where the fact belongs — in the repository, ${repoDeclarationPath(repoPath)}: `
        + '{"suite": "<command>", "suite_why": "<the measurement>"} '
        + `— or, if it is a fact about this machine, in ${tablePath(root)}: `
        + `{"${repoNameOf(repoPath)}": {"suite": "<command>", "suite_why": "<the measurement>"}}.`,
    };
  }

  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')); } catch { manifest = null; }
  const script = manifest?.scripts?.test;
  if (!script) return { ok: false, reason: `${repoPath} has no npm test script — the gate has no suite to run` };
  return { ok: true, command: `npm test  (${script})`, run: 'npm test', source: 'npm-test' };
}

/**
 * A command with the script behind it, when the command is an npm script.
 *
 * `npm run test:full` says nothing about what it runs, and what it runs is the
 * thing this whole step is about — memoro's `npm test` and `npm run test:full`
 * differ by 2,015 files and read the same. So the manifest is opened to say
 * so, for the reader only: `run` stays the command the declaration gave, and a
 * manifest that will not parse or names no such script just gives the command
 * back. This is where the `npm test  (…)` line the report has always carried
 * comes from, and a declared `npm test` still produces it byte for byte.
 */
function annotate(command, repoPath) {
  const named = /^npm\s+test$/u.test(command.trim())
    ? 'test'
    : (/^npm\s+run\s+(\S+)$/u.exec(command.trim())?.[1] ?? null);
  if (!named) return command;
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')); } catch { manifest = null; }
  const script = manifest?.scripts?.[named];
  return script ? `${command}  (${script})` : command;
}

/**
 * The branch origin itself calls its default, for a reading with no pull
 * request to name one.
 *
 * Read rather than assumed: `main` is this machine's habit, not a fact about
 * every repository, and `mc test <repo> --full` measuring the wrong branch
 * would be a whole-suite answer about a tree nobody asked about. A remote that
 * does not say gives null, and the round stops rather than guessing.
 */
async function defaultBaseRef({ git, repoPath }) {
  const asked = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath });
  const ref = asked?.status === 0 ? trim(asked.stdout) : '';
  return ref || null;
}

/**
 * The clause a red reason gains when some of its red was main's already.
 *
 * Said in the reason because that is the line a person reads first, and the
 * question it answers — "is this my change?" — is the first one they ask.
 */
export function mainRedClause(probe) {
  if (!probe?.red_on_main?.length) return '';
  const count = probe.red_on_main.length;
  const name = (found) => (found.pr ? `#${found.pr}` : found.commit.slice(0, 7));
  // A docs-only landing the walk measured twice is named like any other, and
  // said to have landed without the suite (2026-10-10, #13310); one whose
  // second measure disagreed is a flaky test and names nobody (2026-10-06,
  // #12727).
  const blamed = probe.breaks.filter((found) => found.kind !== 'flaky');
  const flaky = new Set(probe.breaks.filter((found) => found.kind === 'flaky').map((found) => found.file)).size;
  const landings = [...new Set(blamed.map(name))];
  const unsuited = [...new Set(blamed.filter((found) => found.kind === 'docs-only-landing').map(name))];
  const misses = blamed.filter((found) => found.kind === 'not-selected').length;
  return ` — ${count} of the red files ${count === 1 ? 'is' : 'are'} red on main too`
    + (landings.length ? `, broken by ${landings.join(', ')}` : '')
    + (misses ? ` (${misses === blamed.length ? 'its' : 'partly its'} selection did not reach ${misses === 1 ? 'it' : 'them'}: a selector miss)` : '')
    + (unsuited.length ? ` (${unsuited.join(', ')} changed only docs/ and landed without the suite)` : '')
    + (flaky ? ` — ${flaky} flaky under load` : '');
}

/** The round's environment with the selection state directory in it. */
export function selectionState(env, { root, repoPath, writes }) {
  const dir = selectionStateDir({ root, repoPath });
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* a selector without it selects as before */ }
  const next = { ...env, MC_SELECTION_STATE: dir };
  if (writes) next.MC_SELECTION_STATE_WRITE = '1';
  else delete next.MC_SELECTION_STATE_WRITE;
  return next;
}

/**
 * The selection state directory of a repository, by its primary checkout.
 * `mc gate` selects with the same one, so a session's selection is the
 * merger's (`gate-greens.js`).
 */
export function selectionStateDir({ root, repoPath }) {
  return join(root, 'selection', repoFileSlug(repoPath));
}

function seconds(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function trim(value) {
  return String(value || '').trim().split('\n').slice(0, 3).join(' ');
}

/**
 * The real suite run: `npm test`, streamed, with TAP asked for through the
 * environment.
 *
 * The reporter cannot be appended to the command — node reads `--test-reporter`
 * before the file patterns, so a flag added on the end is silently ignored, and
 * a gate whose output format depended on that would parse an empty red set out
 * of a perfectly red run. `NODE_OPTIONS` reaches the same setting without
 * touching the repository's own command, which is the property worth keeping:
 * what runs is exactly `npm test`.
 *
 * Streamed rather than collected at the end because this takes tens of
 * minutes, and a round that says nothing for forty minutes is one nobody can
 * tell from a hung one.
 */
/**
 * A declared command, run where the round needs it.
 *
 * Through a shell because declarations are written the way a person writes
 * them — `npm ci`, `npm run test:msr:contract` — and splitting those by hand
 * would be a second grammar to get wrong. The strings come from mc's own table
 * or from a file only the operator can write, which is the same trust boundary
 * the suite command already sits on.
 */
/** A test file, by the name people actually give them. */
const TEST_FILE = /\.test\.(?:js|mjs|cjs)$/u;

/**
 * The paths a pull request adds or changes against the base: `{ ok, files }`.
 *
 * `baseRef...head`: what the pull request changed since it left the base, not
 * what the base changed since — on a batch candidate, HEAD carries the other
 * pull requests' files too, and a plain two-dot diff would run them under this
 * one's name.
 */
async function prDiff({ git, cwd, baseRef, head = 'HEAD' }) {
  const diff = await git(['diff', '--name-only', '--diff-filter=AM', `${baseRef}...${head}`], { cwd });
  if (diff?.status !== 0) return { ok: false, files: [] };
  return { ok: true, files: String(diff.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean) };
}

/** How long an intake note or proposal about a red-on-main test keeps another from being written. */
export const RED_ON_MAIN_NOTE_DAYS = 7;

/**
 * An intake note for the helper about a test file red on main that a round
 * went on past (ruling 44 § 4) — or null when one is not written.
 *
 * One per file per week: a file at the top of `~/mc/intake/`,
 * `~/mc/proposals/` or a programme's `proposals/` (not its archive) younger
 * than seven days that names the test path is the
 * note already, whoever wrote it. The SQL snapshot tests were red in 77 rounds
 * of 43 pull requests; 77 notes would be the noise the round just stopped
 * making. Best effort: a note that cannot be written never changes a verdict.
 */
export function noteRedOnMain({ env = process.env, now = Date.now(), repo, file, names = [], breaks = [], prs = [] }) {
  try {
    const since = now - RED_ON_MAIN_NOTE_DAYS * 24 * 60 * 60 * 1000;
    const programmes = programmeNames(env).map((programme) => programmeProposalsDir(programme, env));
    for (const dir of [intakeDir(env), proposalsDir(env), ...programmes]) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(dir, entry.name);
        try {
          if (statSync(path).mtimeMs >= since && readFileSync(path, 'utf8').includes(file)) return null;
        } catch { /* unreadable: not a note about anything */ }
      }
    }
    const dir = intakeDir(env);
    mkdirSync(dir, { recursive: true });
    const stem = `${new Date(now).toISOString().slice(0, 10)}-red-on-main-${basename(file).replace(TEST_FILE, '')}`;
    let path = join(dir, `${stem}.md`);
    for (let n = 2; existsSync(path); n += 1) path = join(dir, `${stem}-${n}.md`);
    const landing = (found) => `${found.pr ? `#${found.pr} ` : ''}${String(found.commit || '').slice(0, 7)}`
      + `${found.kind ? ` (${found.kind})` : ''}${found.subject ? ` — ${found.subject}` : ''}`;
    writeFileSync(path, [
      `# ${file} is red on main`,
      '',
      `- repo: ${repo}`,
      `- file: \`${file}\``,
      `- found by: ${prs.map((number) => `#${number}`).join(', ') || 'a round with no pull request'} — the round went on past it: red on main too, and untouched by the change (ruling 44 § 4)`,
      `- broken by: ${breaks.length ? breaks.map(landing).join('; ') : 'the probe found no landing'}`,
      '',
      'Red:',
      ...(names.length ? names : ['(no test named)']).map((name) => `- ${name}`),
      '',
    ].join('\n'));
    return path;
  } catch {
    return null;
  }
}

/**
 * The pull request's own tests, run on the candidate.
 *
 * The files come from the same diff that counts red: what the PR adds or
 * changes against the base it is measured against (`--diff-filter=AM`, so a
 * deleted test is not asked to run). Held to the suite's rule — a run that
 * never summarised, or summarised nothing, is a stop, not an approval — and
 * one red among them stops the round even with the whole suite green, because
 * the suite never ran these and its green says nothing about them.
 *
 * A PR that touches no test file is recorded as exactly that, `files: []`,
 * and the round goes on: that fact belongs to the reviewer, not to the gate.
 */
async function ownTests({ tests, cwd, changed, say, flags = [], classify = null }) {
  if (!changed.ok) {
    return { ok: false, reason: 'could not list the files the pull request changes', result: null };
  }
  const files = changed.files.filter((line) => TEST_FILE.test(line));
  if (files.length === 0) {
    say('the pull request adds or changes no test file');
    return { ok: true, result: { files, totals: null, red: [], exit_code: null } };
  }
  // No declared flags and a test script the harvester cannot read is a
  // question the gate cannot answer — and it used to answer it anyway, in
  // silence: memoro's scripts.test became a wrapper (`node
  // scripts/testing/ci.mjs`), nodeTestFlags returned [] without a word,
  // and the round ran bare `node --test` with no loader. Nine files import
  // /js/ specifiers there; every PR touching one got red pr-tests that
  // were the gate's own (measured 2026-08-24: 2 FAIL bare, 30/30 with the
  // loader). Saying so is the ruling: silent-empty is the worst of the
  // three outcomes.
  if (flags.length === 0 && testScriptShape(cwd) === 'wrapper') {
    return {
      ok: false,
      reason: `the repository's test script is not a \`node --test\` line, so the gate cannot know which loaders these tests need — declare pr_tests_flags for this repository in the gate table (an override states every field it wants)`,
      result: { files, totals: null, red: [], exit_code: null },
    };
  }
  say(`running the pull request's own tests: ${files.length} file${files.length === 1 ? '' : 's'}`);
  if (flags.length) say(`pr tests run with the declared flags: ${flags.join(' ')}`);
  const run = await tests({ cwd, files, flags, onLine: (line) => say(`pr tests: ${line}`) });
  const totals = tapTotals(run.tap);
  let red = redNames(run.tap);
  const result = { files, totals, red, exit_code: run.code, red_files: redFiles(run.tap, files), red_tests: redTests(run.tap, files), ...killedOf(run.tap, files) };
  if (run.timedOut) return { ok: false, stalled: true, reason: 'own tests reached the process bound', result };
  if (classify && totals.finished && totals.tests && red.length) {
    classify(result);
    red = result.red;
  }
  const cut = unexplainedCuts(run, files, cwd);
  if (cut.length) return { ok: false, reason: cutReason(cut), result };
  if (!totals.finished) return { ok: false, reason: 'the pull request\'s own tests never reached their summary', result };
  if (!totals.tests) return { ok: false, reason: 'the pull request\'s own test files reported no tests at all', result };
  if (red.length) {
    const never = result.red_tests.filter(test => /timed out after\s+600000\s*ms/iu.test((test.error || []).join(' ')));
    if (never.length) return { ok: false, reason: `never ends: ${never.map(test => test.name).join(', ')}`, result };
    // Counted by the summary's own `# fail`, never by the number of red
    // names: a failing test reddens its parent suites too, so two failures
    // can carry three names — and "3 of the pull request's own tests" was
    // the gate answering with confidence a question it had miscounted
    // (2026-08-24). The names stay, said as names.
    const failed = totals.fail ?? red.length;
    return { ok: false, reason: `${failed} of the pull request's own tests ${failed === 1 ? 'is' : 'are'} red — the red names, parent suites included: ${red.slice(0, 3).join(', ')}${red.length > 3 ? ', …' : ''}${result.red_tests.length ? ` — ${result.red_tests.flatMap(test => test.error || []).join('; ')}` : ''}`, result };
  }
  return { ok: true, result };
}

/**
 * What kind of test script this repository has: a `node --test` line the
 * harvester below can read (`node-test`), something else (`wrapper` — a
 * runner like memoro's ci.mjs, whose loaders live where no heuristic
 * looks), or none at all.
 */
function testScriptShape(cwd) {
  let script = '';
  try {
    script = String(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts?.test || '');
  } catch { return 'none'; }
  if (!script) return 'none';
  return /^node\s+(?:.*\s)?--test(?:\s|$)/u.test(script) ? 'node-test' : 'wrapper';
}

/**
 * How the repository runs node tests, read from its own `test` script.
 *
 * A bare `node --test <file>` is not how every repository runs its tests:
 * this one needs `--import ./tests/_isolate-home.mjs` or its tests write into
 * the real home. So the flags the script gives node are kept — `--import`,
 * `--require`, `--conditions`, the experimental ones — and the globs are not,
 * since the files are the point. A script that is not a `node --test` line
 * gets bare `node --test`, and the report names the files either way.
 */
export function nodeTestFlags(cwd) {
  return scriptFlagsOf(testScriptOf(cwd));
}

/** The `test` script of the package at `cwd`, or null when there is none or it cannot be read. */
export function testScriptOf(cwd) {
  try {
    const script = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts?.test;
    return typeof script === 'string' && script.trim() ? script : null;
  } catch { return null; }
}

/**
 * The node flags a `node --test` script string carries, as `nodeTestFlags`
 * reads them off a package: the loaders and experimental options, and its one
 * `--test-timeout` as `--test-timeout=<ms>` (a script timeout that is not a
 * positive integer is dropped, and reads as no timeout). Empty when the script
 * is not a `node --test` line.
 */
export function scriptFlagsOf(script) {
  if (!nodeTestScript(script)) return [];
  const tokens = String(script).trim().slice(4).trim().split(/\s+/u);
  const flags = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    // The script's own per-test timeout is policy, not runner noise: kept,
    // the same way `mc gate`'s fallback keeps it (`scriptTimeoutAt`).
    const timeout = scriptTimeoutAt(tokens, i);
    if (timeout) { if (timeout.flag) flags.push(timeout.flag); i += timeout.length - 1; continue; }
    if (token === '--test' || !token.startsWith('--')) continue;
    if (token.startsWith('--test-reporter') || token.startsWith('--test-')) continue;
    if (token.includes('=')) { flags.push(token); continue; }
    flags.push(token);
    if (['--import', '--require', '--conditions', '-C', '--loader'].includes(token) && tokens[i + 1]) {
      flags.push(tokens[i + 1]);
      i += 1;
    }
  }
  return flags;
}

/**
 * The semantic test arguments of one `node --test` run, resolved once for every
 * consumer (the session's `mc gate`, the candidate round and the worker that
 * spawns the tests) — contract B of docs/technical/test-audits/timeout-enforcement-plan.md.
 *
 * - `flags`: the requested flags: the declared `pr_tests_flags` when any are
 *   declared, else the flags of the `test` script (`scriptFlagsOf`). Requested,
 *   not executed: what the receipt names as asked for.
 * - `timeout`: the effective per-test timeout `{ ms, source }`. `source` is
 *   `declaration` (the declared flags state it), `script` (the script states it
 *   and nothing is declared) or `default` (neither states one: Node would run
 *   without any per-test limit, so the round's own `TEST_TIMEOUT_MS` applies).
 * - `invalid`: a reason, when the declared flags state more than one timeout or
 *   one that is not a positive integer. An invalid plan spawns nothing. A script
 *   timeout that is not a positive integer is not a declaration: it is dropped,
 *   and the default applies.
 *
 * Node's `--test-timeout` is a default for each test and its hooks, not an
 * absolute cap on a file or on synchronous work (docs/technical/mc-merge.md).
 */
export function resolveTestPlan({ flags = [], script = null } = {}) {
  const declared = (Array.isArray(flags) ? flags : []).map(String);
  const requested = declared.length ? declared : scriptFlagsOf(script);
  const stated = timeoutValues(requested);
  let invalid = null;
  if (stated.length > 1) invalid = `${stated.map((value) => `--test-timeout=${value}`).join(' ')} — exactly one positive --test-timeout or none`;
  else if (stated.length === 1 && positiveMs(stated[0]) === null) invalid = `--test-timeout=${stated[0]} is not a positive number of milliseconds`;
  const timeout = stated.length === 1 && !invalid
    ? { ms: Number(stated[0]), source: declared.length ? 'declaration' : 'script' }
    : { ms: TEST_TIMEOUT_MS, source: 'default' };
  return { flags: requested, timeout, invalid, concurrencyDeclared: requested.some((flag) => flag.startsWith('--test-concurrency')) };
}

/**
 * What a receipt binds as the execution's stable identity: the effective
 * timeout with its provenance, that the run always forces its exit, and the
 * Node version that spawned it. Lanes (load-dependent) and reporter paths
 * (ephemeral) are not identity.
 */
export function executionIdentity(plan, nodeVersion = process.version) {
  return { timeoutMs: plan.timeout.ms, timeoutSource: plan.timeout.source, forceExit: true, nodeVersion };
}

/**
 * The argv one batch spawns: `--test`, the reporters, the lanes, the one
 * effective `--test-timeout`, `--test-force-exit`, the stdio helper, the
 * requested flags without their timeouts, then the files. The timeout always
 * precedes the file paths, and it is the only timeout Node is given.
 */
export function nodeTestArgv({ plan, files, lanes = 1, reporters = [], stdioBlocking }) {
  const concurrency = plan.concurrencyDeclared ? [] : [`--test-concurrency=${lanes}`];
  const forceExit = plan.flags.includes('--test-force-exit') ? [] : ['--test-force-exit'];
  return ['--test', ...reporters, ...concurrency, `--test-timeout=${plan.timeout.ms}`, ...forceExit,
    '--import', stdioBlocking, ...withoutTimeouts(plan.flags), ...files];
}

function withoutTimeouts(flags) {
  const kept = [];
  for (let i = 0; i < flags.length; i += 1) {
    const word = String(flags[i]);
    if (word.startsWith('--test-timeout=')) continue;
    if (word === '--test-timeout') { i += 1; continue; }
    kept.push(word);
  }
  return kept;
}

/** The alone phase owns its single lane, even if the declaration names concurrency. */
function withoutConcurrency(flags) {
  const kept = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--test-concurrency') { i++; continue; }
    if (!flags[i].startsWith('--test-concurrency=')) kept.push(flags[i]);
  }
  return kept;
}

/** The one `--test-timeout` an argv actually carries, in ms; null when it has none or more than one. */
export function executedTimeoutOf(argv) {
  const values = argv.filter((word) => String(word).startsWith('--test-timeout=')).map((word) => Number(String(word).slice('--test-timeout='.length)));
  return values.length === 1 && Number.isInteger(values[0]) && values[0] > 0 ? values[0] : null;
}

/**
 * How long a suite may run before the round stops it: an hour, or
 * `MC_GATE_SUITE_MINUTES`. Nothing bounded it before, and a test that never
 * ends held the light lane for two and a half hours on 2026-10-19 (memoro-cli
 * #1009, a runLoop test waiting for a STOP it never wrote) with no line in
 * the log, because the TAP's detail comes only when a file finishes. A run
 * stopped here never prints its summary, so the round stops on it rather than
 * counting it red (`measure`, `measureSelected`).
 */
/**
 * Historical limit, used until 2026-11-04 for the retired base-then-candidate
 * replay (`green_alone`). Kept for compatibility; no current round reads it.
 */
export const GREEN_ALONE_MAX = 3;

/** The fewest lanes a merge, check or full round runs its tests at (`testLanes`). */
export const MERGE_LANES_MIN = 4;

/**
 * How many test files a selected run takes at once. A session's gate (no
 * mode) takes the free cores: `cores - 1 - round(load1)`, between 2 and
 * `cores - 1`, so a gate started at load 40 on eight cores runs 2, not 7, and
 * does not starve the whole-tree readers that went red only under load
 * (gate-round-under-load).
 *
 * A merge, check or full round takes at least `MERGE_LANES_MIN`, never more
 * than `cores - 1`. Since 2026-10-19 every round had run at the free cores,
 * which with four step sessions holding the load at 10–16 on eight cores is
 * two lanes. Measured from the merger's log, 2026-10-20 to 24 (159 suite
 * runs): the standard batch took 178 s at the median (p90 377 s); the nightly
 * full suite, seven lanes and no sessions, runs five to eight times more tests
 * a second. The round is what every step waits for, so it gets a floor the
 * sessions' load cannot take away. Interrupted members run alone; a stalled round goes back in line.
 *
 * `MC_TEST_LANES` overrides both.
 */
export function testLanes({ cores = availableParallelism(), load = loadavg()[0], env = process.env, mode = null } = {}) {
  const set = Number(env.MC_TEST_LANES);
  if (Number.isInteger(set) && set > 0) return set;
  const most = Math.max(1, cores - 1);
  const free = Math.max(Math.min(2, most), Math.min(most, most - Math.round(Number(load) || 0)));
  if (!['merge', 'check', 'full'].includes(mode)) return free;
  return Math.min(most, Math.max(MERGE_LANES_MIN, free));
}

export function suiteTimeoutMs(env = process.env) {
  const minutes = Number(env.MC_GATE_SUITE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

/**
 * One test running longer than this is a hang, not load: it is reported red by
 * name ("test timed out after 600000ms") and the round goes on, instead of the
 * whole run's hour stopping it with no name (memoro #14067, 95 minutes, 2026-10-23).
 */
export const TEST_TIMEOUT_MS = 10 * 60_000;
export const ROUND_STALL_MS = 15 * 60_000;

/**
 * The environment a suite runs in: the caller's, without what belongs to the
 * caller alone. `NODE_TEST_CONTEXT` makes a suite think it is nested and skip
 * its files (`realSuite`). `MC_WORK_ROOT` and `MC_HOME` are the runner's own
 * `~/mc`: `tests/_isolate-home.mjs` points them at a throwaway directory only
 * when they are unset, so a round the merger started handed every test the
 * real programmes, and memoro-cli's runner tests queued the real projects
 * beside their fixture's (2026-10-19).
 */
export function suiteEnv(env) {
  const clean = { ...env };
  const home = env.MC_HOME;
  for (const key of ['NODE_TEST_CONTEXT', 'MC_WORK_ROOT', 'MC_HOME']) delete clean[key];
  // A test-started round must keep its model/counting shim first on PATH.
  const direct = env.MC_GIT_CALLS ? null : directGitDir({ home });
  if (direct && clean.PATH) clean.PATH = `${direct}:${clean.PATH}`;
  return clean;
}

/**
 * The toolchain's own git, once per process. Read from the two places Xcode
 * puts a developer directory (and `DEVELOPER_DIR` when set), not asked of
 * `xcode-select -p`: the merger's path starts no synchronous child
 * (child-async.test.js), and the answer is a path that exists or not.
 */
let developerGit;
function toolchainGit(env = process.env) {
  if (developerGit !== undefined) return developerGit;
  const roots = [env.DEVELOPER_DIR, '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer'].filter(Boolean);
  developerGit = roots.map((root) => join(root, 'usr/bin/git')).find((path) => existsSync(path)) ?? null;
  return developerGit;
}

/**
 * A directory holding only a link to the toolchain's git, for a suite's PATH.
 * macOS's `/usr/bin/git` is a shim that asks xcrun which git to run on every
 * call: 67 ms a call against 23 ms direct (2026-11-01), and memoro-cli's
 * autonomy tests make 400 calls each. One test went from 40 s to 24 s under
 * twice the load. Null off macOS and whenever the link cannot be made; a suite
 * then finds git as it always did.
 */
export function directGitDir({ home = mcHome(), platform = process.platform, target = toolchainGit } = {}) {
  if (platform !== 'darwin') return null;
  try {
    const git = target();
    if (!git) return null;
    const dir = join(home || mcHome(), 'direct-git');
    const link = join(dir, 'git');
    if (!existsSync(link)) {
      mkdirSync(dir, { recursive: true });
      try { symlinkSync(git, link); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return existsSync(link) ? dir : null;
  } catch { return null; }
}

/**
 * Kills a suite that ran past its time, with everything it started: the child
 * leads its own process group (`detached`), and the group is what is killed,
 * since npm, a shell and node's per-file runners sit between it and the test.
 */
function stopAfter(child, ms, onStop) {
  const timer = setTimeout(() => {
    onStop();
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The resource classes that run after the standard batch, each in its own `node --test`, in this order. */
export const LATER_CLASSES = Object.freeze(['sqlite', 'heavy']);

/** The `LATER_CLASSES` that run one file at a time; the rest run at the round's lanes. */
export const EXCLUSIVE_CLASSES = Object.freeze(['heavy']);

/**
 * The selected files split by resource class: `[{ files, lanes }]`. The
 * standard batch first at `lanes`, then `sqlite` at `lanes` and `heavy` one
 * file at a time, each class in its own batch. `sqlite` runs at the lanes
 * since 2026-10-24: its files open `:memory:` databases and share nothing, and
 * all 646 were green at four lanes twice (247 s, 300 s) against 770 s at one.
 * A file with no class, or one mc does not know, is standard.
 * Before 2026-10-19 the round ran every selected file in one `node --test` at
 * the core count, so memoro's `sqlite` and `heavy` files — exclusive for
 * correctness in its own runner — ran beside six others.
 */
export function testBatches(files, classes = {}, lanes = 1) {
  const later = new Set(LATER_CLASSES);
  const standard = files.filter((file) => !later.has(classes[file]));
  return [
    ...(standard.length ? [{ name: 'standard', files: standard, lanes }] : []),
    ...LATER_CLASSES
      .map((name) => ({ name, files: files.filter((file) => classes[file] === name) }))
      .filter(({ files: batch }) => batch.length)
      .map(({ name, files: batch }) => ({ name, files: batch, lanes: EXCLUSIVE_CLASSES.includes(name) ? 1 : lanes })),
  ];
}

/**
 * The selected files, run in their batches one after another (`testBatches`),
 * as one result: the TAP of each batch in order (`tapTotals` adds up one
 * summary per process), the first non-zero exit, and the time budget shared.
 */
export async function realTests({ cwd, files, flags = [], plan = null, onBatch = null, onLine = () => {}, env = process.env, timeoutMs = suiteTimeoutMs(env), lanes = testLanes({ env }), classes = {}, signal = null, times = null, runBatch = runTestBatch } = {}) {
  // Resolved once here, unless the caller resolved it (the session's worker and the
  // candidate round do, so provenance reaches the spawn): the same function as
  // `mc gate` configuration reads, so the requested policy and the spawned one agree.
  const resolved = plan ?? resolveTestPlan({ flags, script: flags.length ? null : testScriptOf(cwd) });
  if (resolved.invalid) return { code: -1, tap: '', stderr: '', error: resolved.invalid, timedOut: false, timeoutMs, tests: [], cut: [], batches: [] };
  // Nothing to run is nothing spawned: no batch is fabricated for it.
  const batches = testBatches(files, classes, lanes);
  if (!batches.length) return { code: 0, tap: '', stderr: '', timedOut: false, timeoutMs, tests: [], cut: [], batches: [] };
  // Each batch is told to the caller at its spawn (`onBatch`), so a run the caller
  // stops before it returns still says what it launched.
  const launched = [];
  const noteBatch = (batch) => { launched.push(batch); onBatch?.(batch); };
  if (batches.length === 1) {
    const only = await runBatch({ cwd, files, plan: resolved, flags: resolved.flags, onBatch: noteBatch, onLine, env, timeoutMs, lanes: batches[0].lanes, resource: batches[0].name, signal, times });
    return { ...only, batches: launched };
  }
  const started = Date.now();
  let tap = '';
  let stderr = '';
  let code = 0;
  const tests = [];
  const cut = [];
  for (const batch of batches) {
    const left = timeoutMs - (Date.now() - started);
    const ran = await runBatch({ cwd, files: batch.files, plan: resolved, flags: resolved.flags, onBatch: noteBatch, onLine, env, timeoutMs: Math.max(1000, left), lanes: batch.lanes, resource: batch.name, signal, times });
    tap += ran.tap;
    stderr += ran.stderr || '';
    tests.push(...(ran.tests || []));
    cut.push(...(ran.cut || []));
    if (ran.error) return { code: -1, tap, stderr, error: ran.error, tests, cut, batches: launched };
    // A batch with an unknown exit, no summary, or a file its tracker says was cut
    // short cannot disappear behind the passing totals of another resource class.
    const totals = tapTotals(ran.tap);
    if (!code && (ran.code !== 0 || !totals.finished || !totals.tests || ran.cut?.length)) code = ran.code || -1;
    if (ran.aborted) return { code: ran.code ?? -1, tap, stderr, aborted: true, timeoutMs, tests, cut, batches: launched };
    if (ran.timedOut) return { code, tap, stderr, timedOut: true, timeoutMs, tests, cut, batches: launched };
  }
  return { code, tap, stderr, timedOut: false, timeoutMs, lanes, tests, cut, batches: launched };
}

/** test-stdio-blocking.mjs, loaded by every batch (`runTestBatch`). */
const STDIO_BLOCKING = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'test-stdio-blocking.mjs')).href;

function runTestBatch({ cwd, files, plan = null, flags = [], onBatch = null, onLine = () => {}, env = process.env, timeoutMs = suiteTimeoutMs(env), lanes = testLanes({ env }), resource = 'standard', signal = null, times = null } = {}) {
  return new Promise((resolve) => {
    // Stopped before it started: nothing is spawned, and no batch is recorded.
    if (signal?.aborted) return resolve({ code: null, tap: '', timedOut: false, aborted: true, timeoutMs });
    const clean = suiteEnv(env);
    const inherited = String(clean.NODE_OPTIONS || '')
      .replace(/--test-reporter(-destination)?[=\s]\S+/gu, '')
      .trim();
    // The one resolution (`resolveTestPlan`): requested flags, the effective timeout
    // with its provenance. Its argv is assembled below, and only there.
    const resolved = plan ?? resolveTestPlan({ flags, script: flags.length ? null : testScriptOf(cwd) });
    // `--test-force-exit` ends a file's process the moment its tests end, and on macOS
    // that drops a report still queued on its pipe: the batch then reads fewer tests
    // than exist and exits 0 ("output cut"). `STDIO_BLOCKING` makes stdout and stderr
    // blocking before any test runs. It comes before the declared flags, so the
    // repository's own `--import`s still load, here and in every test file.
    // The measured cost of each file (test-times.js), in a second reporter so
    // that the TAP this reads stays as it was.
    const timesFile = times ? join(tmpdir(), `mc-test-times-${randomUUID()}.jsonl`) : null;
    // Told to the caller before the run starts, so a ceiling can read what it
    // had finished while the run is still going (`runProgress`).
    if (timesFile) times.track?.(timesFile);
    const reporters = timesFile
      ? ['--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${TIMES_REPORTER}`, `--test-reporter-destination=${timesFile}`]
      : ['--test-reporter=tap'];
    // What the run measured, each test by name (`testsMeasured`), read before the
    // file goes; the tests cut at their limit go to the too-slow file (`recordTooSlow`).
    const noteTimes = () => {
      if (!timesFile) return { tests: [], cut: [] };
      let text = '';
      try { text = readFileSync(timesFile, 'utf8'); recordTestTimes({ ...times, cwd, text }); } catch { /* a run that wrote none */ }
      times.complete?.(timesFile);
      // What this batch's own times file says it finished, read before the file goes:
      // a file it never started, or with a top-level test that never ended, was cut.
      const cut = outputCut(files, { progress: runProgress([timesFile]) });
      rmSync(timesFile, { force: true });
      const tests = testsMeasured(text, cwd);
      recordTooSlow({ root: workRoot(env), repo: times.repo, where: times.where, tests });
      return { tests, cut };
    };
    const argv = nodeTestArgv({ plan: resolved, files, lanes, reporters, stdioBlocking: STDIO_BLOCKING });
    // What this batch was actually given at the spawn: its argv (reporter destinations
    // are ephemeral and masked), the Node that ran it, the timeout Node was handed,
    // the requested policy's provenance, the resource class and the lanes.
    const record = () => {
      const concurrency = argv.find((word) => word.startsWith('--test-concurrency='));
      return { resource, files: [...files], lanes: concurrency ? Number(concurrency.slice('--test-concurrency='.length)) : null,
        node: process.execPath, nodeVersion: process.version, timeoutSource: resolved.timeout.source,
        timeoutMs: executedTimeoutOf(argv), forceExit: argv.includes('--test-force-exit'),
        argv: argv.map((word) => (word.startsWith('--test-reporter-destination=') ? '--test-reporter-destination=<ephemeral>' : word)) };
    };
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...clean, NODE_OPTIONS: inherited },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    // Launched: this is what the batch was given, whatever becomes of it.
    onBatch?.(record());
    let timedOut = false;
    // Stopped from outside: the process group goes at once, and the close says
    // `aborted`. A child that cannot be signalled as a group is signalled alone.
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = stopAfter(child, timeoutMs, () => { timedOut = true; });
    let tap = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      tap += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (/^# (tests|pass|fail) /u.test(line)) onLine(line.trim());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { settle(); signal?.removeEventListener('abort', onAbort); resolve({ code: -1, tap, stderr, error: error.message, aborted }); });
    // A batch whose output was cut short exits as an unknown exit, whatever its code said.
    child.on('close', (code) => {
      const { tests, cut } = noteTimes();
      settle(); signal?.removeEventListener('abort', onAbort);
      resolve({ code: cut.length && code === 0 ? -1 : code, tap, stderr, timedOut, timeoutMs, aborted, lanes: resolved.concurrencyDeclared ? null : lanes, tests, cut });
    });
  });
}

/**
 * A declared command, through `child-async.js`: the selector, the prepare and
 * the extra gates. Its 256 MiB `maxBuffer` is kept because Node's default is
 * 1 MiB and a child that prints more is killed for it (`ENOBUFS`, status
 * null): memoro's selector printed 1.3 MB for #12720 and the round stopped
 * with nothing measured.
 */
function shell(command, options) {
  return runShellAsync(command, options);
}

/**
 * How the command gates the selection named are run after the suite. The
 * name stays for its tests; it is `child-async.js`'s `runShell`, which is
 * what every child of the round now is.
 */
export const commandShell = runShellAsync;

/**
 * `npm ci` for the candidate's own dependency tree (`shared-deps.js`),
 * without holding the event loop for up to ten minutes. `ensureSharedDeps`
 * reads a throw as the install failing, with npm's stderr as the reason.
 */
async function npmCiAsync(cwd, signal = null) {
  const ran = await runTool('npm', ['ci', '--no-audit', '--no-fund'], { cwd, timeoutMs: 10 * 60_000, signal });
  if (ran.status !== 0) {
    throw Object.assign(new Error(ran.error?.message || `npm ci exited ${ran.status}`), { stderr: ran.stderr });
  }
}

/**
 * An extra gate, read off the run.
 *
 * The red names are taken only from output that finished as TAP — a gate
 * that prints something TAP-like but never summarised gets `red: null`, and
 * the comparison falls back to exit codes rather than trusting half a
 * parse. stdout and stderr both, because npm puts its own banner on one and
 * node's reporter writes on the other depending on the wrapper.
 */
function gateSide(outcome) {
  const ran = outcome.status !== null && outcome.status !== undefined;
  const output = `${outcome.stdout || ''}\n${outcome.stderr || ''}`;
  const finished = tapTotals(output).finished;
  return {
    ok: ran && outcome.status === 0,
    exit_code: outcome.status ?? null,
    ran,
    red: finished ? redNames(output) : null,
  };
}

/** A run whose output was cut short names the files it never finished: a file never started, or a test in it never ended. */
function cutReason(files) {
  return `output cut: ${files.join(', ')} — the run did not finish ${files.length === 1 ? 'this file' : 'these files'}`;
}

/** A few names, and how many were not named. */
function nameSome(names) {
  return `${names.slice(0, 5).join(', ')}${names.length > 5 ? `, … and ${names.length - 5} more` : ''}`;
}

/**
 * The whole suite, as a process.
 *
 * `command` is what the declaration said, run through a shell because that is
 * what a declaration is — a command line somebody wrote, not an argv mc gets
 * to compose. It was `npm test` hard-coded here, which is the same assumption
 * `suiteCommand` stopped making; the default keeps that behaviour for a caller
 * that names nothing.
 */
export function realSuite({ cwd, command = 'npm test', onLine = () => {}, env = process.env, timeoutMs = suiteTimeoutMs(env), lanes = testLanes({ env }), signal = null, times = null } = {}) {
  return new Promise((resolve) => {
    // Stopped before it started: nothing is spawned.
    if (signal?.aborted) return resolve({ code: null, tap: '', timedOut: false, aborted: true, timeoutMs });
    // The suite is started in a clean test context, not this process's.
    //
    // `NODE_TEST_CONTEXT` is set by node inside a test run, and a suite that
    // inherits it decides it is being required recursively and skips running
    // its files altogether — output with no results, exit code 0. The gate's
    // unfinished-run guard turns that into a stop rather than a false green,
    // but the round could never run at all. Which is exactly what happened the
    // first time this module's own live test tried to gate a repository.
    const clean = suiteEnv(env);
    // And any reporter the caller's own environment was already asking for.
    // Node rejects a second `--test-reporter` without a matching destination
    // (`ERR_INVALID_ARG_VALUE`) and the suite dies before running a thing — so
    // a gate run from inside a TAP-reported test run could not gate anything.
    // Found by this gate refusing this module's own pull request.
    const inherited = String(clean.NODE_OPTIONS || '')
      .replace(/--test-reporter(-destination)?[=\s]\S+/gu, '')
      .trim();
    // The measured cost of each file (test-times.js), as in `realTests`: a
    // second reporter beside the TAP, through NODE_OPTIONS since the suite is
    // a command line. `noteTimes` was called here without being defined (#1195),
    // and every full-suite round died on the close event.
    const timesFile = times ? join(tmpdir(), `mc-test-times-${randomUUID()}.jsonl`) : null;
    if (timesFile) times.track?.(timesFile);
    const reporters = `--test-reporter=tap --test-reporter-destination=stdout${timesFile ? ` --test-reporter=${TIMES_REPORTER} --test-reporter-destination=${timesFile}` : ''}`;
    const noteTimes = () => {
      if (!timesFile) return { cut: [], tests: [] };
      let text = '';
      try { text = readFileSync(timesFile, 'utf8'); recordTestTimes({ ...times, cwd, text }); } catch { /* a run that wrote none */ }
      times.complete?.(timesFile);
      // A whole suite names no files, so what its times file can show is a file whose top-level test started and never ended.
      const cut = outputCut([], { progress: runProgress([timesFile]) });
      rmSync(timesFile, { force: true });
      const tests = testsMeasured(text, cwd);
      recordTooSlow({ root: workRoot(env), repo: times.repo, where: times.where, tests });
      return { cut, tests };
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      // The round's lane count, for a suite that runs its own runner (memoro's
      // `runner.mjs` reads it); a caller that set one keeps it.
      env: { MC_TEST_LANES: String(lanes), ...clean, NODE_OPTIONS: `${inherited} ${reporters}`.trim() },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let timedOut = false;
    // Stopped from outside: the process group goes at once, and the close says
    // `aborted`. A child that cannot be signalled as a group is signalled alone.
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = stopAfter(child, timeoutMs, () => { timedOut = true; });

    let tap = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      tap += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      // Only the milestones: a TAP stream is thousands of lines and the point
      // of saying anything is to show the round is alive.
      for (const line of lines) if (/^# (tests|pass|fail) /u.test(line)) onLine(line.trim());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { /* npm's own noise; the verdict is in the TAP */ });

    child.on('error', (error) => { settle(); signal?.removeEventListener('abort', onAbort); resolve({ code: -1, tap, stderr, error: error.message, aborted }); });
    // A suite whose output was cut short exits as an unknown exit, whatever its code said.
    child.on('close', (code) => {
      const { cut, tests } = noteTimes();
      settle(); signal?.removeEventListener('abort', onAbort);
      resolve({ code: cut.length && code === 0 ? -1 : code, tap, timedOut, timeoutMs, aborted, cut, tests });
    });
  });
}
