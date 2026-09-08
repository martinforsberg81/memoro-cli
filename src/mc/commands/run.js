/**
 * `mc run` — take the next step of the next project, all day, and the switch
 * that works it from another terminal.
 *
 * `mc run [--once] [--no-merge] [--idle-sleep S] [--no-caffeinate]`; with no
 * flags it takes the next step of the next project until STOP. `--once` runs
 * one step for the first runnable project and exits — the way to watch one
 * step. `--rounds N` is retired: there is no round to count (2026-09-08).
 *
 *   mc run start [flags]   the same runner, in the background, logging to
 *                          `~/mc/runner/log/runner.log`
 *   mc run stop            it finishes the step it is in, then exits
 *   mc run stop --force    it ends now, and the session it is holding with it
 *   mc run --update        it finishes the step, fast-forwards mc's own
 *                          checkout, and restarts itself on the new code
 *   mc run lanes [<n>] [--total <n>|none]
 *                          how many steps may be in flight — the positional
 *                          per repository, `--total` on this machine across
 *                          both. No argument prints both and what is running.
 *                          Read at start, so a running runner takes new
 *                          counts on `--update`
 *
 * The three orders are files under `~/mc/runner/` read between two picks,
 * not signals: a runner ninety minutes into a headless session is given the
 * order without that session being interrupted. The rules are in
 * run-control.js.
 *
 * A run that is not `--once` holds the machine awake for its whole length
 * (stay-awake.js). That is the default rather than a flag to remember: this
 * laptop sleeps after one minute of idle on battery, and a runner waiting ten
 * minutes between picks is doing exactly what that setting kills.
 * `--no-caffeinate` is the way out for somebody who wants the machine to be
 * allowed to sleep.
 */
import { LANES_MAX, laneValue, readLaneCount, writeLaneCount } from '../lane-count.js';
import { runnerDir } from '../paths.js';
import { requestUpdate, startRunner, stopRunner } from '../run-control.js';
import { REPO_NAMES, runLoop } from '../run.js';
import { pidAlive, readCurrents } from '../status-collect.js';
import { scanArgs } from './flags.js';

const USAGE = [
  'usage — mc run [--once] [--no-merge] [--idle-sleep <seconds>] [--no-caffeinate]',
  '        mc run start [same flags]   the runner, in the background',
  '        mc run stop [--force]       after the step it is in, or now',
  '        mc run --update             after the step: new code, new process',
  `        mc run lanes [<n>] [--total <n>|none]`,
  `                                    steps in flight: <n> per repository, --total across every`,
  `                                    repository at once, both 1–${LANES_MAX}; no argument prints both`,
].join('\n');

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseRunArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(`${USAGE}\n`);
    return 2;
  }

  if (opts.verb !== 'run') {
    const outcome = await order(opts, deps);
    const stream = outcome.ok ? stdout : stderr;
    for (const line of outcome.lines) stream.write(`${outcome.ok ? '' : 'mc: '}${line}\n`);
    return outcome.code;
  }

  return (deps.loop || runLoop)({
    once: opts.once, merge: opts.merge, idleSleepMs: opts.idleSleep * 1000, awake: opts.awake,
  });
}

/** One order to the runner, whichever of the three it is. */
function order(opts, deps) {
  if (opts.verb === 'start') return (deps.start || startRunner)({ argv: opts.pass, deps: deps.control });
  if (opts.verb === 'stop') return (deps.stop || stopRunner)({ force: opts.force, deps: deps.control });
  if (opts.verb === 'lanes') return lanes(opts, deps);
  return (deps.update || requestUpdate)({ deps: deps.control });
}

/**
 * `mc run lanes [<n>] [--total <n>|none]` — both counts, printed or set.
 *
 * Printed is the deliverable here, not the afterthought. The old line said
 * `lanes 3 — 3 steps in flight per repository`, which is true and produced the
 * wrong picture: it never says there are two repositories, so it never says
 * the machine is running six. This one says both numbers, what they come to
 * together, and how many steps are actually in flight while it is read.
 */
function lanes(opts, deps) {
  const read = deps.readLanes || readLaneCount;
  const write = deps.writeLanes || writeLaneCount;
  const check = deps.laneValue || laneValue;
  const repos = (deps.repos || REPO_NAMES).length;

  if (opts.count === null && opts.total === null) {
    const pair = read();
    return { ok: true, code: 0, lines: [`lanes ${phrase(pair, repos)} — ${inFlight(deps)} in flight`, ...neverBinds(pair, repos)] };
  }

  // Both values are asked about before either is written: `lanes 3 --total 12`
  // must not land the 3 and then refuse the 12, leaving the operator with half
  // of what they typed and no line saying which half.
  for (const [field, value] of [['per_repo', opts.count], ['total', opts.total]]) {
    if (value === null) continue;
    const seen = check(value, { field });
    if (!seen.ok) return { ok: false, code: 2, lines: [seen.reason] };
  }
  const written = [];
  if (opts.count !== null) written.push(write(opts.count));
  if (opts.total !== null) written.push(write(opts.total, { field: 'total' }));
  const refused = written.find((set) => !set.ok);
  if (refused) return { ok: false, code: 2, lines: [refused.reason] };
  const pair = written[written.length - 1];
  return {
    ok: true,
    code: 0,
    lines: [
      `lanes ${phrase(pair, repos)} from the next start`,
      ...neverBinds(pair, repos),
      'a running runner keeps the counts it started with: mc run --update takes the new ones after the step it is in',
    ],
  };
}

/**
 * The pair as one phrase, in the order and the words the runner's own log line
 * uses (`run.js`: `lanes: 3 per repository, 3 in total`), so the verb and the
 * log cannot be read as two different settings.
 *
 * An absent total is said rather than left out. `3 per repository` alone does
 * not tell a reader whether the total is unset or happens to be 3, and the
 * consequence — two repositories at 3 is six sessions at once — is the
 * sentence whose absence started this.
 */
function phrase({ per_repo: per, total }, repos) {
  const cap = total === null ? `no total cap (up to ${per * repos} across ${repos} repositories)` : `${total} in total`;
  return `${per} per repository, ${cap}`;
}

/**
 * A total at or above `per_repo × repositories` can never refuse a lane a
 * slot, so setting one is a no-op. Saying so costs a line; not saying so
 * leaves an operator believing they capped the machine.
 */
function neverBinds({ per_repo: per, total }, repos) {
  if (total === null || total < per * repos) return [];
  return [`that total never binds: ${per} per repository across ${repos} repositories is at most ${per * repos}`];
}

/**
 * How many steps are in flight this second, from the `current-<repo>.json`
 * files the runner keeps — one per lane, for as long as its session runs. A
 * file naming a dead pid is a killed runner's leftovers rather than a running
 * step, which is the test the page applies to the same files (`nowBlock`), so
 * the two cannot disagree.
 *
 * A printed count is a snapshot for a person to read. The count that has to be
 * race-free is the runner's own in-process slot (`run.js`: `takeSlot`), not
 * this one.
 */
function inFlight(deps) {
  const currents = deps.currents || (() => readCurrents(runnerDir()));
  const alive = deps.alive || pidAlive;
  return currents().filter((current) => alive(current?.pid)).length;
}

/**
 * The command line, as one of four things: a run, or one of the three orders
 * to a runner that is already up.
 *
 * `start` carries the run's own flags through untouched — the background
 * runner is the same runner — so they are parsed here as well as passed on,
 * and a typo is answered at the terminal rather than in a log file nobody is
 * watching.
 */
export function parseRunArgs(argv) {
  const head = argv[0];

  if (head === 'stop') {
    const scanned = scanArgs(argv.slice(1), { booleans: ['--force'] });
    if (scanned.error) return { error: scanned.error };
    if (scanned.positional.length) return { error: `unexpected argument ${scanned.positional[0]}` };
    return { verb: 'stop', force: scanned.flags.force };
  }

  if (head === 'start') {
    const opts = parseLoopArgs(argv.slice(1));
    return opts.error ? opts : { ...opts, verb: 'start', pass: argv.slice(1) };
  }

  // The counts, read or set. `mc run lanes` says both; `mc run lanes 4` writes
  // the per-repository one and `--total` the machine's, and either says a
  // running runner takes it on `--update`.
  //
  // A second form rather than a second verb, and the bare positional still
  // means what it has always meant: nobody's muscle memory changes meaning
  // under them. `--total` is strict, so `mc run lanes --total` with nothing
  // after it is an error rather than a silent read.
  if (head === 'lanes') {
    const scanned = scanArgs(argv.slice(1), { strictValues: ['--total'] });
    if (scanned.error) return { error: scanned.error };
    if (scanned.positional.length > 1) return { error: `lanes takes one number, not ${scanned.positional.join(' ')}` };
    return {
      verb: 'lanes',
      count: scanned.positional.length ? scanned.positional[0] : null,
      total: scanned.flags.total,
    };
  }

  // An order, not a run: it takes nothing else, because everything else it
  // could take is a property of the runner that is already running.
  if (argv.includes('--update')) {
    if (argv.length > 1) {
      return { error: '--update is one order on its own — the running runner keeps the flags it was started with' };
    }
    return { verb: 'update' };
  }

  const opts = parseLoopArgs(argv);
  return opts.error ? opts : { ...opts, verb: 'run' };
}

/**
 * `--rounds N`, retired 2026-09-08 with the round itself: a lane takes the
 * next step and picks again, so there is no pass over the queue to count. The
 * form is `mc-cut`'s for a verb that has gone — the flag is answered by name,
 * with what to type instead, rather than by `unexpected argument 3`.
 */
const RETIRED_ROUNDS = 'a round no longer exists; `mc run` takes the next step until STOP, `mc run --once` takes one';

/** The loop's own flags — for `mc run`, and for the `mc run start` behind it. */
function parseLoopArgs(argv) {
  if (argv.some((arg) => arg === '--rounds' || String(arg).startsWith('--rounds='))) return { error: RETIRED_ROUNDS };
  const scanned = scanArgs(argv, {
    booleans: ['--once', '--no-merge', '--no-caffeinate'],
    strictValues: ['--idle-sleep'],
  });
  if (scanned.error) return { error: scanned.error };
  if (scanned.positional.length) return { error: `unexpected argument ${scanned.positional[0]}` };
  const num = (value, fallback) => {
    if (value == null) return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : NaN;
  };
  const idleSleep = num(scanned.flags.idleSleep ?? scanned.flags['idle-sleep'], 600);
  if (Number.isNaN(idleSleep)) return { error: '--idle-sleep needs a whole number of seconds' };
  return {
    once: scanned.flags.once,
    merge: !scanned.flags.noMerge && !scanned.flags['no-merge'],
    idleSleep,
    awake: !scanned.flags.noCaffeinate && !scanned.flags['no-caffeinate'],
  };
}
