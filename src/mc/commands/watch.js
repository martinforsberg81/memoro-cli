/**
 * `mc watch` — the autonomy loop's background processes.
 *
 *   mc watch pm start|stop|status
 *   mc watch sessions start|stop|status
 *
 * One verb with a target rather than a verb per leg, because they are one
 * mechanism with parts (designnote §2): the round knocks, the guard flags,
 * and both are the same daemon form with the same three words.
 *
 * `mc pm watch` was ruled out and it is worth saying why here, where somebody
 * will wonder: `mc pm <id>` takes a conversation id as a positional, so
 * `watch` would be read as an id prefix — a silent divergence (D-0100) built
 * on purpose. `heartbeat` was ruled out too: the broker layer already has one
 * (`src/commands/heartbeat-loop.js`), and two things with one name is two
 * things nobody can grep for.
 */
import { painter } from '../status-render.js';
import { startPmWatcher, stopPmWatcher, pmWatcherState } from '../watch-pm.js';
import { DEFAULT_INTERVAL_MS as PM_INTERVAL_MS } from '../watch-pm-round.js';
import {
  startSessionsWatcher, stopSessionsWatcher, sessionsWatcherState,
} from '../watch-sessions.js';
import { DEFAULT_INTERVAL_MS as SESSIONS_INTERVAL_MS } from '../watch-sessions-store.js';
import { scanArgs } from './flags.js';

/** The legs that exist. */
const TARGETS = ['pm', 'sessions'];
const VERBS = ['start', 'stop', 'status'];

const LEGS = {
  pm: {
    start: (opts) => startPmWatcher({ intervalMs: opts.intervalMs }),
    stop: () => stopPmWatcher(),
    state: () => pmWatcherState(),
    what: 'the PM round',
    intervalMs: PM_INTERVAL_MS,
    does: [
      'it commits pm/, runs mc doctor, counts pm/inbox/ and delivers the guard\'s notices',
      'it knocks when the unprocessed set gains a member, reminds once after three passes, then goes quiet',
      'it is a script: an empty inbox costs a few file reads and no model turn at all',
    ],
  },
  sessions: {
    start: (opts) => startSessionsWatcher({ intervalMs: opts.intervalMs, model: opts.model }),
    stop: () => stopSessionsWatcher(),
    state: () => sessionsWatcherState(),
    what: 'the session guard',
    intervalMs: SESSIONS_INTERVAL_MS,
    // `--model` is the guard's alone: it is the only leg that has one.
    flags: ['model'],
    does: [
      'it flags waiting, silent, dead, unreachable, stalled, blocked, quota-exhausted and error — only flags',
      'five of the eight are script, worked out for every conversation on the machine every round',
      'Haiku reads only the output that is prose, and only for a session whose output actually moved',
      'flags go to the notices ledger; only dead and quota-exhausted knock on pm directly',
    ],
  },
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  const leg = LEGS[opts.target];

  if (opts.verb === 'start') {
    const started = leg.start(opts);
    if (!started.ok && started.reason === 'already-running') {
      stdout.write(`mc: ${leg.what} is already running (pid ${started.pid}, every ${seconds(started.interval_ms)})\n`);
      return 0;
    }
    if (!started.ok) {
      stderr.write(`mc: could not start ${leg.what} (${started.reason})\n`);
      return 1;
    }
    stdout.write(`mc: watching ${opts.target} every ${seconds(started.interval_ms)} (pid ${started.pid})\n`);
    for (const line of leg.does) stdout.write(`mc: ${line}\n`);
    stdout.write(`mc: it logs to ${started.log}\n`);
    return 0;
  }

  if (opts.verb === 'stop') {
    const stopped = await leg.stop();
    if (!stopped.stopped) {
      stdout.write(stopped.abandoned
        ? `mc: ${leg.what} was not running — cleared the pid file it left behind\n`
        : `mc: ${leg.what} is not running\n`);
      return 0;
    }
    stdout.write(`mc: stopped ${leg.what} (pid ${stopped.pid})${stopped.forced ? ' — it had to be killed' : ''}\n`);
    return 0;
  }

  const state = leg.state();
  if (opts.json) {
    stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }
  stdout.write(`${renderWatchLines(state, {
    target: opts.target,
    colour: Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined,
  }).join('\n')}\n`);
  return 0;
}

/**
 * Running or not, how often, when it last ran, and what it saw.
 *
 * The last line is the round's own summary of its last pass, verbatim — the
 * same sentence that is in the log. A page that paraphrased it would be a
 * second opinion about a pass nobody watched.
 */
export function renderWatchLines(state, { target = 'pm', colour = false, now = Date.now() } = {}) {
  const c = painter(colour);
  const lines = [''];
  if (state.running) {
    lines.push(`  ${c('watching', 'green')}  pid ${state.pid}  every ${seconds(state.interval_ms)}`);
  } else if (state.abandoned) {
    lines.push(`  ${c('not running', 'yellow')}  ${c(`— a pid file was left behind; mc watch ${target} stop clears it`, 'grey')}`);
  } else {
    lines.push(`  ${c('not running', 'grey')}  ${c(`— mc watch ${target} start`, 'grey')}`);
  }
  const when = state.last_write_at
    ? `${ago(state.last_write_at, now)}${state.stale ? c('  STALE', 'yellow') : ''}`
    : c('never', 'grey');
  lines.push(`  ${c('last round', 'grey')}  ${when}`);
  if (state.last_round) lines.push(`              ${c(state.last_round, 'grey')}`);
  // Whatever this leg has to add about itself, in the order it gave it. The
  // guard puts its standing flags here; a leg with nothing to add says
  // nothing, and the renderer stays one renderer.
  for (const line of state.detail || []) lines.push(`    ${c(line, 'grey')}`);
  lines.push(`  ${c('log', 'grey')}  ${c(state.log, 'grey')}`);
  lines.push('');
  return lines;
}

function usage() {
  return [
    'usage — mc watch pm start [--interval <seconds>]\n',
    '        mc watch pm stop\n',
    '        mc watch pm status [--json]\n',
    '        mc watch sessions start [--interval <seconds>] [--model <model>]\n',
    '        mc watch sessions stop\n',
    '        mc watch sessions status [--json]\n',
  ].join('');
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--interval', '--model'] });
  const opts = {
    target: null, verb: 'status', json: scanned.flags.json, intervalMs: null, model: null,
  };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];

  // The target is required. Bare `mc watch` cannot mean "all of them": start
  // and stop would then act on legs the caller never named, and one of them
  // is a model with a toggle Martin decides.
  const target = positional.shift();
  if (!target) return { ...opts, error: `mc watch what? — ${TARGETS.join(', ')}` };
  if (!TARGETS.includes(target)) return { ...opts, error: `mc watch ${target}? — ${TARGETS.join(', ')}` };
  opts.target = target;
  opts.intervalMs = LEGS[target].intervalMs;

  const verb = positional.shift() || 'status';
  if (!VERBS.includes(verb)) return { ...opts, error: `mc watch ${target} ${verb}? — start, stop or status` };
  opts.verb = verb;
  if (positional.length) return { ...opts, error: `mc watch ${target} ${verb} takes no more words (${positional[0]})` };

  if (scanned.flags.interval !== null) {
    if (verb !== 'start') return { ...opts, error: `--interval belongs to mc watch ${target} start` };
    const value = Number(scanned.flags.interval);
    if (!Number.isFinite(value) || value < 1) return { ...opts, error: '--interval needs a number of seconds' };
    opts.intervalMs = Math.round(value * 1000);
  }
  if (scanned.flags.model !== null) {
    // Named per leg rather than globally: a flag accepted everywhere and
    // honoured in one place is a flag that silently does nothing.
    if (!(LEGS[target].flags || []).includes('model')) {
      return { ...opts, error: `mc watch ${target} has no model — it is a script` };
    }
    if (verb !== 'start') return { ...opts, error: `--model belongs to mc watch ${target} start` };
    opts.model = String(scanned.flags.model);
  }
  if (opts.json && verb !== 'status') return { ...opts, error: `--json belongs to mc watch ${target} status` };
  return opts;
}

function seconds(ms) {
  return `${Math.round((Number(ms) || 0) / 1000)}s`;
}

function ago(at, now) {
  const ms = Math.max(0, now - Date.parse(at));
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}
