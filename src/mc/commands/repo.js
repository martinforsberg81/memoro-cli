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
 *   mc repo merge <repo> <pr> [--check]
 *
 * It reads. The one thing status writes is a `git fetch` — remote-tracking
 * refs and nothing else — and `--offline` removes even that, at the price of
 * saying so on the page rather than quietly showing yesterday's main. The
 * lease writes one file under mc's home and never inside a repository, and it
 * blocks nothing: git and gh are untouched by anything here.
 */
import { painter } from '../status-render.js';
import { leaseRow, livenessRow, renderRepoLines, renderWatchLines } from '../repo-render.js';
import { claimLease, readLease, releaseLease } from '../repo-lease.js';
import { currentHolder } from '../work-identity.js';
import { runGate } from '../repo-gate.js';
import { runMergeRound } from '../repo-merge.js';
import { livenessForLeases } from '../lease-liveness.js';
import { readCombinedSnapshot } from '../repo-snapshot.js';
import { matchRepo, repoStatus, repoView } from '../repo-status.js';
import { startWatcher, stopWatcher, watcherState } from '../repo-watch.js';
import { scanArgs } from './flags.js';

const VERBS = ['status', 'watch', 'claim', 'release', 'who', 'merge'];
const WATCH_VERBS = ['start', 'stop', 'status'];
const LEASE_VERBS = ['claim', 'release', 'who'];

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
  if (opts.verb === 'merge') return gate(opts, { stdout, stderr });
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
    // Asked of the board, not of a clock. The age above says how long the
    // round has run; this says whether it is still running, which is the
    // question somebody weighing a `--force` is actually asking.
    const answers = await livenessForLeases([current]);
    const liveness = current.held ? answers.get(current.holder) ?? null : null;
    if (opts.json) {
      stdout.write(`${JSON.stringify({ repo: repoPath, ...current, liveness }, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${leaseRow(c, current)}\n`);
    const live = livenessRow(c, current, liveness);
    if (live) stdout.write(`${live}\n`);
    return 0;
  }

  if (opts.verb === 'claim') {
    const outcome = claimLease({ repoPath, errand: opts.errand, holder });
    if (!outcome.ok) {
      stderr.write(`mc: ${repoPath} is held by ${outcome.lease.holder} — ${leaseRow(c, outcome.lease)}\n`);
      // This is the moment somebody decides whether the other round is dead,
      // and the sentence below offers them `--force`. Saying how long it has
      // been held without saying whether it is still running is what nearly
      // ended a live round at 27 minutes.
      const answers = await livenessForLeases([outcome.lease]);
      const live = livenessRow(c, outcome.lease, answers.get(outcome.lease.holder));
      if (live) stderr.write(`mc: ${live}\n`);
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
 * `mc repo merge <repo> <pr> --check` — the gate round, run and reported.
 *
 * Only `--check` for now, and the flag is compulsory rather than a default:
 * there is no merge in the code behind it, so a command that read as though it
 * might merge would be promising something it cannot do. When merging arrives
 * it arrives as its own step, and the flag is what will tell the two apart.
 *
 * Progress goes to stderr and the verdict to stdout, so the round can be left
 * running in the background with its JSON collected from one and its liveness
 * watched on the other. That split is the whole accommodation this needs: the
 * suite takes tens of minutes, and nothing here holds a terminal or asks a
 * question.
 */
async function gate(opts, { stdout, stderr }) {
  const repoPath = await resolveRepoPath(opts.repo);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${opts.repo}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }

  // The holder is read here, in the shell the operator is actually standing
  // in. Everything after this runs in temporary worktrees outside the work
  // root, where the same question would answer `user@host` instead.
  const holder = currentHolder();
  const round = { repoPath, pr: opts.pr, holder, onProgress: (message) => stderr.write(`mc: ${message}\n`) };
  const report = opts.check ? await runGate(round) : await runMergeRound(round);

  if (opts.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  const lines = opts.check ? gateLines(report) : mergeLines(report);
  for (const line of lines) stdout.write(`${line}\n`);
  return report.ok ? 0 : 1;
}

/**
 * What a merge round did, in prose.
 *
 * The gate's own lines are reused for the measurement, because it is the same
 * measurement; what is added is what became of it. A round that stopped says
 * plainly that nothing was merged, since the whole risk of a verb like this is
 * somebody reading a stop as a quiet success.
 */
function mergeLines(report) {
  const lines = [];
  if (report.gate) {
    lines.push(...gateLines(report.gate));
  } else {
    lines.push(`mc: the round stopped at ${report.stopped_at} — ${report.reason}`);
  }

  if (!report.ok) {
    if (report.gate?.ok) lines.push(`mc: stopped before merging — ${report.reason}`);
    lines.push('mc: nothing was merged');
    return lines;
  }

  lines.push(`mc: merged #${report.pr.number} as ${String(report.merge_commit || '').slice(0, 7)} (squash)`);
  if (report.deploy?.attempted) {
    lines.push(report.deploy.ok
      ? `mc: pulled ${report.deploy.command} at ${report.deploy.root}`
      : `mc: could not pull ${report.deploy.root} (${report.deploy.reason}) — the merge stands; pull by hand`);
  }
  if (report.log_path) lines.push(`mc: logged to ${report.log_path}`);
  return lines;
}

/**
 * The verdict in prose — and never the word "approved".
 *
 * The gate reads tests. Whether the change is the right change is a question
 * about the diff and its contract, which nothing here has looked at, so the
 * lines below say what was measured and leave the rest to whoever reviews it.
 */
function gateLines(report) {
  const lines = [];
  const pr = report.pr.head ? `#${report.pr.number} (${report.pr.head} → ${report.pr.base})` : `#${report.pr.number}`;

  if (report.stopped_at && report.stopped_at !== 'red') {
    lines.push(`mc: the round stopped at ${report.stopped_at} — ${report.reason}`);
    lines.push('mc: nothing was measured, and nothing was merged');
    return lines;
  }

  // Both of these are commits inside the gate's throwaway worktrees — the base
  // branch, and the PR's head with the base merged into it. Neither is the
  // branch head somebody would see with `git log` on the branch, and saying
  // which is which is cheaper than a reviewer working it out.
  lines.push(`mc: ${pr}`);
  lines.push(`mc: baseline  ${report.baseline.commit?.slice(0, 7)} (${report.pr.base} as fetched)  ${count(report.baseline)}`);
  lines.push(`mc: candidate ${report.candidate.commit?.slice(0, 7)} (${report.pr.head} + ${report.pr.base} merged in)  ${count(report.candidate)}`);

  if (report.broke.length) {
    lines.push(`mc: RED — ${report.broke.length} red on the candidate and green on the baseline:`);
    for (const name of report.broke.slice(0, 20)) lines.push(`      ${name}`);
    if (report.broke.length > 20) lines.push(`      … and ${report.broke.length - 20} more`);
    lines.push('mc: not merged, and this verb would not have merged it either');
    return lines;
  }

  if (report.fixed.length) lines.push(`mc: ${report.fixed.length} that were red on the baseline are green here`);
  lines.push('mc: GREEN — the test gate passes. It says nothing about whether the change is right;');
  lines.push('mc: that is the review, and it is still somebody\'s to do');
  lines.push('mc: --check only: this verb does not merge');
  return lines;
}

function count(side) {
  const red = side.red.length;
  return `${side.totals.tests} tests, ${red} red name${red === 1 ? '' : 's'}`;
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
    '        mc repo merge <repo> <pr> [--check] [--json]\n',
  ].join('');
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--json', '--offline', '--force', '--check'],
    strictValues: ['--interval'],
  });
  const opts = {
    verb: 'status',
    watch: 'status',
    names: [],
    repo: null,
    pr: null,
    errand: '',
    force: scanned.flags.force,
    check: scanned.flags.check,
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

  if (opts.verb === 'merge') {
    opts.repo = positional.shift() || null;
    if (!opts.repo) return { ...opts, error: 'which repository? mc repo merge <repo> <pr> --check' };
    // `#346` and `346` are the same pull request, and a person who copied the
    // number off a page brings the hash with it.
    const number = String(positional.shift() || '').replace(/^#/u, '');
    if (!number) return { ...opts, error: 'which pull request? mc repo merge <repo> <pr> --check' };
    if (!/^\d+$/u.test(number)) return { ...opts, error: `"${number}" is not a pull request number` };
    opts.pr = Number(number);
    if (positional.length) return { ...opts, error: `mc repo merge takes one repository and one pull request (${positional[0]})` };
    // `--check` runs the gate and stops there; without it the same round also
    // lands the change. There is no third mode, and in particular nothing that
    // merges a red gate: overruling one is the human's call and should cost a
    // human action rather than a flag.
    if (opts.force) return { ...opts, error: '--force belongs to mc repo release' };
    if (scanned.flags.interval !== null) return { ...opts, error: '--interval belongs to mc repo watch start' };
    return opts;
  }

  if (opts.check) return { ...opts, error: '--check belongs to mc repo merge' };

  if (LEASE_VERBS.includes(opts.verb)) {
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
