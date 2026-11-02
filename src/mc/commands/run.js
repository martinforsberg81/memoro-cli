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
 *                          `~/mc/runner/log/runner.log`. On a runner that
 *                          is stopping it takes over: a new runner on every
 *                          lane now, the old one finishes its steps
 *   mc run start --if-was-running
 *                          only when runner.json names a dead pid and no STOP
 *                          is written: the login agent's start after a restart
 *   mc run stop            it finishes the steps it is in, then exits
 *   mc run stop --force    it ends now, and the session it is holding with it
 *   mc run --update        it fast-forwards mc's own checkout and hands over
 *                          to a new runner on the new code, finishing only
 *                          the steps in flight (`mc run update` is the same).
 *                          On a stopping runner, it takes over as start does.
 *                          On a runner already on origin/main it writes
 *                          nothing and says so (`--force` writes anyway).
 *                          On a runner already draining it prints the drain
 *                          — since when, and the steps it waits on.
 *   mc run lanes [<n>]     how many headless sessions run at once, in total
 *                          across every repository and kind. No argument
 *                          prints it and what is running. Read live, so a
 *                          running runner takes a new count without
 *                          `--update`
 *   mc run --billing      plan usage and next billing for Claude and Codex
 *                          (`mc run billing` is the same). Billing is chosen
 *                          automatically at each new session.
 *   mc run --billing <claude|codex> <on|off>
 *                          whether that provider falls over to its API key
 *                          once its plan is spent; off keeps it on the plan
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
import { commandUsage } from '../command-help.js';
import { readBillingApi, readBillingState, writeBillingApi } from '../billing.js';
import { billingRoute, billingStatus } from '../billing-route.js';
import { readCapacity } from '../model-capacity.js';
import { LANES_REPLACED, readLaneCount, writeLaneCount } from '../lane-count.js';
import { runnerDir } from '../paths.js';
import { IF_WAS_RUNNING, requestUpdate, startRunner, stopRunner } from '../run-control.js';
import { REPO_NAMES, runLoop } from '../run.js';
import { pidAlive, readCurrents } from '../status-collect.js';
import { scanArgs } from './flags.js';

const USAGE = commandUsage('run');

export function usage() {
  return commandUsage('run');
}

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
    once: opts.once, merge: opts.merge, idleSleepMs: opts.idleSleep * 1000, awake: opts.awake, args: argv,
  });
}

/** One order to the runner, whichever of the three it is. */
function order(opts, deps) {
  if (opts.verb === 'start') return (deps.start || startRunner)({ argv: opts.pass, deps: deps.control });
  if (opts.verb === 'stop') return (deps.stop || stopRunner)({ force: opts.force, deps: deps.control });
  if (opts.verb === 'lanes') return lanes(opts, deps);
  if (opts.verb === 'billing') return billing(opts, deps);
  return (deps.update || requestUpdate)({ force: opts.force, deps: deps.control });
}

/**
 * `mc run lanes [<n>]` — the total, printed or set.
 *
 * One number: how many headless sessions run at once, across every repository
 * and every kind. Printed with how many are in flight while it is read, and
 * with the old setting it was read from when this read migrated one.
 */
function lanes(opts, deps) {
  const read = deps.readLanes || (() => readLaneCount({ repos: (deps.repos || REPO_NAMES).length }));
  const write = deps.writeLanes || writeLaneCount;

  if (opts.count === null) {
    const set = read();
    const lines = [`lanes ${set.lanes} — ${inFlight(deps)} of ${set.lanes} in flight, across every repository`];
    if (set.migrated) lines.push(`read from the old setting (per_repo ${set.migrated.per_repo ?? 'unset'}, total ${set.migrated.total ?? 'unset'}): the ${set.lanes} it allowed`);
    return { ok: true, code: 0, lines };
  }
  const written = write(opts.count);
  if (!written.ok) return { ok: false, code: 2, lines: [written.reason] };
  return {
    ok: true,
    code: 0,
    lines: [
      `lanes ${written.lanes} — applies now, across every repository`,
      'a running runner takes it at once: a new lane starts within half a minute, a lane above the new count ends after the session it is in',
    ],
  };
}

/** Billing status for both providers, after the API switch when one was given. */
function billing(opts, deps) {
  const now = (deps.now || (() => new Date()))();
  const root = runnerDir(deps.env || process.env);
  const readState = deps.readBillingState || (() => readBillingState({ root }));
  const readApi = deps.readBillingApi || (() => readBillingApi({ root }));
  if (opts.mode !== null) return { ok: false, code: 2, lines: ['billing mode is automatic: plan through 100 %, then API reserve — mc run --billing <claude|codex> <on|off> switches the API reserve'] };
  const lines = [];
  if (opts.api) {
    const written = (deps.writeBillingApi || ((provider, enabled) => writeBillingApi(provider, enabled, { root })))(opts.api.provider, opts.api.enabled);
    if (!written.ok) return { ok: false, code: 2, lines: [written.reason] };
    lines.push(`${opts.api.provider} API ${opts.api.enabled ? 'on' : 'off'} — applies from the next session; a running one keeps its billing`);
  }
  const capacity = (deps.readCapacity || (() => readCapacity({ root })))();
  const state = readState();
  const api = readApi();
  lines.push(`billing ${billingStatus({ capacity, state, api, now })}`);
  for (const provider of ['claude', 'codex']) {
    const next = billingRoute({ provider, capacity, state, api, now });
    lines.push(`next ${provider} session: ${next.billing === 'credits' ? 'API' : 'plan'} — ${next.why}`);
  }
  return { ok: true, code: 0, lines };
}

/**
 * How many sessions are in flight this second, from the `current-*.json`
 * files the runner keeps — one per lane, for as long as its session runs. A
 * file naming a dead pid is a killed runner's leftovers rather than a running
 * session, which is the test the page applies to the same files (`nowBlock`), so
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

  // `--if-was-running` is start's own, not the loop's: startRunner reads it
  // and the runner it spawns never sees it.
  if (head === 'start') {
    const opts = parseLoopArgs(argv.slice(1).filter((arg) => arg !== IF_WAS_RUNNING));
    return opts.error ? opts : { ...opts, verb: 'start', pass: argv.slice(1) };
  }

  // The total, read or set. `per_repo` and `--total` are answered by name
  // with what replaced them, rather than as an unknown flag.
  if (head === 'lanes') {
    const rest = argv.slice(1);
    if (rest.some((arg) => arg === '--total' || String(arg).startsWith('--total=') || arg === 'per_repo' || arg === '--per-repo')) return { error: LANES_REPLACED };
    const scanned = scanArgs(rest, {});
    if (scanned.error) return { error: scanned.error };
    if (scanned.positional.length > 1) return { error: `lanes takes one number, not ${scanned.positional.join(' ')}` };
    return { verb: 'lanes', count: scanned.positional.length ? scanned.positional[0] : null };
  }

  // The next provider route is automatic at each launch; the one thing set by
  // hand is whether a provider may fall over to its API key.
  // `mc run billing` and `mc run --billing` ask the same question.
  if (head === 'billing') argv = ['--billing', ...argv.slice(1)];
  if (argv.includes('--billing')) {
    const at = argv.indexOf('--billing');
    const rest = [...argv.slice(0, at), ...argv.slice(at + 1)];
    if (at === 0 && rest.length === 2 && ['on', 'off'].includes(rest[1])) {
      return { verb: 'billing', mode: null, api: { provider: rest[0], enabled: rest[1] === 'on' } };
    }
    const mode = rest.length === 1 && !String(rest[0]).startsWith('-') && at === 0 ? rest[0] : null;
    if (rest.length > 1 || (rest.length === 1 && mode === null)) {
      return { error: '--billing is one order on its own: mc run --billing [<claude|codex> <on|off>]' };
    }
    return { verb: 'billing', mode };
  }

  // An order, not a run: it takes nothing else, because everything else it
  // could take is a property of the runner that is already running.
  // `--force` is the one thing it takes: UPDATE written to a runner that is
  // already on origin/main, for a restart wanted for another reason.
  // `mc run update` is the same order: the page's menu takes `update`, and a
  // verb that is a flag in one place and a word in the other is one more
  // thing to remember.
  if (head === 'update') argv = ['--update', ...argv.slice(1)];
  if (argv.includes('--update')) {
    const rest = argv.filter((arg) => arg !== '--update' && arg !== '--force');
    if (rest.length || argv.length > 2) {
      return { error: '--update is one order on its own (--force aside) — the running runner keeps the flags it was started with' };
    }
    return { verb: 'update', force: argv.includes('--force') };
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
