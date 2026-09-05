/**
 * `mc run` — take the next step of the next project, all day, and the switch
 * that works it from another terminal.
 *
 * `mc run [--rounds N] [--once] [--no-merge] [--idle-sleep S] [--no-caffeinate]`;
 * rounds 0 (the default) is forever. `--once` runs one step for the first
 * runnable project and exits — the way to watch one step.
 *
 *   mc run start [flags]   the same runner, in the background, logging to
 *                          `~/mc/runner/log/runner.log`
 *   mc run stop            it finishes the round it is in, then exits
 *   mc run stop --force    it ends now, and the session it is holding with it
 *   mc run --update        it finishes the round, fast-forwards mc's own
 *                          checkout, and restarts itself on the new code
 *   mc run lanes [<n>]     how many steps may be in flight per repository;
 *                          no number prints it. Read at start, so a running
 *                          runner takes a new count on `--update`
 *
 * The three orders are files under `~/mc/runner/` read at a round boundary,
 * not signals: a runner ninety minutes into a headless session is given the
 * order without that session being interrupted. The rules are in
 * run-control.js.
 *
 * A run that is not `--once` holds the machine awake for its whole length
 * (stay-awake.js). That is the default rather than a flag to remember: this
 * laptop sleeps after one minute of idle on battery, and a runner waiting ten
 * minutes between rounds is doing exactly what that setting kills.
 * `--no-caffeinate` is the way out for somebody who wants the machine to be
 * allowed to sleep.
 */
import { LANES_MAX, readLaneCount, writeLaneCount } from '../lane-count.js';
import { requestUpdate, startRunner, stopRunner } from '../run-control.js';
import { runLoop } from '../run.js';
import { scanArgs } from './flags.js';

const USAGE = [
  'usage — mc run [--rounds <n>] [--once] [--no-merge] [--idle-sleep <seconds>] [--no-caffeinate]',
  '        mc run start [same flags]   the runner, in the background',
  '        mc run stop [--force]       after the round it is in, or now',
  '        mc run --update             after the round: new code, new process',
  `        mc run lanes [<n>]          steps in flight per repository, 1–${LANES_MAX}; no number prints it`,
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
    rounds: opts.rounds, once: opts.once, merge: opts.merge, idleSleepMs: opts.idleSleep * 1000, awake: opts.awake,
  });
}

/** One order to the runner, whichever of the three it is. */
function order(opts, deps) {
  if (opts.verb === 'start') return (deps.start || startRunner)({ argv: opts.pass, deps: deps.control });
  if (opts.verb === 'stop') return (deps.stop || stopRunner)({ force: opts.force, deps: deps.control });
  if (opts.verb === 'lanes') return lanes(opts, deps);
  return (deps.update || requestUpdate)({ deps: deps.control });
}

/** `mc run lanes [<n>]` — the count per repository, printed or set. */
function lanes(opts, deps) {
  const read = deps.readLanes || readLaneCount;
  const write = deps.writeLanes || writeLaneCount;
  if (opts.count === null) {
    const { per_repo: n } = read();
    return { ok: true, code: 0, lines: [`lanes ${n} — ${n === 1 ? 'one step' : `${n} steps`} in flight per repository`] };
  }
  const set = write(opts.count);
  if (!set.ok) return { ok: false, code: 2, lines: [set.reason] };
  return {
    ok: true,
    code: 0,
    lines: [
      `lanes ${set.count} — ${set.count === 1 ? 'one step' : `${set.count} steps`} in flight per repository from the next start`,
      'a running runner keeps its count: mc run --update takes the new one after the round it is in',
    ],
  };
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

  // The count, read or set. `mc run lanes` says it; `mc run lanes 4` writes
  // it and says a running runner takes it on `--update`.
  if (head === 'lanes') {
    const scanned = scanArgs(argv.slice(1), {});
    if (scanned.error) return { error: scanned.error };
    if (scanned.positional.length > 1) return { error: `lanes takes one number, not ${scanned.positional.join(' ')}` };
    return { verb: 'lanes', count: scanned.positional.length ? scanned.positional[0] : null };
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

/** The loop's own flags — for `mc run`, and for the `mc run start` behind it. */
function parseLoopArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--once', '--no-merge', '--no-caffeinate'],
    strictValues: ['--rounds', '--idle-sleep'],
  });
  if (scanned.error) return { error: scanned.error };
  if (scanned.positional.length) return { error: `unexpected argument ${scanned.positional[0]}` };
  const num = (value, fallback) => {
    if (value == null) return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : NaN;
  };
  const rounds = num(scanned.flags.rounds, 0);
  const idleSleep = num(scanned.flags.idleSleep ?? scanned.flags['idle-sleep'], 600);
  if (Number.isNaN(rounds)) return { error: '--rounds needs a whole number (0 = forever)' };
  if (Number.isNaN(idleSleep)) return { error: '--idle-sleep needs a whole number of seconds' };
  return {
    rounds,
    once: scanned.flags.once,
    merge: !scanned.flags.noMerge && !scanned.flags['no-merge'],
    idleSleep,
    awake: !scanned.flags.noCaffeinate && !scanned.flags['no-caffeinate'],
  };
}
