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
import { basename } from 'node:path';

import { painter } from '../status-render.js';
import { leaseRow, livenessRow, renderRepoLines, renderWatchLines } from '../repo-render.js';
import { claimLease, readLease, releaseLease } from '../repo-lease.js';
import { installPushGuard, pushCheckLines, pushGuardState, pushVerdict } from '../push-guard.js';
import { currentHolder } from '../work-identity.js';
import { runGate, verdictHeadline } from '../repo-gate.js';
import { runMergeRound } from '../repo-merge.js';
import { countRounds, readRounds, recordRound, recordRoundStart } from '../repo-round-log.js';
import { livenessForLeases } from '../lease-liveness.js';
import { readCombinedSnapshot } from '../repo-snapshot.js';
import { matchRepo, repoStatus, repoView } from '../repo-status.js';
import { startWatcher, stopWatcher, watcherState } from '../repo-watch.js';
import { scanArgs } from './flags.js';

const VERBS = ['status', 'watch', 'claim', 'release', 'who', 'merge', 'rounds', 'guard', 'push-check'];
// `merge` stays in the list only so the old spelling can be answered with
// where it went; it is not a verb here any more.
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
  if (opts.verb === 'merge') {
    stderr.write('mc: mc repo merge is now mc merge — same round, its own door: mc merge <repo> <pr> [--check] | --docs\n');
    return 2;
  }
  if (opts.verb === 'rounds') return rounds(opts, { stdout });
  if (opts.verb === 'guard') return guard(opts, { stdout, stderr });
  if (opts.verb === 'push-check') return pushCheck(opts, { stdout, stderr, stdin: deps.stdin || process.stdin, env: deps.env || process.env, git: deps.git, gh: deps.gh });
  if (opts.verb !== 'status') return lease(opts, { stdout, stderr, tell: deps.tell || null });

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
async function lease(opts, { stdout, stderr, tell = null }) {
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
 * `mc merge <repo> <pr>` — the gate round, and what becomes of it.
 *
 * The round is still here; only its door moved (`commands/merge.js`), and
 * `mc repo merge` answers with where it went.
 *
 * Two modes and no third. Without a flag the round gates and, only on green,
 * lands the change; `--check` runs the same round and stops at the verdict,
 * which is what a surface without merge authority needs. What does not exist is
 * a way to land a change the gate called red — not a flag, not an option, not
 * an environment variable. Overruling a red gate is the human's call and should
 * cost a human action, visible as one.
 *
 * The dispatch is here; the two rounds are `repo-gate.js` and `repo-merge.js`,
 * and the separation between them is load-bearing rather than tidy: the gate
 * cannot merge at all, so nothing reaches a merge except through a report a
 * module with no opinion about merging marked green.
 *
 * Progress goes to stderr and the verdict to stdout, so the round can be left
 * running in the background with its JSON collected from one and its liveness
 * watched on the other. That split is the whole accommodation this needs: the
 * suite takes tens of minutes, and nothing here holds a terminal or asks a
 * question.
 */
/**
 * `mc repo rounds` — the count A7 exists for. Every round, by where it
 * ended, and how many pull requests actually landed; `--json` is the raw
 * lines for anything that wants to count differently.
 */
function rounds(opts, { stdout }) {
  const { rounds: all, skipped } = readRounds();
  if (opts.json) {
    stdout.write(`${JSON.stringify({ rounds: all, skipped }, null, 2)}\n`);
    return 0;
  }
  if (!all.length) {
    stdout.write('mc: no rounds recorded yet — every mc merge and --check from now on leaves a line\n');
    return 0;
  }
  const counted = countRounds(all);
  stdout.write(`mc: ${counted.rounds} round${counted.rounds === 1 ? '' : 's'} recorded, ${counted.merged_prs} pull request${counted.merged_prs === 1 ? '' : 's'} landed\n`);
  for (const [stop, count] of Object.entries(counted.by_stop).sort((a, b) => b[1] - a[1])) {
    stdout.write(`mc:   ${String(stop === 'completed' ? 'reached its end' : `stopped at ${stop}`).padEnd(24)} ${count}\n`);
  }
  if (skipped) stdout.write(`mc: ${skipped} line${skipped === 1 ? '' : 's'} could not be read, and ${skipped === 1 ? 'is' : 'are'} counted nowhere\n`);
  return 0;
}

/**
 * The one verb the pm-helper's overlay does not carry, enforced by the tool
 * rather than remembered by the role: merge without --check lands code, and
 * the helper produces evidence — never decisions.
 */
export function helperMergeRefusal(holder, { check = false } = {}) {
  if (check) return null;
  if (holder?.kind !== 'work-area') return null;
  if (!['pm-helper', 'helper'].includes(String(holder.name || '').toLowerCase())) return null;
  return 'REFUSED — the pm-helper\'s tool does not carry mc merge without --check: the helper produces evidence, the PM makes decisions (design note §5)';
}

export async function gate(opts, { stdout, stderr }) {
  const repoPath = await resolveRepoPath(opts.repo);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${opts.repo}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }

  // The holder is read here, in the shell the operator is actually standing
  // in. Everything after this runs in temporary worktrees outside the work
  // root, where the same question would answer `user@host` instead.
  const holder = currentHolder();
  // The helper's tool does not carry the landing form (design note §5,
  // ratified 2026-08-17): the helper produces evidence, the PM makes
  // decisions, and the role must not have to remember the boundary.
  const refusal = helperMergeRefusal(holder, { check: opts.check });
  if (refusal) {
    stderr.write(`mc: ${refusal}\n`);
    stderr.write(`mc: the measurement is its own verb, and this role may run it: mc test ${opts.repo} ${opts.pr || (opts.prs || []).join(' ')}\n`);
    return 2;
  }
  const mode = opts.check ? 'check' : 'merge';
  // Before any work: a round that is killed mid-flight writes no end line, and
  // the start is the only trace it will ever leave (2026-08-30).
  recordRoundStart({
    repo: repoPath, mode, holder: holder?.name || null,
    prs: opts.prs?.length ? opts.prs : [opts.pr].filter(Boolean),
  });
  const round = { repoPath, pr: opts.pr, prs: opts.prs, full: Boolean(opts.full), holder, onProgress: (message) => stderr.write(`mc: ${message}\n`) };
  const report = opts.check ? await runGate(round) : await runMergeRound(round);
  // Every round leaves a line — merged, stopped, refused — so "has the gate
  // ever caught anything?" is a count, not a reading of survivors (A7).
  recordRound(report, { mode });

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
  if (report.batch) return batchLines(report);
  if (report.gate) {
    lines.push(...gateLines(report.gate));
  } else {
    lines.push(`mc: the round stopped at ${report.stopped_at} — ${report.reason}`);
  }

  if (!report.ok) {
    // "Nothing was merged" is a claim, and after a network error it was once
    // false (#10844: GitHub performed the merge and timed out on the reply).
    // When the round could not read back what happened, it says that.
    if (report.stopped_at === 'merge-unknown') {
      lines.push(`mc: whether #${report.pr.number} merged is UNKNOWN — ${report.reason}`);
      lines.push('mc: nothing is claimed either way; nothing was pulled or logged');
      return lines;
    }
    if (report.gate?.ok) lines.push(`mc: stopped before merging — ${report.reason}`);
    lines.push('mc: nothing was merged');
    return lines;
  }

  // Into what, every time. "merged as <sha>" was true of a PR that landed on
  // its stacked base branch, and it was read as "on main" by everyone.
  lines.push(`mc: merged #${report.pr.number} into ${report.merged_into || report.pr.base} as ${String(report.merge_commit || '').slice(0, 7)} (squash)`);
  lines.push(...treeIdentityLines(report));
  if (report.off_default) {
    lines.push(`mc: WARNING — ${report.merged_into} is not the default branch (${report.default_branch}): this landed on a branch, not on ${report.default_branch}`);
  }
  if (report.deploy?.attempted) {
    lines.push(report.deploy.ok
      ? `mc: pulled ${report.deploy.command} at ${report.deploy.root}`
      : `mc: could not pull ${report.deploy.root} (${report.deploy.reason}) — the merge stands; pull by hand`);
  }
  if (report.log_path) lines.push(`mc: logged to ${report.log_path}`);
  return lines;
}

/**
 * A batch round, in prose: the one measurement, then what became of each
 * pull request — and, when the batch stopped and the round fell back, each
 * single round's own lines under its number. Nothing here may read as
 * "all landed" when one did not.
 */
function batchLines(report) {
  const lines = [];
  const { batch } = report;
  lines.push(`mc: batch of ${batch.prs.length} — ${batch.prs.map((n) => `#${n}`).join(' ')} — measured as one candidate`);
  if (report.gate) lines.push(...gateLines(report.gate));
  if (batch.fallback) {
    lines.push(`mc: the batch stopped at ${report.gate?.stopped_at} — fell back to one round per pull request`);
    for (const round of batch.rounds) {
      lines.push(`mc: ── #${round.pr.number} ──`);
      for (const line of mergeLines(round)) lines.push(`  ${line}`);
    }
  } else if (!report.ok) {
    if (report.stopped_at === 'merge-unknown') {
      lines.push(`mc: whether a pull request merged is UNKNOWN — ${report.reason}`);
      lines.push('mc: nothing is claimed either way; nothing was pulled or logged');
      return lines;
    }
    if (report.gate?.ok) lines.push(`mc: stopped before merging all of them — ${report.reason}`);
  }
  for (const item of batch.merges) {
    lines.push(item.merged
      ? `mc: merged #${item.number} into ${report.merged_into || report.pr.base} as ${String(item.merge_commit || '').slice(0, 7)} (squash)`
      : `mc: #${item.number} NOT merged — ${item.error}`);
  }
  const notTried = batch.prs.filter((n) => !batch.merges.some((item) => item.number === n));
  if (notTried.length) lines.push(`mc: not merged: ${notTried.map((n) => `#${n}`).join(' ')}`);
  lines.push(...treeIdentityLines(report));
  if (report.ok && report.off_default) {
    lines.push(`mc: WARNING — ${report.merged_into} is not the default branch (${report.default_branch}): this landed on a branch, not on ${report.default_branch}`);
  }
  if (report.deploy?.attempted) {
    lines.push(report.deploy.ok
      ? `mc: pulled ${report.deploy.command} at ${report.deploy.root}`
      : `mc: could not pull ${report.deploy.root} (${report.deploy.reason}) — the merge stands; pull by hand`);
  }
  if (report.log_path) lines.push(`mc: logged to ${report.log_path}`);
  return lines;
}

/**
 * Did main become exactly what was measured? Identity, said either way —
 * "verified together" and "landed one at a time" are different claims, and
 * the reader deciding whether to trust the green needs to know which one
 * they are holding (track 3, 2026-08-23).
 */
function treeIdentityLines(report) {
  if (report.tree_identical === true) return ['mc: the landed tree is byte-identical to the measured candidate — the green transfers by identity'];
  if (report.tree_identical === false) return ['mc: WARNING — the landed tree is NOT the measured candidate\'s: the sequential squashes resolved something differently; the green does not transfer, and the next round measures main as it stands'];
  return [];
}

/** The gates of one kind, from the one list the round keeps them all in. */
function selectedGates(report, source = 'selection') {
  return (report.extra_gates || []).filter((gate) => (gate.source || 'declaration') === source);
}

/**
 * Which repository, which pull request, against what.
 *
 * The repository is in it because a verdict gets pasted into a pull request or
 * a plan and read somewhere other than the shell that produced it, where
 * `#400` alone names nothing.
 */
function subjectOf(report) {
  const name = basename(report.repo || '') || report.repo || 'the repository';
  // `--full` has no pull request: what it measured is a branch.
  if (report.pr?.number === null || report.pr?.number === undefined) {
    return `${name} ${report.base?.ref || 'the default branch'}`;
  }
  const heads = report.prs ? report.prs.map((item) => `#${item.number}`).join(' + ') : `#${report.pr.number}`;
  const head = !report.prs && report.pr.head ? ` (${report.pr.head})` : '';
  return `${name} ${heads}${head} → ${report.pr.base}`;
}

/**
 * What ran, as counts.
 *
 * The counts are the reach, and they replaced the sentence that used to carry
 * it — *"measured over the 17 test files this change reaches, not the whole
 * suite"*. Ruling 4's second condition is that a verdict carries its own
 * reach; a number does that, and the prose around it was the part a reader had
 * to weigh (ruled 2026-08-31).
 *
 * The one admission kept is the selector's own — that it could not narrow the
 * change, so the verdict is broader than the diff — and it is a clause on the
 * headline above rather than a repetition here (`scopeOf`). The blindness
 * count went with the prose: it is a fact about the selector, not about this
 * change, and there is nothing a reader can do with it.
 */
function ranPhrase(report) {
  const gates = (report.extra_gates || []).length;
  // The test total is in it because a run that reported none is the round's
  // worst failure mode, and a reader seeing `(0 tests)` knows at a glance.
  const tests = report.candidate?.totals?.tests;
  const both = (what) => `${what}${tests === undefined ? '' : ` (${tests} tests)`}`
    + ` and ${gates} command gate${gates === 1 ? '' : 's'}`;
  const files = report.selection?.files;
  if (report.full || !report.selection) return both('ran the whole suite');
  return both(`ran ${files} test file${files === 1 ? '' : 's'}`);
}

/** The tree the run happened on, and what that commit is. */
function measuredOn(report) {
  const commit = report.candidate?.commit?.slice(0, 7);
  if (!commit) return '';
  // Not the branch head somebody would see with `git log`: the round measures
  // the head with the base merged in, which is the state after landing.
  return report.full
    ? ` on ${commit} (${report.base?.ref || 'the default branch'} as fetched)`
    : ` on ${commit} (the head with ${report.pr?.base} merged in)`;
}

/** Wall clock, once. The per-phase breakdown is `--json`'s. */
function tookLine(report) {
  const ms = typeof report.duration_ms === 'number' && report.duration_ms
    ? report.duration_ms
    : Object.values(report.timings || {}).reduce((sum, value) => sum + value, 0);
  if (!ms) return null;
  return `mc: ${(ms / 1000).toFixed(0)}s — --json for timings, gate output and the file list`;
}

/**
 * The verdict, short enough to act on without reading twice.
 *
 * Ruled by Martin on 2026-08-31: a session reading this should have nothing to
 * weigh. Green is the subject, what ran as counts, and the time — three lines.
 * Red is what failed and the time, and nothing else: caveats, reach sentences,
 * the pull request's own test counts, per-phase timings, per-gate durations,
 * what the repository prepared with and the passing gates all moved behind
 * `--json`, which every round already accepts.
 *
 * Two lines went that are worth naming, because both were there on purpose.
 * *"It says nothing about whether the change is right"* was the guard against
 * reading a green as an approval — the headline still never says approved, and
 * the sentence was three lines of caveat for a reader who has to weigh it.
 * *"This run was asked to check only"* was true of `mc test`, whose name
 * already says it; a merge round still says plainly that nothing was merged,
 * from `mergeLines`.
 */
export function gateLines(report) {
  const lines = [];

  // `red` and `selected-gate` are verdicts the round reached by measuring, and
  // each has its names below. Everything else stopped short of a verdict,
  // which is a different thing for a reader to be told.
  if (report.stopped_at && !['red', 'selected-gate'].includes(report.stopped_at)) {
    lines.push(`mc: the round stopped at ${report.stopped_at} — ${report.reason}`);
    // A stop after the run is a different thing from one before it, and a
    // reader deciding what to do next needs to know which they are looking at.
    lines.push(report.candidate
      ? 'mc: the tests ran; nothing was merged'
      : 'mc: nothing was measured, and nothing was merged');
    return lines;
  }

  const red = report.candidate?.red || [];
  // The gates ran before the red tests were judged, so a round that stopped at
  // a red test can still hold a broken contract: a red test and a broken
  // contract are two repairs, and a reader who sees only the first comes back
  // for the second.
  const failed = selectedGates(report).filter((gate) => !gate.ok);
  const what = [
    red.length ? `${red.length} test${red.length === 1 ? '' : 's'} red` : null,
    failed.length ? `${failed.length} command gate${failed.length === 1 ? '' : 's'} failed` : null,
  ].filter(Boolean).join(', ');

  if (what) {
    lines.push(`mc: ${subjectOf(report)} — RED — ${what}:`);
    for (const name of red.slice(0, 20)) lines.push(`      ${name}`);
    if (red.length > 20) lines.push(`      … and ${red.length - 20} more`);
    for (const gate of failed) {
      lines.push(`      ${gate.name} — ${gate.ran ? `exit ${gate.exit_code}` : 'could not run'} — ${gate.command}`);
    }
  } else {
    lines.push(`mc: ${subjectOf(report)} — ${verdictHeadline(report)}`);
    lines.push(`mc: ${ranPhrase(report)}${measuredOn(report)}`);
  }

  const took = tookLine(report);
  if (took) lines.push(took);
  return lines;
}

/**
 * The lease verbs take one repository, named the way the view names them.
 *
 * Cheap first: the names in the last snapshot, then a path or a clone beside
 * the home directory — the same rule as `mc work add`. Only a name none of
 * those know costs a full count, because a claim should not wait on an
 * inspection of every checkout on the machine to find out where a name lives.
 */
/**
 * `mc repo guard [repo]` — install the pre-push guard (push-guard.js), or say
 * whether it is in place. Idempotent; a hook mc did not write is left alone.
 */
async function guard(opts, { stdout, stderr }) {
  const repoPath = opts.repo ? await resolveRepoPath(opts.repo) : process.cwd();
  if (!repoPath) {
    stderr.write(`mc: no repository called "${opts.repo}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }
  if (opts.json) {
    stdout.write(`${JSON.stringify({ repo: repoPath, ...pushGuardState(repoPath) }, null, 2)}\n`);
    return 0;
  }
  const outcome = installPushGuard(repoPath);
  if (!outcome.ok) {
    stderr.write(`mc: could not guard ${repoPath}: ${outcome.reason}\n`);
    return 1;
  }
  stdout.write(outcome.installed
    ? `mc: pre-push guard installed at ${outcome.path} — a push to a merged branch is refused and says why (MC_PUSH_ANYWAY=1 overrides)\n`
    : `mc: pre-push guard already in place at ${outcome.path}\n`);
  return 0;
}

/**
 * The hook's entry: one line per ref on stdin, as git gives them. A refusal
 * is exit 1 — git then does not push. Not knowing is never a refusal.
 */
async function pushCheck(opts, { stderr, stdin, env, git, gh }) {
  const input = await readAll(stdin);
  const anyway = Boolean(env.MC_PUSH_ANYWAY);
  let refuse = false;
  for (const line of input.split('\n')) {
    const [localRef, localSha] = line.trim().split(/\s+/u);
    if (!localRef || !localRef.startsWith('refs/heads/')) continue;
    // Deleting a remote branch pushes the null sha; nothing to guard.
    if (/^0+$/u.test(localSha || '')) continue;
    const branch = localRef.slice('refs/heads/'.length);
    const verdict = pushVerdict({ cwd: process.cwd(), branch, ...(git ? { git } : {}), ...(gh ? { gh } : {}) });
    for (const out of pushCheckLines(verdict, { branch, anyway })) stderr.write(`${out}\n`);
    if (verdict.verdict === 'refuse' && !anyway) refuse = true;
  }
  return refuse ? 1 : 0;
}

function readAll(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) { resolve(''); return; }
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { text += chunk; });
    stream.on('end', () => resolve(text));
    stream.on('error', () => resolve(text));
  });
}

export async function resolveRepoPath(name) {
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
    '        mc repo guard [repo] [--json]\n',
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

  if (opts.verb === 'merge') return { ...opts, error: 'mc repo merge is now mc merge' };

  if (opts.verb === 'guard') {
    opts.repo = positional.shift() || null;
    if (positional.length) return { ...opts, error: `mc repo guard takes one repository (${positional[0]})` };
    return opts;
  }
  if (opts.verb === 'push-check') {
    // git's pre-push gives the remote's name and URL as arguments and the
    // refs on stdin; both are taken as they come.
    opts.remote = positional.shift() || 'origin';
    opts.url = positional.shift() || null;
    return opts;
  }

  if (opts.check) return { ...opts, error: '--check belongs to mc merge' };

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

/**
 * `mc merge <repo> <pr> [<pr>...] [--check] [--json] [--docs]` — the
 * arguments of the landing verb, in one place for both of its forms.
 */
export function parseMergeArgs(argv, { docs = false, full = false } = {}) {
  const scanned = scanArgs(argv, { booleans: ['--json', '--check', ...(docs ? ['--docs'] : []), ...(full ? ['--full'] : [])] });
  const opts = { verb: 'merge', repo: null, pr: null, prs: null, check: scanned.flags.check, json: scanned.flags.json, docs: Boolean(scanned.flags.docs), full: Boolean(scanned.flags.full) };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];
  opts.repo = positional.shift() || null;
  if (!opts.repo) return { ...opts, error: 'which repository? mc merge <repo> <pr> [--check] | --docs' };
  // `#346` and `346` are the same pull request, and a person who copied the
  // number off a page brings the hash with it.
  const numbers = positional.splice(0).map((word) => String(word).replace(/^#/u, ''));
  // `--full` is the one form with nothing to name: the repository's own suite
  // on the default branch, which is a question about the code rather than
  // about a change.
  if (!numbers.length && opts.full) return opts;
  if (!numbers.length) return { ...opts, error: 'which pull request? mc merge <repo> <pr> [<pr>...] [--check] | --docs' };
  const bad = numbers.find((number) => !/^\d+$/u.test(number));
  if (bad !== undefined) return { ...opts, error: `"${bad}" is not a pull request number` };
  opts.pr = Number(numbers[0]);
  // Several at once is one candidate and one suite run (A3); the order
  // given is the order they land in.
  opts.prs = numbers.length > 1 ? numbers.map(Number) : null;
  if (opts.prs && new Set(opts.prs).size !== opts.prs.length) return { ...opts, error: 'the same pull request is named twice' };
  // `--check` runs the gate and stops there; without it the same round also
  // lands the change. There is no third mode, and in particular nothing that
  // merges a red gate: overruling one is the human's call and should cost a
  // human action rather than a flag.
  return opts;
}
