/**
 * The nightly's round, and the loop around it.
 *
 * Kept apart from the process control (`nightly.js`) and from the runner that
 * starts it, for the reason the watcher's round is: a tick is a plain async
 * function, so a test can run one and read what it wrote without spawning
 * anything.
 *
 * ## What a tick is
 *
 * `mc test <repo> --full` for every repository mc knows, in the order the
 * board lists them. Not a copy of that round — `runGate` itself, with the
 * same `full: true` a person's `--full` passes, so the scheduled reading and
 * the asked-for reading cannot disagree about what a repository's whole suite
 * is. It is the argument `repo-watch-loop.js` makes about its own round using
 * the ordinary aggregator, and it is why there is no second implementation
 * here to drift.
 *
 * ## The lock, and why a skip is not an error
 *
 * `gate-lock.js` is the one door the big suites go through, and its whole
 * argument is that there is no honest expiry: a round is *supposed* to take
 * minutes, so no clock can tell a slow round from a dead one. The nightly
 * therefore does not wait for it, does not retry in a tight loop, and does not
 * force. It attempts the lock; if a live round holds it, the tick is over and
 * the skip is written down with that round's pid and the time.
 *
 * A skipped tick is a fact about the day rather than a failure. A machine that
 * merged all evening should show a night of skips and one run, and that should
 * read as normal. There is deliberately no queue, no backoff, and no notion of
 * a run that is "overdue": a missed night is a missed night, and the next tick
 * runs.
 *
 * ## The cadence, and the laptop that was asleep
 *
 * Every N hours **since the last completed tick**, never at a wall-clock hour.
 * A wall-clock scheduler on a laptop is the wrong shape twice: asleep at 03:00
 * it never sees 03:00 at all, and a scheduler that notices the miss on waking
 * fires a catch-up burst at breakfast — 300 s of pinned cores at exactly the
 * moment somebody sat down to work. Measuring from the last finished tick has
 * neither failure: sleep simply stretches the gap, and the first tick after
 * waking is one tick.
 *
 * The first tick happens when the scheduler starts, rather than an interval
 * later. Starting it is itself a request for a reading, and a meter whose
 * first answer arrives tomorrow is one nobody trusts today.
 */
import { gateLockPath, describeRunning, runningRound } from './gate-lock.js';
import { mcHome } from './paths.js';
import { DEFAULT_INTERVAL_MS } from './nightly.js';
import { recordRound, recordRoundStart } from './repo-round-log.js';
import { runGate } from './repo-gate.js';
import { repoStatus } from './repo-status.js';
import { currentHolder } from './work-identity.js';

/**
 * How a scheduled round is written in the round log.
 *
 * `mode` is the log's word for what was asked for — a `--check` that stopped
 * at red and a merge that did are different facts — and nobody asked for this
 * one. Two more rounds a day would otherwise arrive in `mc repo rounds` as
 * checks somebody typed, and "has the gate ever caught anything?" would be
 * answered partly by rounds that were never about a change.
 */
const NIGHTLY_MODE = 'nightly';

/**
 * One full round for one repository, through the door a person's `--full`
 * goes through.
 *
 * The three lines around `runGate` are the same three `commands/repo.js`'s
 * `gate()` writes: who is asking, a start line before any work (a round that
 * is killed writes no end line, and the start is the only trace it leaves),
 * and the round's own line afterwards. Every gate round on this machine is
 * counted in one place, and a scheduled one that stayed out of that count
 * would make `mc repo rounds` quietly wrong about what this machine did.
 */
export async function scheduledRound({ repoPath, root = mcHome(), env = process.env, say = () => {} } = {}) {
  const holder = currentHolder();
  recordRoundStart({ repo: repoPath, mode: NIGHTLY_MODE, holder: holder?.name || null, prs: [] }, { root });
  const report = await runGate({ repoPath, full: true, holder, root, env, onProgress: say });
  recordRound(report, { mode: NIGHTLY_MODE, root });
  return report;
}

/**
 * One tick: every repository mc knows, measured whole, until something else
 * wants the machine.
 *
 * The lock is asked about before each repository rather than once at the top.
 * A tick is minutes long and a merge round can start inside it, and the point
 * of the guard is that a person's round never waits behind this one — so the
 * one already running is finished and the tick ends there rather than taking
 * the lock back for the next repository.
 */
export async function nightlyTick({
  root = mcHome(), env = process.env, say = () => {},
  repos = null, round = scheduledRound, clock = () => Date.now(),
} = {}) {
  const at = new Date(clock()).toISOString();
  const known = repos || await knownRepos({ env });
  const runs = [];
  let skipped = null;

  for (const repo of known) {
    const running = runningRound({ root });
    if (running) {
      skipped = skip(repo, running, clock, { root });
      break;
    }
    const startedAt = clock();
    say(`${repo.name} — full run started`);
    let report = null;
    try {
      report = await round({ repoPath: repo.path, root, env, say });
    } catch (error) {
      // A round that threw is this repository's answer and nothing else's:
      // the tick goes on to the next, exactly as the watcher's loop goes on
      // to the next round. What it must not do is look like a run that found
      // no failures.
      runs.push({
        repo: repo.name,
        path: repo.path,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: clock() - startedAt,
        commit: null,
        verdict: 'stopped',
        stopped_at: 'threw',
        reason: error?.message || String(error),
        red: null,
        tests: null,
      });
      say(`${repo.name}  stopped at threw  started ${new Date(startedAt).toISOString()}  `
        + `took ${seconds(clock() - startedAt)}  main unknown — ${error?.message || String(error)}`);
      continue;
    }

    // The lock was free a moment ago and taken by the time the round asked
    // for it. That is a skip and not a stop: nothing was measured, and the
    // reason is somebody else's round rather than anything about this
    // repository.
    if (report.stopped_at === 'busy') {
      skipped = skip(repo, runningRound({ root }), clock, { root, reason: report.reason });
      break;
    }

    const run = {
      repo: repo.name,
      path: repo.path,
      started_at: report.started_at || new Date(startedAt).toISOString(),
      duration_ms: report.duration_ms ?? (clock() - startedAt),
      // The commit of the branch this measured. `--full` checks out the
      // default branch as `origin` fetched it, so this is the `main` the
      // answer is about — and without it a red set names no tree and cannot
      // be compared with tomorrow's.
      commit: report.base?.commit || report.candidate?.commit || null,
      verdict: report.verdict,
      stopped_at: report.stopped_at,
      reason: report.reason,
      // The failing names, for whoever asks "since when". Names only: output
      // and stack traces turn a meter into an archive.
      red: report.candidate?.red || null,
      tests: report.candidate?.totals?.tests ?? null,
    };
    runs.push(run);
    say(line(run));
  }

  if (skipped) say(`${skipped.repo}  skipped  ${skipped.reason}`);
  return { at, runs, skipped };
}

/**
 * Tick, wait, tick.
 *
 * A tick that throws is logged and the loop goes on, for the watcher's
 * reason: a repository that cannot be read tonight is a gap in one reading,
 * never a reason to stop reading.
 */
export async function nightlyLoop({
  intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(), env = process.env,
  rounds = Infinity, shouldStop = () => false, log = () => {}, tick = nightlyTick,
} = {}) {
  for (let round = 0; round < rounds && !shouldStop(); round += 1) {
    try {
      const outcome = await tick({ root, env, say: log });
      log(`tick: ${outcome.runs.length} measured${outcome.skipped ? ', then skipped' : ''}`);
    } catch (error) {
      log(`tick failed: ${error?.message || String(error)}`);
    }
    if (shouldStop()) break;
    // The next tick starts an interval after this one *finished*, not on a
    // fixed clock — see the header: a laptop that slept through the hour
    // simply has a longer gap, and never a burst of catch-up runs.
    await sleep(intervalMs, shouldStop);
  }
}

/**
 * The repositories mc knows, offline.
 *
 * The same list `mc repo status` shows, derived from the board the way that
 * page derives it, so a repository is measured for exactly the reason it
 * appears there — and stops being measured the same way. Offline because the
 * round fetches for itself a moment later, and a scheduler that could not
 * reach the network should still say what it could not do rather than fail at
 * the door.
 */
async function knownRepos({ env = process.env } = {}) {
  const report = await repoStatus({ env, offline: true });
  return (report.repos || []).map((repo) => ({ name: repo.name, path: repo.path }));
}

/** What was not measured, and whose round it was. */
function skip(repo, running, clock, { root, reason = null } = {}) {
  return {
    repo: repo.name,
    path: repo.path,
    at: new Date(clock()).toISOString(),
    // The holding round's own words, with its pid — the thing that makes a
    // skip checkable afterwards rather than a shrug.
    pid: running?.pid ?? null,
    reason: reason || describeRunning(running),
    lock: gateLockPath(root),
  };
}

/**
 * One run, as one line: what it was, when it started, what it cost, which
 * commit of the branch it measured, and how it came out.
 *
 * All of it on one line on purpose. The start is written separately, before
 * the round, so a killed scheduler still shows what it had begun — but a
 * reader answering "what happened last night" should not have to pair two
 * lines to learn the four facts.
 */
function line(run) {
  const where = run.commit ? run.commit.slice(0, 7) : 'unknown';
  const what = run.verdict === 'stopped' ? `stopped at ${run.stopped_at}` : run.verdict;
  const tail = run.verdict === 'stopped'
    ? run.reason
    : `${run.tests ?? 0} tests, ${run.red?.length ?? 0} red`
      + (run.red?.length ? `: ${run.red.slice(0, 3).join(', ')}${run.red.length > 3 ? ` and ${run.red.length - 3} more` : ''}` : '');
  return `${run.repo}  ${what}  started ${run.started_at}  took ${seconds(run.duration_ms)}  main ${where} — ${tail}`;
}

function seconds(ms) {
  return `${Math.round((Number(ms) || 0) / 100) / 10}s`;
}

async function sleep(ms, shouldStop) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldStop()) return;
    await new Promise((resolve) => { setTimeout(resolve, Math.max(1, Math.min(200, deadline - Date.now()))); });
  }
}
