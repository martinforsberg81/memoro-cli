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
import { tellHolder } from '../lease-refusal.js';
import { claimLease, readLease, releaseLease } from '../repo-lease.js';
import { currentHolder } from '../work-identity.js';
import { runGate, verdictHeadline } from '../repo-gate.js';
import { runMergeRound } from '../repo-merge.js';
import { countRounds, readRounds, recordRound } from '../repo-round-log.js';
import { livenessForLeases } from '../lease-liveness.js';
import { readCombinedSnapshot } from '../repo-snapshot.js';
import { matchRepo, repoStatus, repoView } from '../repo-status.js';
import { startWatcher, stopWatcher, watcherState } from '../repo-watch.js';
import { scanArgs } from './flags.js';

const VERBS = ['status', 'watch', 'claim', 'release', 'who', 'merge', 'rounds'];
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
  if (opts.verb === 'rounds') return rounds(opts, { stdout });
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
      // The holder is told (lease-refusal.js), so the wait is theirs to end.
      const told = (tell || tellHolder)({ lease: outcome.lease, asker: holder, what: repoPath, errand: opts.errand });
      stderr.write(told.told
        ? `mc: told ${outcome.lease.holder}${told.woke ? ' and woke it' : ` (delivered, not woken: ${told.reason || 'nobody to wake'})`}\n`
        : `mc: could not tell ${outcome.lease.holder}: ${told.reason}\n`);
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
 * `mc repo merge <repo> <pr>` — the gate round, and what becomes of it.
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
    stdout.write('mc: no rounds recorded yet — every mc repo merge and --check from now on leaves a line\n');
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
  const round = { repoPath, pr: opts.pr, prs: opts.prs, holder, onProgress: (message) => stderr.write(`mc: ${message}\n`) };
  const report = opts.check ? await runGate(round) : await runMergeRound(round);
  // Every round leaves a line — merged, stopped, refused — so "has the gate
  // ever caught anything?" is a count, not a reading of survivors (A7).
  recordRound(report, { mode: opts.check ? 'check' : 'merge' });

  if (opts.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  const lines = opts.check ? gateLines(report, { checkOnly: true }) : mergeLines(report);
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
  if (report.off_default) {
    lines.push(`mc: WARNING — ${report.merged_into} is not the default branch (${report.default_branch}): this landed on a branch, not on ${report.default_branch}`);
  }
  if (report.deploy?.attempted) {
    lines.push(report.deploy.ok
      ? `mc: pulled ${report.deploy.command} at ${report.deploy.root}`
      : `mc: could not pull ${report.deploy.root} (${report.deploy.reason}) — the merge stands; pull by hand`);
  }
  lines.push(...freshenedLines(report));
  if (report.log_path) lines.push(`mc: logged to ${report.log_path}`);
  return lines;
}

/** `3 files, 41 tests, 0 red` — or that the pull request changed none. */
function ownTestsPhrase(own) {
  if (!own) return 'not run';
  if (!own.files?.length) return 'none changed';
  const tests = own.totals?.tests ?? '?';
  return `${own.files.length} file${own.files.length === 1 ? '' : 's'}, ${tests} tests, ${own.red?.length || 0} red`;
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
  if (report.ok && report.off_default) {
    lines.push(`mc: WARNING — ${report.merged_into} is not the default branch (${report.default_branch}): this landed on a branch, not on ${report.default_branch}`);
  }
  if (report.deploy?.attempted) {
    lines.push(report.deploy.ok
      ? `mc: pulled ${report.deploy.command} at ${report.deploy.root}`
      : `mc: could not pull ${report.deploy.root} (${report.deploy.reason}) — the merge stands; pull by hand`);
  }
  lines.push(...freshenedLines(report));
  if (report.log_path) lines.push(`mc: logged to ${report.log_path}`);
  return lines;
}

/** What became of the open branches this merge made dirty (A6). */
function freshenedLines(report) {
  const branches = report.freshened?.branches || [];
  const lines = [];
  if (report.freshened?.failed) lines.push(`mc: freshening the open branches failed (${report.freshened.failed}) — every branch is exactly as it was`);
  for (const item of branches) {
    lines.push(`mc: ${item.action === 'pushed' ? 'freshened' : item.action} #${item.number} ${item.branch}${item.detail ? ` — ${item.detail}` : ''}${item.told ? ` (told ${item.told})` : ''}`);
  }
  return lines;
}

/**
 * The verdict in prose — and never the word "approved".
 *
 * The gate reads tests. Whether the change is the right change is a question
 * about the diff and its contract, which nothing here has looked at, so the
 * lines below say what was measured and leave the rest to whoever reviews it.
 */
export function gateLines(report, { checkOnly = false } = {}) {
  const lines = [];
  const pr = report.pr.head ? `#${report.pr.number} (${report.pr.head} → ${report.pr.base})` : `#${report.pr.number}`;

  // `red` and `ratchet` are verdicts the round reached by measuring, and both
  // have their own block below with the names in it. Everything else stopped
  // short of a verdict, which is a different thing for a reader to be told.
  if (report.stopped_at && report.stopped_at !== 'red' && report.stopped_at !== 'ratchet') {
    lines.push(`mc: the round stopped at ${report.stopped_at} — ${report.reason}`);
    // A stop after the suites is a different thing from one before them, and a
    // reader deciding what to do next needs to know which they are looking at.
    const measured = report.baseline && report.candidate;
    lines.push(measured
      ? 'mc: the suites ran; nothing was merged'
      : 'mc: nothing was measured, and nothing was merged');
    return lines;
  }

  // Both of these are commits inside the gate's throwaway worktrees — the base
  // branch, and the PR's head with the base merged into it. Neither is the
  // branch head somebody would see with `git log` on the branch, and saying
  // which is which is cheaper than a reviewer working it out.
  lines.push(`mc: ${pr}`);
  lines.push(`mc: baseline  ${report.baseline.commit?.slice(0, 7)} (${report.pr.base} as fetched)  ${count(report.baseline)}`);
  const heads = report.prs ? report.prs.map((item) => `#${item.number}`).join(' + ') : report.pr.head;
  lines.push(`mc: candidate ${report.candidate.commit?.slice(0, 7)} (${heads} + ${report.pr.base} merged in)  ${count(report.candidate)}`);

  if (report.broke.length) {
    lines.push(`mc: RED — ${report.broke.length} red on the candidate and green on the baseline:`);
    for (const name of report.broke.slice(0, 20)) lines.push(`      ${name}`);
    if (report.broke.length > 20) lines.push(`      … and ${report.broke.length - 20} more`);
    lines.push('mc: not merged — nothing lands a red gate, with or without a flag');
    return lines;
  }

  if (report.ratchet?.risen?.length) {
    const risen = report.ratchet.risen;
    lines.push(`mc: RATCHET RISEN — ${risen.length} red name${risen.length === 1 ? '' : 's'} not in the standing red set.`);
    // Every one of these was red on the baseline too — a name red only on the
    // candidate is `broke` and was stopped above. So this is never a fault the
    // pull request introduced, and the line says so rather than leaving an
    // author to work out why their change was refused for somebody else's.
    lines.push(`mc: ${risen.length === 1 ? 'It was' : 'They were'} red on ${report.pr.base} too, so this change did not cause ${risen.length === 1 ? 'it' : 'them'} —`);
    lines.push(`mc: what moved is the floor in ${report.ratchet.file}, and merging on a moved floor is how it stays moved.`);
    // JSON-quoted, because the remedy is a paste into that array and an author
    // re-typing fifty-character test names is an author who will get one
    // wrong.
    lines.push(`mc: fix ${risen.length === 1 ? 'it' : 'them'}, or add ${risen.length === 1 ? 'it' : 'them'} to its "names" as a commit somebody reviews:`);
    for (const name of risen.slice(0, 20)) lines.push(`      ${JSON.stringify(name)},`);
    if (risen.length > 20) lines.push(`      … and ${risen.length - 20} more (the full list is in --json)`);
    return lines;
  }

  if (report.ratchet && report.ratchet.ok === false) {
    lines.push(`mc: STOPPED — ${report.ratchet.reason}`);
    lines.push('mc: an unreadable ratchet is not an empty one, so nothing was decided from it');
    return lines;
  }

  if (report.fixed.length) lines.push(`mc: ${report.fixed.length} that were red on the baseline are green here`);
  if (report.ratchet?.baseline_risen?.length) {
    const unstable = report.ratchet.baseline_risen;
    lines.push(`mc: BASELINE UNSTABLE — ${unstable.length} red name${unstable.length === 1 ? '' : 's'} on the baseline ${unstable.length === 1 ? 'is' : 'are'} not in the recorded floor:`);
    for (const name of unstable.slice(0, 10)) lines.push(`      ${name}`);
    lines.push('mc: the base itself is flaky or regressed — not this change\'s doing, and worth a look before it hides a real one');
  }
  // Each pull request's own tests, by number — in a batch especially, so the
  // batch never hides which pull request carried which test (A3).
  for (const item of report.prs || (report.pr_tests ? [{ number: report.pr.number, pr_tests: report.pr_tests }] : [])) {
    lines.push(`mc: #${item.number}'s own tests — ${ownTestsPhrase(item.pr_tests)}`);
  }
  // Wall clock per step (A5), so the next decision about cost has a number.
  const timings = Object.entries(report.timings || {});
  if (timings.length) {
    lines.push(`mc: took ${timings.map(([step, ms]) => `${step} ${(ms / 1000).toFixed(0)}s`).join(' · ')}`);
  }
  // What the repository asked for beyond the suite, so a pass is not read as
  // "the suite passed" when more than the suite was measured.
  if (report.declaration?.prepare) lines.push(`mc: prepared with ${report.declaration.prepare}`);
  for (const gate of report.extra_gates || []) {
    lines.push(`mc: extra gate ${gate.name} — ${gate.ok ? 'passed' : 'failed'}`);
  }
  lines.push(...ratchetLines(report));

  // The headline carries the number when there is one, so the word that gets
  // read out and reported onward is the whole verdict rather than the half of
  // it that sounds best.
  lines.push(`mc: ${verdictHeadline(report)}. It says nothing about whether the change is right;`);
  lines.push('mc: that is the review, and it is still somebody\'s to do');
  // The second-order cost of a standing red name, said where the verdict is
  // read rather than in a document beside it: a test that is already failing
  // cannot fail any harder, so a fault introduced inside one of these has
  // nowhere to show up. They are not only debt, they are blind spots.
  if (report.standing_red) {
    lines.push(`mc: those ${report.standing_red} were red before this change and are red after it —`);
    lines.push('mc: a new fault inside any of them could not have shown up in this round');
  }
  // Said only when it is the whole answer. In a merge round these same lines
  // are followed by what became of the verdict, and a run that says it did not
  // merge and then says it merged is worse than one that says neither.
  if (checkOnly) lines.push('mc: this run was asked to check only, so nothing was merged');
  return lines;
}

/**
 * What the ratchet has to say on a round that passed it.
 *
 * Two things, and neither of them changes the verdict. That the floor is
 * unrecorded, when there is a floor to record — otherwise the first thing
 * anybody learns about the mechanism is a gate failing. And which names have
 * come good, spelled out, because lowering the floor is a commit somebody
 * makes by hand and this is the difference between that commit being a paste
 * and being an investigation. Nothing here writes the file: see the header of
 * `red-ratchet.js` for why a round that tightened it automatically would lay a
 * trap for the next author.
 */
function ratchetLines(report) {
  const ratchet = report.ratchet;
  const lines = [];
  if (!ratchet) return lines;

  if (!ratchet.present) {
    if (!report.standing_red) return lines;
    lines.push(`mc: no standing red set is recorded in ${ratchet.file}, so nothing here stops`);
    lines.push(`mc: the ${ordinal(report.standing_red + 1)} joining them. Record today's ${report.standing_red} there and the number can only go down`);
    return lines;
  }

  lines.push(`mc: ratchet — ${ratchet.accepted} standing red name${ratchet.accepted === 1 ? '' : 's'} accepted in ${ratchet.file}, none above it`);
  if (ratchet.fallen.length) {
    lines.push(`mc: ${ratchet.fallen.length} of them ${ratchet.fallen.length === 1 ? 'is' : 'are'} green here — remove ${ratchet.fallen.length === 1 ? 'it' : 'them'} from ${ratchet.file}`);
    lines.push('mc: in a commit to lock the gain. mc does not write it: a name that only passed');
    lines.push('mc: because the machine was quiet would come back, and read as a rise next round');
    for (const name of ratchet.fallen.slice(0, 20)) lines.push(`      ${name}`);
    if (ratchet.fallen.length > 20) lines.push(`      … and ${ratchet.fallen.length - 20} more`);
  }
  return lines;
}

/**
 * `56th`, not `56st`.
 *
 * Small, and worth its four lines: the sentence it appears in is the one that
 * asks somebody to record a floor, and a verdict that cannot count is not one
 * anybody takes an instruction from.
 */
function ordinal(n) {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
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
    '        mc repo merge <repo> <pr> [<pr>...] [--check] [--json]\n',
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
    if (!opts.repo) return { ...opts, error: 'which repository? mc repo merge <repo> <pr> [--check]' };
    // `#346` and `346` are the same pull request, and a person who copied the
    // number off a page brings the hash with it.
    const numbers = positional.splice(0).map((word) => String(word).replace(/^#/u, ''));
    if (!numbers.length) return { ...opts, error: 'which pull request? mc repo merge <repo> <pr> [<pr>...] [--check]' };
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
