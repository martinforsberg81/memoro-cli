/**
 * `mc repo` — a repository, seen whole.
 *
 * `mc status` groups by piece of work: what is each conversation doing. This
 * groups by repository, which is the other half of the same picture and the
 * one people were assembling by hand: what main is, which pull requests are
 * open and how far behind main they have drifted, which work areas are
 * standing on it, and whether the installation on this machine is in step.
 *
 *   mc repo status [repo] [--json] [--offline]
 *
 * It reads. The one thing it writes is a `git fetch` — remote-tracking refs
 * and nothing else — and `--offline` removes even that, at the price of
 * saying so on the page rather than quietly showing yesterday's main.
 */
import { renderRepoLines, renderWatchLines } from '../repo-render.js';
import { repoView } from '../repo-status.js';
import { startWatcher, stopWatcher, watcherState } from '../repo-watch.js';
import { scanArgs } from './flags.js';

const VERBS = ['status', 'watch'];
const WATCH_VERBS = ['start', 'stop', 'status'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }

  if (opts.verb === 'watch') return watch(opts, { stdout, stderr });

  const report = await repoView({ names: opts.names, offline: opts.offline });

  if (opts.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(`${renderRepoLines(report, {
      columns: stdout.columns || 100,
      colour: Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined,
    }).join('\n')}\n`);
  }

  // A name that matched nothing is the one thing here that is an error: the
  // question was about a particular repository and it was not answered.
  if (report.unknown.length) {
    for (const name of report.unknown) {
      stderr.write(`mc: no repository called "${name}" — mc repo status lists the ones mc can see\n`);
    }
    return 1;
  }
  return 0;
}

/**
 * Start it, stop it, or ask after it.
 *
 * Explicit on purpose: the first `mc repo status` does not conjure a watcher
 * up. A background process that appears because somebody read a page is a
 * process nobody remembers starting, and a machine with an unknown number of
 * them is what the pid file exists to prevent.
 */
async function watch(opts, { stdout, stderr }) {
  if (opts.watch === 'start') {
    const started = startWatcher({ intervalMs: opts.intervalMs });
    if (!started.ok && started.reason === 'already-running') {
      stdout.write(`mc: the watcher is already running (pid ${started.pid}, every ${seconds(started.interval_ms)})\n`);
      return 0;
    }
    if (!started.ok) {
      stderr.write(`mc: could not start the watcher (${started.reason})\n`);
      return 1;
    }
    stdout.write(`mc: watching every ${seconds(started.interval_ms)} (pid ${started.pid})\n`);
    stdout.write(`mc: it writes ${started.log.replace(/watcher\.log$/u, '')} and nothing else\n`);
    stdout.write('mc: mc repo status now reads what it writes\n');
    return 0;
  }

  if (opts.watch === 'stop') {
    const stopped = await stopWatcher();
    if (!stopped.stopped) {
      stdout.write(stopped.abandoned
        ? 'mc: no watcher was running — cleared the pid file it left behind\n'
        : 'mc: no watcher is running\n');
      return 0;
    }
    stdout.write(`mc: stopped the watcher (pid ${stopped.pid})${stopped.forced ? ' — it had to be killed' : ''}\n`);
    return 0;
  }

  const state = watcherState();
  if (opts.json) {
    stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }
  stdout.write(`${renderWatchLines(state, {
    columns: stdout.columns || 100,
    colour: Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined,
  }).join('\n')}\n`);
  return 0;
}

function seconds(ms) {
  const value = Math.round((Number(ms) || 0) / 1000);
  return `${value}s`;
}

function usage() {
  return [
    'usage — mc repo status [repo] [--json] [--offline]\n',
    '        mc repo watch start [--interval <seconds>]\n',
    '        mc repo watch stop\n',
    '        mc repo watch status [--json]\n',
  ].join('');
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--json', '--offline'],
    strictValues: ['--interval'],
  });
  const opts = {
    verb: 'status',
    watch: 'status',
    names: [],
    json: scanned.flags.json,
    offline: scanned.flags.offline,
    intervalMs: 60_000,
  };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];
  // Bare `mc repo` is the whole view, and bare `mc repo watch` is the
  // question about the watcher. Making the verb compulsory would be mc's
  // grammar rather than the user's.
  if (VERBS.includes(positional[0])) opts.verb = positional.shift();

  if (scanned.flags.interval !== null) {
    const value = Number(scanned.flags.interval);
    if (!Number.isFinite(value) || value < 1) return { ...opts, error: '--interval needs a number of seconds' };
    opts.intervalMs = Math.round(value * 1000);
  }

  if (opts.verb === 'watch') {
    const word = positional.shift() || 'status';
    if (!WATCH_VERBS.includes(word)) {
      return { ...opts, error: `mc repo watch ${word}? — start, stop or status` };
    }
    opts.watch = word;
    if (positional.length) return { ...opts, error: `mc repo watch takes no repository (${positional[0]})` };
    return opts;
  }

  if (scanned.flags.interval !== null) {
    return { ...opts, error: '--interval belongs to mc repo watch start' };
  }
  opts.names = positional;
  return opts;
}
