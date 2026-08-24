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
  describeStartFlags,
} from '../watch-sessions.js';
import { DEFAULT_INTERVAL_MS as SESSIONS_INTERVAL_MS } from '../watch-sessions-store.js';
import {
  startMainWatcher, stopMainWatcher, mainWatcherState, DEFAULT_INTERVAL_MS as MAIN_INTERVAL_MS,
} from '../watch-main.js';
import { scanArgs } from './flags.js';

/** The legs that exist. */
const TARGETS = ['pm', 'sessions', 'main'];
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
    start: (opts) => startSessionsWatcher({
      intervalMs: opts.intervalMs, model: opts.model, idleMs: opts.idleMs, groups: opts.groups,
    }),
    stop: () => stopSessionsWatcher(),
    state: () => sessionsWatcherState(),
    what: 'the session guard',
    intervalMs: SESSIONS_INTERVAL_MS,
    // `--model` is the guard's alone: it is the only leg that has one.
    flags: ['model', 'idle', 'group'],
    does: [
      'it flags waiting, silent, dead, unreachable, unattended, quiet-group, stalled, holding, blocked, quota-exhausted and error — only flags',
      'eight of the eleven are script, worked out for every conversation on the machine every round',
      'Haiku reads only the output that is prose, and only for a session whose output actually moved',
      'flags go to the notices ledger; dead, quota-exhausted, unattended and quiet-group knock on pm directly',
    ],
  },
  main: {
    start: (opts) => startMainWatcher({ intervalMs: opts.intervalMs, repo: opts.repo }),
    stop: () => stopMainWatcher(),
    state: () => mainWatcherState(),
    what: 'the main-watch',
    intervalMs: MAIN_INTERVAL_MS,
    flags: ['repo'],
    does: [
      'it measures the base branch per SHA — a pass where main has not moved costs one git fetch and no suite',
      'a moved main already measured green by the gate is green for free; only a landing that bypassed the gate is run',
      'it knocks pm the moment main goes red, names the new red, and lists the landings in the interval',
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
    if (!started.ok && started.reason === 'no-repo') {
      stderr.write('mc: mc watch main needs a repository — mc watch main start --repo <name>\n');
      return 1;
    }
    if (!started.ok) {
      stderr.write(`mc: could not start ${leg.what} (${started.reason})\n`);
      return 1;
    }
    stdout.write(`mc: watching ${opts.target} every ${seconds(started.interval_ms)} (pid ${started.pid})\n`);
    // The guard's flags, and where they came from: a bare start after a
    // stop is the last start again, and says so rather than silently being
    // a plainer guard (B4).
    if (started.flags) {
      const shown = opts.target === 'main'
        ? (started.flags.repo ? `--repo ${started.flags.repo}` : '')
        : describeStartFlags(started.flags);
      if (shown) stdout.write(`mc: ${started.remembered ? 'as last started: ' : 'with '}${shown}\n`);
    }
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
    const restarts = state.restarts ? `  ${c(`restarted on new code ${state.restarts}×`, 'grey')}` : '';
    lines.push(`  ${c('watching', 'green')}  pid ${state.pid}  every ${seconds(state.interval_ms)}${restarts}`);
    // The one failure mode the board could not see for a day: a live process
    // on yesterday's code. A watcher that knows to check restarts itself
    // within half a minute; one that does not is said as needing a hand.
    if (state.stale_code) {
      lines.push(`  ${c('OLD CODE', 'yellow')}  ${c(state.code
        ? 'mc changed on disk since it started — it restarts itself between passes'
        : `it started before mc knew to check — mc watch ${target} stop && mc watch ${target} start`, 'yellow')}`);
    }
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
  // The last knock, and what became of it. "Nothing to say" for six passes
  // and "refused every time" were the same silence on this page for a day —
  // and the difference was 188 knocks that never landed (B5).
  if (state.last_knock) {
    const knock = state.last_knock;
    const what = knock.woke ? c('woke', 'green')
      : knock.delivered ? c(`delivered, did not knock: ${knock.reason || 'unknown'}`, 'yellow')
        : c(`NOT DELIVERED: ${knock.reason || 'unknown'}`, 'red');
    lines.push(`  ${c('last knock', 'grey')}  ${ago(knock.at, now)}  ${what}`);
  }
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
    '        mc watch sessions start [--interval <seconds>] [--model <model>] [--idle <minutes>] [--group <prefix>]...\n',
    '        mc watch sessions stop\n',
    '        mc watch sessions status [--json]\n',
    '        mc watch main start [--interval <seconds>] --repo <name>\n',
    '        mc watch main stop\n',
    '        mc watch main status [--json]\n',
  ].join('');
}

export function parseArgs(argv) {
  // `--group` may repeat, which `scanArgs` does not do; it is picked out first.
  const groups = [];
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--group') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) return { target: null, verb: 'status', error: '--group needs a name prefix' };
      groups.push(argv[index + 1]);
      index += 1;
      continue;
    }
    rest.push(argv[index]);
  }
  const scanned = scanArgs(rest, { booleans: ['--json'], strictValues: ['--interval', '--model', '--idle', '--repo'] });
  const opts = {
    target: null, verb: 'status', json: scanned.flags.json, intervalMs: null, model: null, idleMs: null, groups, repo: scanned.flags.repo || null,
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
  if (scanned.flags.idle !== null) {
    if (!(LEGS[target].flags || []).includes('idle')) return { ...opts, error: `--idle belongs to mc watch sessions start` };
    if (verb !== 'start') return { ...opts, error: `--idle belongs to mc watch ${target} start` };
    const value = Number(scanned.flags.idle);
    if (!Number.isFinite(value) || value < 1) return { ...opts, error: '--idle needs a number of minutes' };
    opts.idleMs = Math.round(value * 60_000);
  }
  if (groups.length) {
    if (!(LEGS[target].flags || []).includes('group')) return { ...opts, error: `--group belongs to mc watch sessions start` };
    if (verb !== 'start') return { ...opts, error: `--group belongs to mc watch ${target} start` };
  }
  if (opts.json && verb !== 'status') return { ...opts, error: `--json belongs to mc watch ${target} status` };
  if (scanned.flags.repo !== null && scanned.flags.repo !== undefined) {
    if (!(LEGS[target].flags || []).includes('repo')) return { ...opts, error: `--repo belongs to mc watch main start` };
    if (verb !== 'start') return { ...opts, error: `--repo belongs to mc watch ${target} start` };
  }
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
