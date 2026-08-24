/**
 * The gate round that also lands the change.
 *
 * `repo-gate.js` answers one question — did anything new go red — and cannot
 * merge. That is deliberate, and it stays that way: a module that could do both
 * is one `if` away from landing a change on a verdict it had not finished
 * forming. So merging lives here, on top of it, and reaches the merge only by
 * getting a passing report back from something that has no opinion about merging.
 *
 * The round, in order, stopping at the first thing that is not right:
 *
 *  1. take the lease — and keep it across the whole round rather than around
 *     each half, so no other round can move main between the measurement and
 *     the merge;
 *  2. run the gate inside that lease;
 *  3. check the ground has not moved — the base is still the commit the
 *     baseline was measured at, and the lease is still ours;
 *  4. squash-merge;
 *  5. pull the source-linked installation, because on this machine that is
 *     what deploying means;
 *  6. write one line to the merge log;
 *  7. give the lease back, whatever happened.
 *
 * There is no way to merge a red gate. Not a flag, not an option, not an
 * environment variable. Overriding a red gate is the human's call and it should
 * cost a human action, visible as one — a verb that offered the override would
 * make it look like part of the routine.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { claimLease, readLease, releaseLease } from './repo-lease.js';
import { freshenBranchForLanding, freshenOpenBranches } from './repo-freshen.js';
import { lockfileHashAt, saveBaseline } from './repo-baseline-cache.js';
import { currentHolder } from './work-identity.js';
import { mcHome } from './paths.js';
import { runGate, verdictPhrase } from './repo-gate.js';
import { sourceLinkedInstallations } from './repo-status.js';
import { declarationFor } from './repo-gate-table.js';

export const MERGE_SCHEMA = 'mc-repo-merge';
export const MERGE_VERSION = 1;

/**
 * Where a repository's merge log lives.
 *
 * A parameter rather than a constant, because the log a merge belongs in is a
 * property of the project the work is being done for, not of the checkout. The
 * default is the one this repository's merges have always been written to; a
 * repository with no answer gets no line and says so, rather than inventing a
 * file somewhere.
 */
export function defaultMergeLog(repoPath, { root = mcHome(), env = process.env } = {}) {
  const declared = declarationFor(repoPath, { root, env });
  return declared.ok ? declared.declaration.merge_log : null;
}

/**
 * Run the gate and, only if it passes, land the change.
 *
 * Everything that touches the world is injectable for the same reason as in the
 * gate: the one thing a test suite cannot assert is a real merge against a real
 * remote. The defaults are the real thing.
 */
export async function runMergeRound({
  repoPath,
  pr,
  // Several pull requests in one round (A3): one candidate, the suite once,
  // then each landed in order if it is green. A batch that stops — a
  // conflict, a red, one pull request's own tests — falls back to one round
  // per pull request, inside the same lease, and says that it is doing so.
  prs = null,
  holder = currentHolder(),
  root = mcHome(),
  env = process.env,
  git = null,
  gh = null,
  gate = runGate,
  installs = sourceLinkedInstallations,
  suite = undefined,
  mergeLog = undefined,
  freshen = freshenOpenBranches,
  refresh = null,
  onProgress = () => {},
  clock = () => Date.now(),
  // A batch's fallback rounds run inside the batch's lease; they neither
  // take nor give back what they did not claim (the gate's own rule).
  holdLease = true,
} = {}) {
  const startedAt = clock();
  const say = (message) => { try { onProgress(message); } catch { /* progress is a courtesy */ } };
  const numbers = (Array.isArray(prs) && prs.length ? prs : [pr]).map(Number);
  const batch = numbers.length > 1;
  const label = numbers.map((n) => `#${n}`).join(' ');

  // Bound to this round's `env`, not the process's — see the same note in
  // repo-gate.js. Taking an environment and resolving binaries against another
  // one is how a stub on the PATH still reached the real `gh`.
  const run = (tool) => (args, options = {}) => spawnSync(tool, args, {
    cwd: options.cwd, env, encoding: 'utf8',
  });
  const askGit = git || run('git');
  const askGh = gh || run('gh');

  const report = {
    schema: MERGE_SCHEMA,
    version: MERGE_VERSION,
    repo: repoPath,
    pr: { number: numbers[0] },
    // The batch (A3): what landed, in order, and — if the batch gate stopped —
    // the one-per-PR rounds that ran instead. Null for a single round.
    batch: batch ? { prs: numbers, gate_ok: null, merges: [], fallback: false, rounds: [] } : null,
    holder: holder.name,
    ok: false,
    merged: false,
    merge_commit: null,
    // The error a merge call returned when the merge had in fact happened, or
    // when whether it happened could not be read back. Null on a clean call.
    merge_error: null,
    // What the squash landed *in*, and whether that is the branch people mean
    // by "merged". A round on #363 said "merged as 7dcbf96" and was right —
    // into `pm-heartbeat`, its stacked base — and everyone read "on main".
    merged_into: null,
    default_branch: null,
    off_default: false,
    stopped_at: null,
    reason: null,
    gate: null,
    deploy: null,
    tree_identical: null,
    freshened: null,
    log_line: null,
    log_path: null,
    started_at: new Date(startedAt).toISOString(),
    finished_at: null,
    duration_ms: null,
  };

  const finish = (stoppedAt, reason) => {
    report.stopped_at = stoppedAt;
    report.reason = reason;
    report.ok = stoppedAt === null;
    const ended = clock();
    report.finished_at = new Date(ended).toISOString();
    report.duration_ms = ended - startedAt;
    return report;
  };

  // One lease across the whole round. The gate would take its own and give it
  // straight back, which would open exactly the window this round must not have.
  // For the length of this process (lease-owner.js): a merge round cut short
  // leaves a lease its pid answers for.
  if (holdLease) {
    const lease = claimLease({ repoPath, errand: `merge round for ${label}`, holder, ownerPid: process.pid, root });
    if (!lease.ok) {
      const held = lease.lease;
      return finish('lease', `${repoPath} is held by ${held.holder}${held.errand ? ` for “${held.errand}”` : ''}`);
    }
    say(`lease taken by ${holder.name} for the whole round`);
  }

  try {
    const verdict = await gate({
      repoPath, pr: numbers[0], prs: batch ? numbers : null, holder, root, env, git: askGit, gh: askGh, suite, onProgress, clock, holdLease: false,
    });
    report.gate = verdict;
    report.pr = { ...report.pr, ...verdict.pr };
    if (batch) report.batch.gate_ok = Boolean(verdict.ok);
    if (!verdict.ok && batch && FALLBACK_STOPS.includes(verdict.stopped_at)) {
      // The batch could not be measured as one, or measured red. Which pull
      // request is to blame is not the batch's to say, so each is given its
      // own round — the gate it would have had anyway — and the report keeps
      // the batch verdict beside them. The lease stays with this round.
      say(`batch ${label} stopped at ${verdict.stopped_at} (${verdict.reason}) — falling back to one round per pull request`);
      report.batch.fallback = true;
      for (const number of numbers) {
        // Best effort: an earlier fallback round that landed makes the next
        // branch unmergeable to the forge until it carries the new main.
        const head = (verdict.prs || []).find((item) => item.number === number)?.head;
        if (head && report.batch.merges.some((item) => item.merged)) {
          const ready = (refresh || freshenBranchForLanding)({ repoPath, branch: head, base: verdict.pr.base || 'main', root, env, git: askGit, say });
          if (!ready.ok) say(`#${number} could not be freshened first (${ready.reason}) — its own round will say what that means`);
        }
        say(`— round for #${number}`);
        const round = await runMergeRound({
          repoPath, pr: number, holder, root, env, git: askGit, gh: askGh, gate, installs, suite, mergeLog, onProgress, clock, holdLease: false,
        });
        report.batch.rounds.push(round);
        report.batch.merges.push({ number, merged: round.merged, merge_commit: round.merge_commit, error: round.ok ? null : round.reason });
      }
      report.merged = report.batch.merges.every((item) => item.merged);
      const failed = report.batch.merges.filter((item) => !item.merged);
      if (failed.length) {
        return finish('batch', `${failed.length} of ${numbers.length} did not land in its own round: ${failed.map((item) => `#${item.number} (${item.error})`).join('; ')}`);
      }
      return finish(null, null);
    }
    if (!verdict.ok) {
      // The gate stops the round and there is nothing here that can overrule
      // it. A red gate is reported and the change stays where it is.
      return finish(verdict.stopped_at === 'red' ? 'red' : verdict.stopped_at, verdict.reason);
    }

    // The ground under the verdict, checked before acting on it.
    //
    // The lease serialises gate rounds against each other; it does not stop a
    // person merging by hand, and that happened during this feature's own
    // development — a round measured against one main while another landed in
    // it. A passing verdict is a statement about the tree it measured, so if the
    // base has moved since, the verdict is about a tree that no longer exists.
    const base = `origin/${verdict.pr.base}`;
    const fetched = askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
    if (fetched.status !== 0) return finish('drift', 'could not re-check the base before merging');
    const nowAt = trim(askGit(['rev-parse', base], { cwd: repoPath }).stdout);
    if (!nowAt) return finish('drift', `could not read ${base} before merging`);
    if (nowAt !== verdict.baseline.commit) {
      return finish('drift', `${base} moved from ${short(verdict.baseline.commit)} to ${short(nowAt)} while the gate ran — the verdict is about a tree that has changed, so it is measured again rather than merged on`);
    }

    // And the lease, re-read rather than assumed. A `--force` release mid-round
    // hands the repository to somebody else, and a merge landed after that is a
    // merge nobody was holding the round for.
    const still = readLease(repoPath, { root });
    if (!still.held || still.holder !== holder.name) {
      return finish('lease', `the lease was taken from ${holder.name} during the round — nothing was merged`);
    }

    // The same statement the verdict makes, not a friendlier one. A merge
    // round that narrated "gate green" over standing red would put the word
    // back exactly where it was taken out of.
    say(`${verdictPhrase(verdict)} and ${base} unmoved — merging ${label}`);
    // In order, each on the main the one before it made. Between two merges
    // the base is read again: it must be exactly the commit this round just
    // landed, or somebody else moved it and the rest of the batch is a
    // verdict about a tree that has changed.
    let expected = verdict.baseline.commit;
    for (const [index, number] of numbers.entries()) {
      if (index > 0) {
        askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
        const at = trim(askGit(['rev-parse', base], { cwd: repoPath }).stdout);
        if (at !== expected) {
          return finish('drift', `${base} moved to ${short(at)} between merges, and not by this round — #${number}${index + 1 < numbers.length ? ` and ${numbers.length - index - 1} more` : ''} not merged; ${index} of ${numbers.length} landed, and ${base} now stands at a state the batch never measured by itself`);
        }
        // The batch verifies together and lands sequentially, and every
        // squash makes the next branch unmergeable to the forge (measured
        // on the first live batch: five green on one candidate, one
        // landed, four refused). The just-made main goes into the next
        // branch before its turn — a conflict here stops the batch, and
        // what has landed stays landed and said.
        const head = (verdict.prs || []).find((item) => item.number === number)?.head;
        if (head) {
          const ready = (refresh || freshenBranchForLanding)({ repoPath, branch: head, base: verdict.pr.base, root, env, git: askGit, say });
          if (!ready.ok) {
            if (batch) report.batch.merges.push({ number, merged: false, merge_commit: null, error: `could not be freshened for landing: ${ready.reason}` });
            return finish('merge', `#${number} could not be freshened for landing (${ready.reason}) — ${index} of ${numbers.length} landed before it, and ${verdict.pr.base} now stands at a state the batch never measured by itself`);
          }
        }
      }
      const merged = askGh(['pr', 'merge', String(number), '--squash'], { cwd: repoPath });
      if (merged.status !== 0) {
        // A failed call is not a failed merge. On #10844 GitHub took the call,
        // performed it, and timed out on the reply; the round said "nothing was
        // merged" and the change was on main. So the forge is asked what it
        // did before anything is claimed: merged → carry on as merged; open →
        // the merge failed; cannot ask → say exactly that, and nothing more.
        const actual = mergeState({ gh: askGh, repoPath, pr: number });
        const error = trim(merged.stderr) || `gh could not merge #${number}`;
        if (actual.state === 'merged') {
          report.merge_error = error;
          say(`gh pr merge failed (${error}) — but GitHub says #${number} is merged, so it is`);
        } else if (actual.state === 'open') {
          if (batch) report.batch.merges.push({ number, merged: false, merge_commit: null, error });
          return finish('merge', batch ? `#${number}: ${error} — ${index} of ${numbers.length} landed before it` : error);
        } else {
          report.merge_error = error;
          return finish('merge-unknown', `gh pr merge failed (${error}) and whether it merged could not be read back (${actual.reason}) — check with gh pr view ${number}`);
        }
      }
      // Read back rather than assumed: the point of recording a merge commit is
      // that somebody can go and look at it. The forge is asked which commit
      // *this* merge made, and the base is read beside it: in a batch the
      // two must agree before the next merge, or somebody else landed
      // between them and the rest of the batch is measured against a tree
      // that has changed. With a forge that will not say, the base is taken.
      askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
      const at = trim(askGit(['rev-parse', base], { cwd: repoPath }).stdout) || null;
      const made = mergeCommitOf({ gh: askGh, repoPath, pr: number });
      const landed = made || at;
      expected = landed;
      if (batch) {
        report.batch.merges.push({ number, merged: true, merge_commit: landed, error: null });
        say(`merged #${number} into ${verdict.pr.base} as ${short(landed)}`);
      }
      report.merge_commit = landed;

      // Is main, right now, byte-for-byte the tree the measured build said
      // it should be after this landing? (PM's ruling on the tracks'
      // disagreement, 2026-08-23: identity is a measurement; "still green"
      // without it is an assumption.) For a batch the expectation is the
      // prefix tree T_i recorded while the candidate was built; for a
      // single round it is the candidate's own tree. Identical → the green
      // transfers, said so. Different → the world the remaining proofs
      // were made in no longer exists: the rest of the batch is re-measured
      // in rounds of its own, and nothing is carried forward.
      const expectTree = batch ? (verdict.candidate_trees || [])[index] || null : verdict.candidate.tree || null;
      if (expectTree) {
        const landedTree = trim(askGit(['rev-parse', `${base}^{tree}`], { cwd: repoPath }).stdout) || null;
        if (landedTree === expectTree) {
          if (report.tree_identical !== false) report.tree_identical = true;
          say(batch
            ? `#${number} landed byte-identical to the measured build (tree ${short(landedTree)})`
            : `${verdict.pr.base} is byte-identical to the measured candidate (tree ${short(landedTree)}) — the green transfers by identity`);
        } else {
          report.tree_identical = false;
          say(`WARNING: after #${number}, ${base}'s tree (${short(landedTree)}) is NOT the measured build's (${short(expectTree)}) — the sequential squash resolved something differently, and the green measured on the candidate does not transfer`);
          if (batch && index + 1 < numbers.length) {
            const rest = numbers.slice(index + 1);
            say(`re-measuring the remaining ${rest.length} in rounds of their own — the world they were proved in no longer exists`);
            report.batch.fallback = true;
            for (const later of rest) {
              const head = (verdict.prs || []).find((item) => item.number === later)?.head;
              if (head) {
                const ready = (refresh || freshenBranchForLanding)({ repoPath, branch: head, base: verdict.pr.base, root, env, git: askGit, say });
                if (!ready.ok) say(`#${later} could not be freshened first (${ready.reason}) — its own round will say what that means`);
              }
              say(`— round for #${later}`);
              const round = await runMergeRound({
                repoPath, pr: later, holder, root, env, git: askGit, gh: askGh, gate, installs, suite, mergeLog, onProgress, clock, holdLease: false,
              });
              report.batch.rounds.push(round);
              report.batch.merges.push({ number: later, merged: round.merged, merge_commit: round.merge_commit, error: round.ok ? null : round.reason });
            }
            const failed = report.batch.merges.filter((item) => !item.merged);
            if (failed.length) {
              return finish('batch', `${failed.length} of ${numbers.length} did not land: ${failed.map((item) => `#${item.number} (${item.error})`).join('; ')}`);
            }
            break;
          }
        }
      }
    }
    report.merged = true;
    // Named, not implied. The sha is read from the PR's base, so it is the
    // base that says what "merged" meant — and when that is not the branch
    // the remote points HEAD at, the line says so in its own words rather
    // than leaving a true sentence to be read as a different true sentence.
    report.merged_into = verdict.pr.base;
    report.default_branch = defaultBranch(askGit, repoPath);
    report.off_default = Boolean(report.default_branch) && report.merged_into !== report.default_branch;
    if (!batch) say(`merged #${verdict.pr.number} into ${report.merged_into} as ${short(report.merge_commit)}`);
    if (report.off_default) {
      say(`WARNING: ${report.merged_into} is not the default branch (${report.default_branch}) — this landed on a branch, not on ${report.default_branch}`);
    }

    // Main is now the tree the candidate was measured on: save that result
    // as the next round's baseline (A1). Keyed on the merge commit, the
    // lockfile at it, and the suite command; the next round reuses it only
    // when all three match. Saved only after a fully landed round — a
    // partial batch leaves the old entry, which then simply never matches.
    if (report.tree_identical === true) attempt(() => saveBaseline({
      repoPath,
      commit: report.merge_commit,
      lockfileHash: lockfileHashAt({ git: askGit, repoPath, commit: report.merge_commit }),
      command: verdict.command,
      red: verdict.candidate.red,
      totals: verdict.candidate.totals,
      root,
    }), (why) => say(`could not save the candidate result as the next baseline (${why}) — the next round runs it as before`));

    // The branches this merge just made dirty, brought up to date while the
    // lease is still held (A6): the same work every open branch's owner
    // would do twenty minutes later, done once, by the round that moved
    // main. A failure here never un-merges anything and never fails the
    // round — the report carries what happened to each branch.
    report.freshened = attemptFreshen({ freshen, repoPath, base: verdict.pr.base, holder, root, env, git: askGit, gh: askGh, say });


    report.deploy = deployPull({ git: askGit, repoPath, env, say, installs });
    const written = writeMergeLine({ report, verdict, path: mergeLog ?? defaultMergeLog(repoPath, { root, env }), clock });
    report.log_path = written.path;
    report.log_line = written.line;
    if (written.path) say(`logged to ${written.path}`);

    return finish(null, null);
  } finally {
    if (holdLease) {
      releaseLease({ repoPath, holder, root });
      say('lease released');
    }
  }
}

/** The freshen step, held to "never fails the round". */
function attemptFreshen({ freshen, repoPath, base, holder, root, env, git, gh, say }) {
  if (!freshen) return null;
  try {
    return freshen({ repoPath, base, holder, root, env, git, gh, say });
  } catch (error) {
    say(`freshen failed (${error?.message || String(error)}) — every open branch is exactly as it was`);
    return { branches: [], failed: error?.message || String(error) };
  }
}

/**
 * The batch stops that mean "measure them one by one": the candidate could
 * not be built (a conflict among them), or it measured red, or one pull
 * request's own tests failed. A lease, a missing declaration or a suite that
 * never summarised would stop the single rounds exactly the same way, and
 * running them would be four more of the same stop.
 */
const FALLBACK_STOPS = Object.freeze(['merge', 'red', 'pr-tests', 'ratchet', 'extra-gate']);

/**
 * Bring the installation that runs from a checkout up to what just landed.
 *
 * On this machine `mc` is a symlink into a working tree, so `git pull` there
 * *is* the deploy — and the rule that this is routine maintenance rather than a
 * decision is the reason it belongs inside the round instead of in somebody's
 * memory. Only an installation running from *this* repository is touched.
 *
 * A pull that fails does not undo the merge and must not fail the round: the
 * change has landed, and what is left is a machine one commit behind, which the
 * report says plainly so somebody can pull it by hand.
 */
function attempt(fn, complain) {
  try { return fn(); } catch (error) { complain(error?.message || String(error)); return null; }
}

function deployPull({ git, repoPath, env, say, installs }) {
  const install = installs(env).find((item) => item.root === repoPath);
  if (!install) return { attempted: false, ok: null, reason: 'nothing on this machine runs from this checkout' };

  const pulled = git(['pull', '--ff-only'], { cwd: install.root });
  const ok = pulled.status === 0;
  say(ok ? `pulled ${install.command} at ${install.root}` : `could not pull ${install.root}`);
  return {
    attempted: true,
    ok,
    root: install.root,
    command: install.command,
    at: ok ? trim(git(['rev-parse', 'HEAD'], { cwd: install.root }).stdout) : null,
    reason: ok ? null : trim(pulled.stderr) || 'git pull failed',
  };
}

/**
 * One row in the merge log, appended.
 *
 * The log is a table a person reads, so the line carries what a person checking
 * up on a merge would want: which pull request, what the gate measured on both
 * sides, what it became, and under whose authority. The red sets go in as
 * counts with the difference spelled out — the full lists live in the round's
 * own `--json`, and a table row that ran to fifty names would stop being one.
 *
 * The class is `D (delegerad)` and nothing else, because a verb has no
 * authority of its own — it carries out its holder's. An earlier version wrote
 * a class of its own invention, which read as though the machine were answering
 * for the merge; the log is the document that shows the chain of who allowed
 * what, and a class that is not in the matrix breaks it. The machine's part
 * belongs in the note, where it says who ran it and as whom. Deciding that a
 * mechanical round deserves a marker of its own would be a change to the
 * decision matrix, which is not a thing to slip into a log line.
 *
 * Appending is best effort. A merge that happened and a line that did not get
 * written is a bookkeeping problem; refusing to report the merge because of it
 * would be a worse one.
 */
function writeMergeLine({ report, verdict, path, clock }) {
  if (!path) return { path: null, line: null };
  const day = new Date(clock()).toISOString().slice(0, 10);
  const checks = [
    `full suite both sides, fresh baseline at ${short(verdict.baseline.commit)}`,
    `${verdict.baseline.red.length} standing red before · ${verdict.candidate.red.length} after · 0 new`,
    `base unmoved at merge`,
  ].join(' · ');
  // One line per pull request, batch or not: the log is read per PR, and a
  // batch line says it was measured as one candidate with the others.
  const landed = report.batch
    ? report.batch.merges.filter((item) => item.merged).map((item) => ({
      number: item.number,
      title: (verdict.prs || []).find((pr) => pr.number === item.number)?.title || null,
      commit: item.merge_commit,
      note: `Batch of ${report.batch.prs.length} (${report.batch.prs.map((n) => `#${n}`).join(' ')}) measured as one candidate, own tests per PR.`,
    }))
    : [{ number: report.pr.number, title: verdict.pr.title, commit: report.merge_commit, note: '' }];
  const line = landed.map((item) => `| ${day} | ${basenameOf(report.repo)} #${item.number}${item.title ? ` ${item.title}` : ''} `
    + `| ${checks} | D (delegerad) | Squash-merge into \`${report.merged_into}\` → \`${short(item.commit)}\`${report.off_default ? ` (NOT ${report.default_branch})` : ''} `
    + `| Run by \`mc repo merge\` as ${report.holder}. ${item.note ? `${item.note} ` : ''}${deployNote(report.deploy)} |`).join('\n');

  try {
    if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  } catch {
    return { path: null, line };
  }
  return { path, line };
}

/**
 * The branch the remote points HEAD at — `main` here — or null when git
 * cannot say. Null is "unknown", never "main": a guess would turn the warning
 * into the very assumption it exists to catch.
 */
function defaultBranch(git, repoPath) {
  const head = git(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { cwd: repoPath });
  const name = head?.status === 0 ? trim(head.stdout).replace(/^origin\//u, '') : '';
  return name || null;
}

/**
 * What the forge says happened to the pull request — `merged`, `open`, or
 * `unknown` with the reason the question could not be answered. Asked only
 * after a merge call failed, which is the one moment "nothing was merged"
 * would be a guess.
 */
/** The squash commit a merged pull request became, or null if the forge will not say. */
function mergeCommitOf({ gh, repoPath, pr }) {
  const asked = gh(['pr', 'view', String(pr), '--json', 'mergeCommit'], { cwd: repoPath });
  if (asked?.status !== 0) return null;
  try { return JSON.parse(asked.stdout)?.mergeCommit?.oid || null; } catch { return null; }
}

function mergeState({ gh, repoPath, pr }) {
  const asked = gh(['pr', 'view', String(pr), '--json', 'state,mergedAt'], { cwd: repoPath });
  if (asked?.status !== 0) return { state: 'unknown', reason: trim(asked?.stderr) || 'gh could not read the pull request' };
  let raw = null;
  try { raw = JSON.parse(asked.stdout); } catch { return { state: 'unknown', reason: 'the pull request came back as something other than JSON' }; }
  if (raw?.state === 'MERGED') return { state: 'merged', merged_at: raw.mergedAt || null };
  if (raw?.state === 'OPEN') return { state: 'open' };
  return { state: 'unknown', reason: raw?.state ? `the pull request is ${String(raw.state).toLowerCase()}` : 'the pull request did not say its state' };
}

function deployNote(deploy) {
  if (!deploy?.attempted) return 'No source-linked installation here.';
  return deploy.ok ? 'Live via deploy pull.' : `Deploy pull failed (${deploy.reason}) — pull by hand.`;
}

function basenameOf(path) {
  return String(path).replace(/\/+$/u, '').split('/').pop();
}

function short(sha) {
  return String(sha || '').slice(0, 7) || 'unknown';
}

function trim(value) {
  return String(value || '').trim().split('\n').slice(0, 3).join(' ');
}

