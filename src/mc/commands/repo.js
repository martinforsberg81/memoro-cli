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
 *   mc repo watch start|stop|status
 *   mc repo claim <repo> "<errand>" / release <repo> [--force] / who <repo>
 *
 * It reads. The one thing status writes is a `git fetch` — remote-tracking
 * refs and nothing else — and `--offline` removes even that, at the price of
 * saying so on the page rather than quietly showing yesterday's main. The
 * lease writes one file under mc's home and never inside a repository, and it
 * blocks nothing: git and gh are untouched by anything here.
 */
import { painter } from '../status-render.js';
import { leaseRow, renderRepoLines, renderWatchLines } from '../repo-render.js';
import { claimLease, currentHolder, readLease, releaseLease } from '../repo-lease.js';
import { readCombinedSnapshot } from '../repo-snapshot.js';
import { matchRepo, repoStatus, repoView } from '../repo-status.js';
import { startWatcher, stopWatcher, watcherState } from '../repo-watch.js';
import { scanArgs } from './flags.js';

const VERBS = ['status', 'watch', 'claim', 'release', 'who'];
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
  if (opts.verb !== 'status') return lease(opts, { stdout, stderr });

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

/**
 * Claim, release, who — the three words of the gate round.
 *
 * mc is strict with itself here and with nothing else: a claim on a
 * repository somebody else is holding is refused, and that refusal stops
 * exactly one thing — this command. Nobody's git is blocked, which is why the
 * message says who has it rather than pretending the work cannot proceed.
 */
async function lease(opts, { stdout, stderr }) {
  const c = painter(Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined);
  const repoPath = await resolveRepoPath(opts.repo);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${opts.repo}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }
  const holder = currentHolder();

  if (opts.verb === 'who') {
    const current = readLease(repoPath);
    if (opts.json) {
      stdout.write(`${JSON.stringify({ repo: repoPath, ...current }, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${leaseRow(c, current)}\n`);
    return 0;
  }

  if (opts.verb === 'claim') {
    const outcome = claimLease({ repoPath, errand: opts.errand, holder });
    if (!outcome.ok) {
      stderr.write(`mc: ${repoPath} is held by ${outcome.lease.holder} — ${leaseRow(c, outcome.lease)}\n`);
      stderr.write('mc: nothing is blocked; this is mc being strict with itself\n');
      stderr.write(`mc: if that round is over, mc repo release ${opts.repo} --force ends it — and says so in the log\n`);
      return 1;
    }
    if (outcome.already) {
      stdout.write(`mc: you already hold ${repoPath} — ${leaseRow(c, outcome.lease)}\n`);
      return 0;
    }
    stdout.write(`mc: ${holder.name} holds ${repoPath}${opts.errand ? ` for “${opts.errand}”` : ''}\n`);
    stdout.write(`mc: release it when the round is done — mc repo release ${opts.repo}\n`);
    return 0;
  }

  const outcome = releaseLease({ repoPath, holder, force: opts.force });
  if (!outcome.ok) {
    stderr.write(`mc: ${repoPath} is held by ${outcome.lease.holder}, not by you (${holder.name})\n`);
    stderr.write(`mc: mc repo release ${opts.repo} --force takes it anyway, and the log keeps that\n`);
    return 1;
  }
  if (!outcome.released) {
    stdout.write(`mc: ${repoPath} was already free\n`);
    return 0;
  }
  stdout.write(outcome.forced
    ? `mc: took the lease on ${repoPath} from ${outcome.lease.holder} — logged\n`
    : `mc: released ${repoPath}\n`);
  return 0;
}

/**
 * The lease verbs take one repository, named the way the view names them.
 *
 * Cheap first: the names in the last snapshot, then a path or a clone beside
 * the home directory — the same rule as `mc work add`. Only a name none of
 * those know costs a full count, because a claim should not wait on an
 * inspection of every checkout on the machine to find out where a name lives.
 */
async function resolveRepoPath(name) {
  const snapshot = readCombinedSnapshot();
  const roots = snapshot.kind === 'present'
    ? (snapshot.value.repos || []).map((repo) => repo.path)
    : [];
  const quick = matchRepo(name, roots);
  if (quick) return quick;
  const report = await repoStatus({ names: name ? [name] : null, offline: true });
  return report.repos[0]?.path || null;
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
    '        mc repo claim <repo> "<what for>"\n',
    '        mc repo release <repo> [--force]\n',
    '        mc repo who <repo> [--json]\n',
  ].join('');
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--json', '--offline', '--force'],
    strictValues: ['--interval'],
  });
  const opts = {
    verb: 'status',
    watch: 'status',
    names: [],
    repo: null,
    errand: '',
    force: scanned.flags.force,
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

  if (opts.verb === 'claim' || opts.verb === 'release' || opts.verb === 'who') {
    // A repository is required: these verbs are about one, and guessing from
    // the current directory would let a claim land on the wrong repository
    // from a shell somebody forgot they had moved.
    opts.repo = positional.shift() || null;
    if (!opts.repo) return { ...opts, error: `which repository? mc repo ${opts.verb} <repo>` };
    // The rest of the line is what the round is for. Requiring quotes around
    // it would be mc's grammar rather than the user's.
    opts.errand = positional.join(' ');
    if (opts.verb === 'claim' && !opts.errand) {
      return { ...opts, error: 'what for? mc repo claim <repo> "<what for>" — the errand is what makes a lease readable' };
    }
    if (opts.verb !== 'claim' && opts.errand) {
      return { ...opts, error: `mc repo ${opts.verb} takes one repository (${positional[0]})` };
    }
    if (opts.force && opts.verb !== 'release') {
      return { ...opts, error: '--force belongs to mc repo release' };
    }
    if (scanned.flags.interval !== null) return { ...opts, error: '--interval belongs to mc repo watch start' };
    return opts;
  }

  if (opts.force) return { ...opts, error: '--force belongs to mc repo release' };

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
