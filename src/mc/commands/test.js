/**
 * `mc test <repo> <pr>` — measure a pull request against the branch it is
 * aimed at, and stop there.
 *
 * This is the gate round without the landing. It was reachable before as
 * `mc merge <repo> <pr> --check`, which is a flag on the verb for merging: a
 * name nobody looks under when the question is "is this change red?". Ruled
 * 2026-08-29 that the measurement gets its own verb and that `mc merge` runs
 * the same one — not a second implementation that could drift from it.
 *
 * One measurement, two doors. `mc test` runs `runGate` and reports; `mc merge`
 * runs `runGate` and, if it came back clean, lands the change. There is no
 * path here that merges anything, which `repo-gate.js` asserts against its own
 * source and this file inherits by having no merge code to assert about.
 *
 * What it measures depends on what the repository declares. With a `select`
 * command it is the test files the change reaches and the command gates the
 * same selection named beside them; without one it is the whole suite. One
 * tree either way, and the verdict is that tree's own red: whether main was
 * already red is not this round's question (ruled 2026-08-31).
 *
 * `mc test <repo> --full` is the other reading, and the only one here that is
 * about the code rather than about a change: the repository's whole suite on
 * the default branch as fetched. Asked for here, and — since 2026-09-03 — also
 * taken on an interval by the nightly, which runs this same round rather than a
 * copy of it, so the scheduled reading and the asked-for one cannot disagree
 * about what a repository's whole suite is.
 *
 * And since 2026-09-04 the nightly is started, stopped and asked here too:
 * `mc test nightly start | stop | status` is the scheduled form of the round
 * above, under the verb whose round it runs (`mc repo nightly` was the old
 * spelling and answers with this one).
 */
import { nightlyReading } from '../nightly-history.js';
import { knownRepos } from '../nightly-loop.js';
import {
  DEFAULT_INTERVAL_MS as NIGHTLY_INTERVAL_MS, nightlyState, startNightly, stopNightly,
} from '../nightly.js';
import { renderNightlyLines } from '../repo-render.js';
import { scanArgs } from './flags.js';
import { gate, parseMergeArgs } from './repo.js';

/** The scheduler's three words, the watcher's three words. One grammar. */
const METER_VERBS = ['start', 'stop', 'status'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  // Before the line is read as a repository and a pull request: no repository
  // is called `nightly`, and none will be.
  if (argv[0] === 'nightly') return nightly(argv.slice(1), { stdout, stderr });
  const opts = parseMergeArgs(argv, { full: true });
  if (opts.error) {
    stderr.write(`mc: ${opts.error.replace(/mc merge <repo> <pr>[^\n]*/u, 'mc test <repo> <pr> | --full')}\n`);
    stderr.write(usage());
    return 2;
  }
  // The round never lands anything from here, whatever else was typed.
  return gate({ ...opts, check: true, verb: 'test' }, { stdout, stderr });
}

/**
 * The full run nobody asks for: start it, stop it, or ask after it.
 *
 * Explicit on purpose — no page starts a background process — and this one
 * runs whole suites, which pin the machine for minutes at a time. A process
 * that appears because somebody read a page is bad enough when it costs a
 * fetch.
 *
 * It is a meter and nothing else. Whatever it finds refuses no merge, delays
 * no round and changes no verdict (ruled by Martin, 2026-09-02), so stopping
 * it costs a reading and never a decision.
 */
async function nightly(argv, { stdout, stderr }) {
  const opts = parseNightlyArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }

  if (opts.verb === 'start') {
    const started = startNightly({ intervalMs: opts.intervalMs });
    if (!started.ok && started.reason === 'already-running') {
      stdout.write(`mc: the nightly is already running (pid ${started.pid}, every ${every(started.interval_ms)})\n`);
      return 0;
    }
    if (!started.ok) {
      stderr.write(`mc: could not start the nightly (${started.reason})\n`);
      return 1;
    }
    stdout.write(`mc: a full run of every repository every ${every(started.interval_ms)} (pid ${started.pid})\n`);
    stdout.write(`mc: it writes ${started.log} and nothing else — it merges nothing and blocks nothing\n`);
    stdout.write('mc: a tick that finds a gate round running skips and says so; it never queues behind one\n');
    return 0;
  }

  if (opts.verb === 'stop') {
    const stopped = await stopNightly();
    if (!stopped.stopped) {
      stdout.write(stopped.abandoned
        ? 'mc: no nightly was running — cleared the pid file it left behind\n'
        : 'mc: no nightly is running\n');
      return 0;
    }
    stdout.write(`mc: stopped the nightly (pid ${stopped.pid})${stopped.forced ? ' — it had to be killed' : ''}\n`);
    return 0;
  }

  return status(opts, { stdout });
}

/**
 * Whether it is running — and what it found.
 *
 * The reading is here because it is the question the nightly exists for: red,
 * and since when. It was printed only under `mc repo status`'s *full run*
 * section, which is a page somebody has to know to go to; a person who started
 * this thing should be able to read it where they started it. The rows are
 * `repo-render.js`'s own, so the two pages cannot drift.
 *
 * Every repository the loop would measure gets a block, whether or not it has
 * ever been measured: a meter that is silent about a repository it runs on is
 * one nobody can tell from a meter that has not run.
 */
async function status(opts, { stdout }) {
  const state = nightlyState();
  const repos = (await knownRepos()).map((repo) => ({ ...repo, nightly: nightlyReading(repo.path) }));
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      ...state,
      repos: Object.fromEntries(repos.map((repo) => [repo.name, repo.nightly])),
    }, null, 2)}\n`);
    return 0;
  }
  stdout.write(`${renderNightlyLines(state, {
    columns: stdout.columns || 100,
    colour: Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined,
    repos,
  }).join('\n')}\n`);
  return 0;
}

export function parseNightlyArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--interval'] });
  const opts = { verb: 'status', json: scanned.flags.json, intervalMs: NIGHTLY_INTERVAL_MS };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];
  // Bare `mc test nightly` is the question about the nightly, the way bare
  // `mc repo watch` is the question about the watcher.
  const word = positional.shift() || 'status';
  if (!METER_VERBS.includes(word)) return { ...opts, error: `mc test nightly ${word}? — start, stop or status` };
  opts.verb = word;
  // It measures every repository mc knows; naming one would be a different
  // command, and that command is `mc test <repo> --full`.
  if (positional.length) return { ...opts, error: `mc test nightly takes no repository (${positional[0]}) — mc test ${positional[0]} --full is the one-off` };
  if (scanned.flags.interval !== null) {
    const value = Number(scanned.flags.interval);
    if (!Number.isFinite(value) || value < 1) return { ...opts, error: '--interval needs a number of seconds' };
    opts.intervalMs = Math.round(value * 1000);
  }
  return opts;
}

/**
 * The same number, said the way a day-long cadence reads.
 *
 * `--interval` is seconds here and on `mc repo watch start`, because one flag
 * with two units across sibling verbs is a trap — but "every 86400s" is not a
 * sentence anybody checks, so the nightly prints hours.
 */
function every(ms) {
  const value = Number(ms) || 0;
  if (value < 3_600_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round((value / 3_600_000) * 10) / 10}h`;
}

export function usage() {
  return [
    'usage — mc test <repo> <pr> [<pr>...] [--json]   measure the change; merge nothing\n',
    '        mc test <repo> --full [--json]           the repository\'s whole suite, on the default branch\n',
    '        mc test nightly start [--interval <seconds>]\n',
    '        mc test nightly stop\n',
    '        mc test nightly status [--json]          whether it runs, and what it found\n',
  ].join('');
}
