/**
 * The full run: once a day, each repository's whole suite on its main when main
 * has moved, beside everything else on the machine.
 *
 * Kept apart from the runner that calls it (`runNightly` in `run.js`), for the
 * reason the watcher's round is: a tick is a plain async function, so a test
 * can run one and read what it wrote without spawning anything. The file keeps
 * its old name, and the round log and the history keep the word `nightly`,
 * because they are what `mc test nightly status` and `mc repo status` read.
 *
 * ## What a run is
 *
 * `mc test <repo> --full` for one repository. Not a copy of that round —
 * `runGate` itself, with the same `full: true` a person's `--full` passes, so
 * the scheduled reading and the asked-for reading cannot disagree about what a
 * repository's whole suite is. It is the argument `repo-watch-loop.js` makes
 * about its own round using the ordinary aggregator, and it is why there is no
 * second implementation here to drift.
 *
 * ## When: once a day, beside all other work (Martin, 2026-11-13)
 *
 * The runner's chore pass asks once a day (`nightlyDue` in `run.js`) and then,
 * for each repository, whether its full run is due (`fullRunDue`), and starts
 * the ones that are without waiting for them (`fullRunTick`). On mc-server
 * Martin ruled that the daily run goes beside the merges and sessions instead of
 * behind them, and that it stays once a day.
 *
 *  - **Due when origin/main moved** since the last full run that measured
 *    something. Equal, and the tree is the one already measured: nothing runs
 *    and nothing is written. A repository never measured is due.
 *  - **At most one at a time per repository.** A repository whose run is in
 *    flight is not started again; a run that ends starts nothing after it.
 *  - **A run that stopped on a commit waits for main to move.** What stopped
 *    because of the machine rather than the tree is tried again after
 *    `FULL_RUN_RETRY_MS`. A run the runner itself cut short (STOP, UPDATE) is
 *    due again at once, for the runner that comes next.
 *
 * ## Beside the merge lane
 *
 * A run takes no round lock and no lease, and measures in a checkout of its
 * own (`<work root>/gate/<slug>/full`, `isolated` in `runGate`), so a merge
 * round, a session and a full run of the same repository proceed at once. It
 * runs its tests at `fullRunLanes` (2, or `MC_FULL_RUN_LANES`), which is what
 * lets it share the machine; `repo-gate.js` says why two.
 *
 * ## Reds go to a main-red mend
 *
 * The reds a measured run finds on main are main's, by construction: there is
 * no change in the tree. They are recorded as exact-commit evidence
 * (`recordMainRed`, written by the round) and handed to `requestMainRepair`,
 * the door a merge round's main red goes through: it queues a main-red mend
 * session. A red test never becomes a goal (Martin, 2026-11-13). A test that
 * never ends is red too (Martin, 2026-11-14): the files a stalled run names
 * as in flight go through the same door, the stall as their failure.
 *
 * ## What it leaves behind
 *
 * The log, which is for a person reading it, and one bounded history of runs
 * per repository (`nightly-history.js`), which is what `mc repo status` reads
 * to say what is red and since when. Every run that started goes in —
 * measured, and stopped — because a run that could not finish is not a run
 * that found nothing. A repository that was not due writes nothing: with a
 * chore pass every few minutes, a line per pass would push the measurements
 * out of the history.
 */
import { tryGit } from './git.js';
import { mcHome } from './paths.js';
import { appendNightlyLog } from './nightly.js';
import { requestMainRepair } from './main-repair.js';
import { nightlyReading, readNightlyHistory, recordNightlyRun } from './nightly-history.js';
import { recordRound, recordRoundStart } from './repo-round-log.js';
import { fullRunLanes, runGate } from './repo-gate.js';
import { repoStatus } from './repo-status.js';
import { currentHolder } from './work-identity.js';

/**
 * How a scheduled round is written in the round log.
 *
 * `mode` is the log's word for what was asked for — a `--check` that stopped
 * at red and a merge that did are different facts — and nobody asked for this
 * one. Scheduled rounds would otherwise arrive in `mc repo rounds` as checks
 * somebody typed, and "has the gate ever caught anything?" would be answered
 * partly by rounds that were never about a change.
 */
const NIGHTLY_MODE = 'nightly';

/**
 * How long a run that stopped because of the machine — no fetch, a throw, a
 * head that could not be read — waits before it is tried again on the same
 * main. An hour: long enough that an offline machine does not start a suite
 * every chore pass, short enough that a transient failure costs one hour of
 * the meter.
 */
export const FULL_RUN_RETRY_MS = 60 * 60 * 1000;

/** Stops that are the machine's, not the tree's: tried again after `FULL_RUN_RETRY_MS`. */
const RETRY_LATER = Object.freeze(['threw', 'fetch', 'worktree', 'lease', 'reservation', 'busy', 'base', 'pr']);
/** Stops the runner caused itself: due again at once. */
const RETRY_NOW = Object.freeze(['gone', 'killed']);

/**
 * One full round for one repository, through the door a person's `--full`
 * goes through, beside the merge lane (`isolated`).
 *
 * The three lines around `runGate` are the same three `commands/repo.js`'s
 * `gate()` writes: who is asking, a start line before any work (a round that
 * is killed writes no end line, and the start is the only trace it leaves),
 * and the round's own line afterwards. Every gate round on this machine is
 * counted in one place, and a scheduled one that stayed out of that count
 * would make `mc repo rounds` quietly wrong about what this machine did.
 *
 * No lease (`holdLease: false`): it merges nothing, and the lease is held by
 * holder name, so the runner's run would give back the merger's lease under
 * the same name, or keep the merger out under another. No signal handlers of
 * its own (`signals: false`): the runner stops it through `signal`.
 */
export async function scheduledRound({ repoPath, root = mcHome(), env = process.env, say = () => {}, signal = null, gate = runGate } = {}) {
  const holder = currentHolder();
  const lanes = fullRunLanes(env);
  recordRoundStart({ repo: repoPath, mode: NIGHTLY_MODE, holder: holder?.name || null, prs: [] }, { root });
  const report = await gate({
    repoPath, full: true, isolated: true, holdLease: false, signals: false, lanes, signal,
    // The suite's own runner reads the lanes from here (memoro's `runner.mjs`,
    // memoro-cli's `npm test`); the full run's lanes win over the runner's.
    holder, root, env: { ...env, MC_TEST_LANES: String(lanes) }, onProgress: say,
  });
  recordRound(report, { mode: NIGHTLY_MODE, root });
  return report;
}

/**
 * Where the remote's default branch is right now, or null when that cannot be
 * learned.
 *
 * `git ls-remote origin HEAD` is one round-trip that fetches nothing and
 * writes nothing inside the repository. Null for every way of not knowing —
 * no network, no `origin`, a git error, a spawn failure, an answer that is not
 * a full sha — because the caller treats them all the same.
 */
export function remoteHead(repoPath) {
  try {
    const answer = tryGit(repoPath, ['ls-remote', 'origin', 'HEAD']);
    const sha = String(answer || '').trim().split(/\s+/u)[0] || '';
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Whether this repository's full run is due: `{ due, sha, why }`.
 *
 * `sha` is origin/main as `head` read it, or null. Exact string equality and
 * nothing cleverer: the probe does not fetch, so this checkout may not hold the
 * remote commit and no ancestry question could be answered.
 */
export function fullRunDue(repo, { root = mcHome(), head = remoteHead, clock = () => Date.now(), retryMs = FULL_RUN_RETRY_MS } = {}) {
  const measured = nightlyReading(repo.path, { root }).measured;
  const last = readNightlyHistory(repo.path, { root }).runs.at(-1) || null;
  let sha = null;
  try { sha = head(repo.path); } catch { sha = null; }
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/u.test(sha)) sha = null;
  const short = sha ? sha.slice(0, 7) : null;

  if (sha && measured?.commit === sha) {
    return { due: false, sha, why: `main is still ${short}, measured ${measured.at}; not measured again` };
  }
  const lastMeasured = Array.isArray(last?.red);
  const stop = last?.stopped_at || null;
  const since = last ? clock() - Date.parse(last.at) : Infinity;
  if (last && !lastMeasured && !RETRY_NOW.includes(stop)) {
    if (sha && last.commit === sha && !RETRY_LATER.includes(stop)) {
      return { due: false, sha, why: `main is still ${short}, where the last full run stopped at ${stop} (${last.at}); the next starts when main moves` };
    }
    if ((RETRY_LATER.includes(stop) || !last.commit) && since < retryMs) {
      return { due: false, sha, why: `the last full run stopped at ${stop} (${last.at}); tried again ${Math.ceil((retryMs - since) / 60_000)} min from now` };
    }
  }
  if (!sha && last && since < retryMs) {
    return { due: false, sha, why: `origin/main could not be read; the last full run was ${last.at}, tried again within the hour` };
  }
  const why = !measured ? 'never measured'
    : sha ? `main moved to ${short} since the measurement of ${String(measured.commit || 'unknown').slice(0, 7)}`
      : 'origin/main could not be read — measured anyway';
  return { due: true, sha, why };
}

/**
 * One full run of one repository, its result written down, its reds handed to
 * a repair. Never throws: a round that threw is this repository's answer and
 * nothing else's, written as a run that measured nothing.
 */
export async function fullRun(repo, {
  root = mcHome(), env = process.env, say = () => {}, narrate = say, round = scheduledRound,
  clock = () => Date.now(), signal = null, repair = requestMainRepair,
} = {}) {
  const startedAt = clock();
  say(`${repo.name} — full run started`);
  let report = null;
  try {
    report = await round({ repoPath: repo.path, root, env, say: narrate, signal });
  } catch (error) {
    // What it must not do is look like a run that found no failures.
    const threw = {
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
    };
    recordNightlyRun(threw, { root });
    say(`${repo.name}  stopped at threw  started ${threw.started_at}  `
      + `took ${seconds(threw.duration_ms)}  main unknown — ${threw.reason}`);
    return threw;
  }

  const run = {
    repo: repo.name,
    path: repo.path,
    started_at: report.started_at || new Date(startedAt).toISOString(),
    duration_ms: report.duration_ms ?? (clock() - startedAt),
    // The commit of the branch this measured. `--full` checks out the
    // default branch as `origin` fetched it, so this is the `main` the
    // answer is about — and without it a red set names no tree and cannot
    // be compared with the next run's.
    commit: report.base?.commit || report.candidate?.commit || null,
    verdict: report.verdict,
    stopped_at: report.stopped_at,
    reason: report.reason,
    // The failing names, for whoever asks "since when". Names only: output
    // and stack traces turn a meter into an archive.
    red: report.candidate?.red || null,
    tests: report.candidate?.totals?.tests ?? null,
  };
  // The history the page reads. It is written here rather than by the round,
  // because `mc test --full` typed by a person can be asked about a pull
  // request, and red names about somebody's branch in this file would make
  // "since when" a sentence about that branch (`nightly-history.js`).
  recordNightlyRun(run, { root });
  say(line(run));

  // Main's red, repaired as work of its own: the same door a merge round's
  // main red goes through (`merger.js`, `tell`). Only a run that reached its
  // summary — a red set read off a finished suite — and names its files.
  // The files as `recordMainRed` reads them: a whole suite's result names its
  // red tests with their files (`measure`), a selected one its files as well.
  const redTests = report.candidate?.red_tests || [];
  const files = [...new Set([...(report.candidate?.red_files || []), ...redTests.map((test) => test.file)].filter(Boolean))].sort();
  if (repair && Array.isArray(run.red) && run.commit && files.length) {
    const tests = redTests.map((test) => ({ file: test.file, name: test.name, error: (test.error || []).slice(0, 12) }));
    const asked = repair({ repo: repo.name, base: run.commit, files, tests });
    const where = files.join(', ');
    const created = [].concat(asked?.created || []);
    const open = [].concat(asked?.open || []);
    if (created.length) say(`${repo.name}: main is red in ${where} at ${run.commit.slice(0, 7)} — main-red mend queued: ${created.join(', ')}${open.length ? `; already under way: ${open.join(', ')}` : ''}`);
    else if (open.length) say(`${repo.name}: main is red in ${where} — its main-red mend is under way: ${open.join(', ')}`);
    else say(`${repo.name}: main is red in ${where} — no main-red mend requested: ${asked?.skipped || 'nothing new'}`);
  }

  // A test that never ends is a red test (Martin, 2026-11-14): a run stopped
  // as stalled names the files still in flight (`repo-gate.js`, `stopStalled`),
  // and each goes to the same main-red mend, with the stall as its failure.
  // A stall that names no file has nothing to repair; the next day measures again.
  const hung = [...new Set(report.stalled_files || [])].filter(Boolean).sort();
  if (repair && report.stopped_at === 'stalled' && run.commit && hung.length) {
    const error = [`never ended in the full run: ${report.reason || 'stalled'}`];
    const asked = repair({ repo: repo.name, base: run.commit, files: hung, tests: hung.map((file) => ({ file, name: null, error })) });
    const where = hung.join(', ');
    const created = [].concat(asked?.created || []);
    const open = [].concat(asked?.open || []);
    if (created.length) say(`${repo.name}: a test never ended in ${where} at ${run.commit.slice(0, 7)} — main-red mend queued: ${created.join(', ')}${open.length ? `; already under way: ${open.join(', ')}` : ''}`);
    else if (open.length) say(`${repo.name}: a test never ended in ${where} — its main-red mend is under way: ${open.join(', ')}`);
    else say(`${repo.name}: a test never ended in ${where} — no main-red mend requested: ${asked?.skipped || 'nothing new'}`);
  }
  return run;
}

/**
 * One chore pass's look at the full runs: every repository mc knows that is
 * due and not already running is started, and not waited for.
 *
 * `running` is the caller's own map of repository path to the promise of its
 * run, kept across passes: it is what makes "one at a time per repository"
 * true. A run that ends starts nothing after it. `done` settles when every run
 * this pass started has ended, with their records: the runner does not wait on
 * it, a test does.
 */
export async function fullRunTick({
  root = mcHome(), env = process.env, say = () => {}, narrate = say,
  repos = null, round = scheduledRound, clock = () => Date.now(), head = remoteHead,
  shouldStop = () => false, running = new Map(), signal = null, repair = requestMainRepair,
  retryMs = FULL_RUN_RETRY_MS,
} = {}) {
  const at = new Date(clock()).toISOString();
  const known = unique(repos || await knownRepos({ env }));
  const started = [];
  const busy = [];
  const waiting = [];
  const leaving = () => shouldStop() || Boolean(signal?.aborted);

  const launch = (repo) => {
    const tracked = fullRun(repo, { root, env, say, narrate, round, clock, signal, repair })
      .then((ran) => [ran])
      .finally(() => { if (running.get(repo.path) === tracked) running.delete(repo.path); });
    running.set(repo.path, tracked);
    return tracked;
  };

  const chains = [];
  let stopped = false;
  for (const repo of known) {
    if (leaving()) { stopped = true; break; }
    if (running.has(repo.path)) { busy.push(repo.name); continue; }
    const due = fullRunDue(repo, { root, head, clock, retryMs });
    if (!due.due) { waiting.push({ repo: repo.name, why: due.why }); continue; }
    started.push({ repo: repo.name, why: due.why });
    chains.push(launch(repo));
  }
  const done = Promise.all(chains).then((all) => all.flat());
  return { at, started, running: busy, waiting, stopped, done };
}

/**
 * A pass whose every word is written to the full run's log, and whose
 * summaries only are handed on.
 *
 * The log is the record of what happened — it is how the September 2026 outage
 * and the November 2026 stalls were diagnosed — so it keeps the rounds' whole
 * narration with a timestamp on each line; `say` is the caller's own channel
 * and receives the per-repository lines alone.
 */
export async function loggedTick({ root = mcHome(), say = () => {}, ...rest } = {}) {
  const write = (message) => {
    try { appendNightlyLog(`${new Date().toISOString()}  ${message}\n`, { root }); } catch { /* a log that cannot be written is not a run that failed */ }
  };
  return fullRunTick({
    root,
    ...rest,
    narrate: write,
    say: (message) => { write(message); say(message); },
  });
}

/**
 * The repositories mc knows, offline.
 *
 * The same list `mc repo status` shows, derived from the board the way that
 * page derives it, so a repository is measured for exactly the reason it
 * appears there — and stops being measured the same way. Offline because the
 * round fetches for itself a moment later, and a pass that could not reach the
 * network should still say what it could not do rather than fail at the door.
 *
 * Exported because `mc test nightly status` reports one block per repository
 * and must report on the ones the runs will actually measure.
 */
export async function knownRepos({ env = process.env } = {}) {
  const report = await repoStatus({ env, offline: true });
  return (report.repos || []).map((repo) => ({ name: repo.name, path: repo.path }));
}

/**
 * One entry per repository name. The board can list one repository under two
 * paths (mc-server, 2026-11-13: memoro-cli as `~/mc/repos/memoro-cli.git` and
 * as `~/mc/self/memoro-cli`), and the same main measured twice at once is a
 * suite's worth of cores for nothing. The first path listed is kept.
 */
function unique(repos) {
  const seen = new Set();
  return repos.filter((repo) => {
    const key = repo.name || repo.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One run, as one line: what it was, when it started, what it cost, which
 * commit of the branch it measured, and how it came out.
 *
 * All of it on one line on purpose. The start is written separately, before
 * the round, so a killed run still shows what it had begun — but a reader
 * answering "what happened" should not have to pair two lines to learn the
 * four facts.
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
