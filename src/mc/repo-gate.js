/**
 * The gate round, as a machine.
 *
 * The rule it enforces is not new: a pull request may not make the suite red
 * anywhere main was green, and "green" has to be measured against a main that
 * is current rather than one remembered from this morning. What is new is that
 * it stops being a set of instructions somebody follows. Instructions degrade
 * with distance and tiredness — nine parallel collisions in one day, from
 * areas that merged before they read the directive — and a gate that runs as
 * code does not degrade. It is also the only way to keep the rule without
 * spending the PM's judgement on mechanical work: this is cheap enough for the
 * cheapest surface that can run it.
 *
 * The round, in order, stopping at the first red step:
 *
 *  1. take the repository's lease, so two rounds cannot measure against each
 *     other's moving main;
 *  2. read what the pull request actually is, from `gh`;
 *  3. build two throwaway worktrees — the baseline at the base branch, the
 *     candidate at the PR's head with the current base merged into it, so what
 *     is measured is the state after merging rather than the state the author
 *     last saw;
 *  4. run the repository's own full suite on both, in the same round;
 *  5. compare the two red sets by name at every level;
 *  6. check what is left against the standing red set the repository recorded;
 *  7. give the lease back, whatever happened.
 *
 * There is no merge in here, and not behind a flag either. This module answers
 * one question — did anything new go red — and a module that could also merge
 * would be one `if` away from a round that merged on a verdict it had not
 * finished forming. Merging lives in `repo-merge.js`, which runs this and acts
 * on the report; keeping it out of here is load-bearing rather than tidy, and
 * a test asserts against this file's source that it stays out.
 *
 * It says what it measured, never "the pull request is good". Reading the diff
 * against its contract is judgement, and judgement is not mechanical; a
 * passing suite carrying an unescalated design decision is exactly the mistake
 * that conflation would license.
 *
 * And it does not say "green" unless the base branch is green. The rule above
 * is differential, so on a repository with fifty-five standing red names a
 * pass means "no new red", which is a smaller claim — and for a week it was
 * reported onward as the larger one. The verdict now carries the number
 * instead. `red-ratchet.js` is the other half of the same correction: the
 * comparison cannot see a floor that moved between rounds, so the floor is
 * written down where a rise has to be reviewed rather than inherited.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { claimLease, releaseLease } from './repo-lease.js';
import { claimSuiteLease, releaseSuiteLease } from './suite-lease.js';
import { tellHolder } from './lease-refusal.js';
import { suiteRuns } from './work-status.js';
import { compareRed, redNames, tapTotals } from './tap-red.js';
import { RATCHET_FILE, compareRatchet, readRatchet } from './red-ratchet.js';
import { currentHolder } from './work-identity.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';
import { carriedGate, loadBaseline, loadMeasuredGate, lockfileHashAt, saveMeasuredGate } from './repo-baseline-cache.js';
import { dependencyTree } from './dependency-tree.js';
import { declarationFor } from './repo-gate-table.js';

export const GATE_SCHEMA = 'mc-repo-gate';
export const GATE_VERSION = 1;

/** Where the throwaway worktrees live: mc's own home, never inside the repository. */
export function gateRoot(root = mcHome()) {
  return join(root, 'gate');
}

/**
 * Run the gate round and report what it found.
 *
 * Everything the round touches outside this process is injectable — `git`,
 * `gh`, and the suite runner — because the one thing that cannot be asserted
 * in a test suite is a real forty-minute suite run against a real remote. The
 * defaults are the real thing.
 *
 * `holder` is read once, here, from wherever the caller is standing. The round
 * spends its life in temporary worktrees outside the work root, and a lease
 * taken from in there would be held by `user@host` instead of by the area
 * doing the work — a lease nobody can find the owner of. Nothing below ever
 * changes this process's working directory; every command is given its `cwd`.
 */
export async function runGate({
  repoPath,
  pr,
  // Several pull requests measured as one candidate (A3, 2026-08-23): with
  // eleven in the queue and every round 5–13 minutes holding the suite
  // right, the round — not the computation — was the bottleneck. One tree
  // with all of them merged in, the suite once on each side, and each pull
  // request's own tests still run by themselves so the batch never hides
  // which one carried which test. `pr` alone is the single-PR round it
  // always was.
  prs = null,
  tests = null,
  holder = currentHolder(),
  root = mcHome(),
  env = process.env,
  git = null,
  gh = null,
  suite = null,
  onProgress = () => {},
  clock = () => Date.now(),
  // How a refused claim reaches the holder (lease-refusal.js); stubbed in tests.
  tell = tellHolder,
  suiteRunsNow = null,
  // Whether the round owns the lease or is running inside somebody else's.
  //
  // The merge step has to hold one lease across the gate *and* the merge — a
  // round that let go in between would be measuring against a main another
  // round was free to move. So it claims first and passes `holdLease: false`,
  // and this module neither takes nor gives back what it did not claim.
  holdLease = true,
} = {}) {
  const startedAt = clock();
  const say = (message) => { try { onProgress(message); } catch { /* progress is a courtesy */ } };

  // Bound to the `env` this round was given rather than to the process's own.
  // A round that took an environment and then resolved its binaries against a
  // different one is answering a question nobody asked, and it is why a test
  // that put a stub `gh` on the PATH still reached the real one.
  const run = (tool) => (args, options = {}) => spawnSync(tool, args, {
    cwd: options.cwd, env, encoding: 'utf8',
  });
  const askGit = git || run('git');
  const askGh = gh || run('gh');
  const runSuite = suite || ((options) => realSuite({ ...options, env }));
  const runTests = tests || ((options) => realTests({ ...options, env }));

  const numbers = (Array.isArray(prs) && prs.length ? prs : [pr]).map(Number);
  const batch = numbers.length > 1;
  const label = batch ? numbers.map((n) => `#${n}`).join(' ') : `#${numbers[0]}`;

  const report = {
    schema: GATE_SCHEMA,
    version: GATE_VERSION,
    repo: repoPath,
    pr: { number: numbers[0], head: null, base: null, head_sha: null, title: null },
    // The batch, when there is one: every pull request's facts and its own
    // tests, in the order they were merged into the candidate. Null for a
    // single round, whose facts are `pr` and whose tests are `pr_tests`.
    prs: batch ? numbers.map((number) => ({ number, head: null, base: null, head_sha: null, title: null, pr_tests: null })) : null,
    holder: holder.name,
    ok: false,
    merged: false,
    stopped_at: null,
    reason: null,
    command: null,
    declaration: null,
    extra_gates: [],
    // The pull request's own tests: every `*.test.js` it adds or changes, run
    // on the candidate after the suite (D-0157). `files: []` when it touches
    // none, which is said rather than left blank.
    pr_tests: null,
    baseline: null,
    candidate: null,
    broke: [],
    fixed: [],
    // The prefix trees of a batch candidate as it was built, `T_1..T_N`:
    // what main must be, byte for byte, after each landing. Null for a
    // single round; `T_N` equals `candidate.tree`.
    candidate_trees: null,
    // The verdict as a word a reader can branch on, and the number that word
    // used to hide. `green` and `no-new-red` are both passes and are not the
    // same statement: one says the suite is clean, the other says it is no
    // dirtier than it was. See `verdictHeadline` below.
    verdict: null,
    standing_red: null,
    ratchet: null,
    // Wall clock per step (A5). Four decisions about cost were taken one day
    // without a single number from the tool itself; the next one is measured.
    timings: {},
    started_at: new Date(startedAt).toISOString(),
    finished_at: null,
    duration_ms: null,
  };
  const timed = async (step, fn) => {
    const from = clock();
    try { return await fn(); } finally {
      report.timings[step] = (report.timings[step] || 0) + (clock() - from);
      say(`${step} took ${seconds(report.timings[step])}`);
    }
  };

  const finish = (stoppedAt, reason) => {
    report.stopped_at = stoppedAt;
    report.reason = reason;
    report.ok = stoppedAt === null;
    report.verdict = verdictFor(report);
    const ended = clock();
    report.finished_at = new Date(ended).toISOString();
    report.duration_ms = ended - startedAt;
    return report;
  };

  if (holdLease) {
    // Taken for the length of this process, and it says so (lease-owner.js):
    // a round cut short by a kill leaves a lease its pid can answer for.
    const lease = claimLease({ repoPath, errand: `gate round for ${label}`, holder, ownerPid: process.pid, root });
    if (!lease.ok) {
      const held = lease.lease;
      const told = tell({ lease: held, asker: holder, what: repoPath, errand: `gate round for ${label}` });
      return finish('lease', `${repoPath} is held by ${held.holder}${held.errand ? ` for “${held.errand}”` : ''}${told.told ? ` — ${held.holder} has been told` : ''}`);
    }
    say(`lease taken by ${holder.name}`);
  }

  // The suite right, machine-wide (D-0141): one full suite at a time on
  // eight gigabytes, and this round runs two. Taken here, before any work,
  // and held until the round is over — whoever holds the repository. A right
  // somebody else holds stops the round in their favour, because the gate is
  // the one thing that runs suites by machine and must not be the thing that
  // runs over a person's right to.
  const suiteRight = claimSuiteLease({ errand: `gate round for ${label}`, holder, ownerPid: process.pid, root });
  if (!suiteRight.ok) {
    if (holdLease) releaseLease({ repoPath, holder, root });
    const held = suiteRight.lease;
    // What runs under the right is measured, not defaulted: "nothing running"
    // as a default told PM a suite was idle while it was five minutes in.
    let running = [];
    try { running = await (suiteRunsNow || suiteRuns)({ env }); } catch { running = []; }
    const told = tell({ lease: held, asker: holder, what: 'the suite right', errand: `gate round for ${label}`, running });
    return finish('suite-lease', `the suite right is held by ${held.holder}${held.errand ? ` for “${held.errand}”` : ''} — one full suite at a time on this machine (D-0141); mc suite who says whether that run is still going${told.told ? `; ${held.holder} has been told` : ''}`);
  }
  const ownSuiteRight = !suiteRight.already;
  if (ownSuiteRight) say(`suite right taken by ${holder.name}${suiteRight.reaped ? ` (reaped from ${suiteRight.reaped.holder}: pid ${suiteRight.reaped.owner_pid} was gone)` : ''}`);

  // The other half of the way back. A SIGTERM — a shell's timeout, a closed
  // pane — ends node without running any `finally`; the pid in the lease
  // covers that for the next claim, and this covers it now: give both back
  // and then exit the way the signal asked. SIGKILL runs nothing, and is
  // what the pid is for.
  const onSignal = (signal) => {
    try {
      if (holdLease) releaseLease({ repoPath, holder, root });
      if (ownSuiteRight) releaseSuiteLease({ holder, root });
      say(`round cut short by ${signal} — leases released`);
    } finally {
      process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
    }
  };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.on(signal, onSignal);

  // What this repository needs, read before any work is done. A round that
  // cannot know whether the suite will be complete is a round whose green
  // means nothing, so it stops here rather than after two suite runs.
  const declared = declarationFor(repoPath, { root, env });
  if (!declared.ok) {
    if (holdLease) releaseLease({ repoPath, holder, root });
    if (ownSuiteRight) releaseSuiteLease({ holder, root });
    return finish('declaration', declared.reason);
  }
  report.declaration = { source: declared.source, ...declared.declaration };

  const workspace = join(gateRoot(root), repoFileSlug(repoPath));
  const baseDir = join(workspace, 'baseline');
  const headDir = join(workspace, 'candidate');

  try {
    // What the pull request actually is, rather than what the caller believes.
    // A number is all the caller has; the branch, its head, and the branch it
    // is aimed at all come from the forge.
    const all = [];
    for (const number of numbers) {
      const facts = prFacts({ gh: askGh, repoPath, pr: number });
      if (!facts.ok) return finish('pr', facts.reason);
      all.push(facts.pr);
      say(`#${facts.pr.number} — ${facts.pr.head} into ${facts.pr.base}`);
    }
    const facts = { pr: all[0] };
    Object.assign(report.pr, facts.pr);
    if (batch) {
      for (const [index, item] of all.entries()) Object.assign(report.prs[index], item);
      // One base, or it is not one candidate: a tree with two pull requests
      // aimed at different branches measures nothing anybody will land.
      const bases = [...new Set(all.map((item) => item.base))];
      if (bases.length > 1) return finish('pr', `the batch aims at ${bases.length} different bases (${bases.join(', ')}) — one round per base`);
    }

    // Fresh, always. The whole point of the baseline is that it is current,
    // and a stale remote-tracking ref is how a round measures against a main
    // that moved an hour ago.
    const fetched = await timed('fetch', async () => askGit(['fetch', 'origin', '--prune'], { cwd: repoPath }));
    if (fetched.status !== 0) return finish('fetch', trim(fetched.stderr) || 'git fetch failed');

    clearWorkspace({ git: askGit, repoPath, workspace });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });

    const baseRef = `origin/${facts.pr.base}`;

    // The baseline, carried forward instead of rerun (A1). After a green
    // merge, main is the tree the candidate was just measured on; measured
    // across 61 memoro rounds, 52 baselines were exactly the previous
    // round's candidate result, and across 92 the baseline never once
    // produced a red delta. The saved result is used only when every key
    // matches — the commit, the lockfile at that commit, the suite command
    // — and the chain breaks on the smallest deviation, with the run as it
    // always was. The red comparison keeps its form: it becomes free, not
    // absent.
    const commandLine = suiteCommand({ repoPath });
    if (!commandLine.ok) return finish('suite', commandLine.reason);
    report.command = commandLine.command;
    const baseCommit = trim(askGit(['rev-parse', baseRef], { cwd: repoPath }).stdout);
    const carried = baseCommit ? loadBaseline({
      repoPath,
      commit: baseCommit,
      lockfileHash: lockfileHashAt({ git: askGit, repoPath, commit: baseCommit }),
      command: report.command,
      root,
    }) : null;
    if (carried) {
      say(`baseline carried from the last green round: ${carried.red.length} red at ${baseCommit.slice(0, 7)}, measured ${carried.measured_at} — not rerun`);
    }

    // Whether the baseline worktree is needed at all. A carried suite result
    // spares the suite run — but an extra gate whose baseline result was not
    // carried still has to run somewhere, and "somewhere" is the base branch
    // as fetched (KP: an extra gate run only on the candidate attributed a
    // red main to the one PR in the room, 2026-08-24).
    const gates = declared.declaration.extra_gates || [];
    const gatesToRun = gates.filter((gate) => !carriedGate(carried, gate));
    const needBaseline = !carried || gatesToRun.length > 0;

    // Detached on purpose, both of them. The round must be able to merge the
    // base into the candidate without that ever becoming a commit on somebody's
    // branch: what is measured is a state, not a change to the repository.
    if (needBaseline) {
      const added = askGit(['worktree', 'add', '--detach', baseDir, baseRef], { cwd: repoPath });
      if (added.status !== 0) return finish('worktree', trim(added.stderr) || `could not check out ${baseRef}`);
    }

    if (!batch) {
      const candidate = askGit(['worktree', 'add', '--detach', headDir, facts.pr.head_sha], { cwd: repoPath });
      if (candidate.status !== 0) {
        return finish('worktree', trim(candidate.stderr) || `could not check out ${facts.pr.head_sha}`);
      }

      // The candidate is measured *after* merging the current base into it. A PR
      // that is green against the main its author branched from and red against
      // the main it is about to land on is exactly the collision this exists to
      // catch, and it is invisible if the head commit is tested on its own.
      const merged = askGit(['merge', '--no-edit', baseRef], { cwd: headDir });
      if (merged.status !== 0) {
        return finish('merge', `#${facts.pr.number} conflicts with ${baseRef} — ${trim(merged.stdout) || 'merge failed'}`);
      }
      say(`merged ${baseRef} into the candidate`);
    } else {
      // The batch candidate is the base with every head merged in, in the
      // order given — the tree main would be after landing them in that
      // order. A conflict names the pull request that could not go in, so
      // the caller can fall back to one round per pull request and say so.
      const candidate = askGit(['worktree', 'add', '--detach', headDir, baseRef], { cwd: repoPath });
      if (candidate.status !== 0) {
        return finish('worktree', trim(candidate.stderr) || `could not check out ${baseRef}`);
      }
      report.candidate_trees = [];
      for (const item of all) {
        const merged = askGit(['merge', '--no-edit', item.head_sha], { cwd: headDir });
        if (merged.status !== 0) {
          return finish('merge', `#${item.number} conflicts with ${baseRef} and the pull requests before it in the batch — ${trim(merged.stdout) || 'merge failed'}`);
        }
        // The prefix tree after each merge: T_i is what main must be after
        // landing the i-th pull request, byte for byte, if the sequential
        // squashes reproduce the build the suite measured. Only T_N was
        // measured; the chain is what makes each landing checkable the
        // second it happens rather than at the end (PM's ruling on the
        // tracks' disagreement, 2026-08-23).
        report.candidate_trees.push(trim(askGit(['rev-parse', 'HEAD^{tree}'], { cwd: headDir }).stdout) || null);
        say(`merged #${item.number} (${item.head}) into the candidate`);
      }
    }

    // Whatever this repository needs before its suite can be believed, run in
    // both worktrees. A prepare that fails stops the round: a suite run on a
    // tree that was not prepared is exactly the incomplete run the declaration
    // exists to prevent.
    const sides = needBaseline ? [['baseline', baseDir], ['candidate', headDir]] : [['candidate', headDir]];
    if (declared.declaration.prepare) {
      for (const [side, dir] of sides) {
        say(`preparing the ${side}: ${declared.declaration.prepare}`);
        const ready = await timed(`prepare ${side}`, async () => shell(declared.declaration.prepare, { cwd: dir, env }));
        if (ready.status !== 0) {
          return finish('prepare', `${declared.declaration.prepare} failed in the ${side} — ${trim(ready.stderr)}`);
        }
      }
    }

    // A suite in a worktree with no dependency tree does not fail, it shrinks
    // (D-0152): the tests that need nothing run and print a number with the
    // right shape, and the rest are neither run nor counted as skipped. So
    // the tree is checked after preparation and before either run, and a
    // missing one stops the round — unless the declaration vouches that this
    // suite runs without one (`prepare: null`, with the evidence in
    // `prepare_why`), in which case the round says so rather than assuming.
    for (const [side, dir] of sides) {
      const tree = dependencyTree(dir);
      if (!tree.missing) continue;
      if (declared.declaration.prepare === null) {
        say(`${side}: ${tree.declares} dependencies declared and no node_modules — the declaration vouches the suite runs without one`);
        continue;
      }
      return finish('dependencies', `the ${side} declares ${tree.declares} dependencies and has no node_modules after preparation — a suite run there would count only what happens to run (D-0152)`);
    }

    // Sequential, not parallel. Two full suites at once halves the wall clock
    // and loads the machine that both of them are measuring on — and the tests
    // that fail under load are the ones a gate can least afford to guess about.
    // The baseline goes first so a repository that cannot run its own suite is
    // found before the candidate's run is paid for.
    if (carried) {
      report.baseline = {
        commit: carried.commit,
        red: [...carried.red],
        totals: carried.totals,
        carried: true,
        measured_at: carried.measured_at,
      };
    } else {
      say('running the suite on the baseline — this takes a while');
      const before = await timed('suite baseline', () => measure({ suite: runSuite, git: askGit, cwd: baseDir, say, side: 'baseline' }));
      if (!before.ok) return finish('suite', `the baseline run ${before.reason}`);
      report.baseline = before.result;
    }

    // The number the word "green" used to sit on top of. Read off the
    // baseline, because the baseline *is* the base branch as fetched — this is
    // a statement about main, not about the pull request.
    report.standing_red = report.baseline.red.length;
    say(`baseline: ${report.baseline.red.length} red${report.baseline.carried ? ' (carried)' : ''}`);
    say('running the suite on the candidate');
    const after = await timed('suite candidate', () => measure({ suite: runSuite, git: askGit, cwd: headDir, say, side: 'candidate' }));
    if (!after.ok) return finish('suite', `the candidate run ${after.reason}`);
    report.candidate = after.result;
    // The measured tree's own hash, so a landing can later prove — not
    // assume — that main became exactly what was measured (track 3's
    // correction, 2026-08-23: "verified together" and "landed one at a
    // time" are two different claims, and only the first was measured).
    report.candidate.tree = trim(askGit(['rev-parse', 'HEAD^{tree}'], { cwd: headDir }).stdout) || null;

    const { broke, fixed } = compareRed(report.baseline.red, after.result.red);
    report.broke = broke;
    report.fixed = fixed;
    say(`candidate: ${after.result.red.length} red, ${broke.length} of them new`);

    if (broke.length) return finish('red', `${broke.length} test${broke.length === 1 ? '' : 's'} red on the candidate and green on the baseline`);

    // The floor, checked against the state this change would leave behind.
    //
    // Read from the *candidate* worktree, so a pull request that repairs tests
    // may record the smaller set in the same commit as the repair, and so the
    // set consulted is the one that would be on main after the merge. It is no
    // way around the comparison above: a change that added a red name has
    // already been stopped by `broke`, whatever it wrote in this file.
    const ratchet = readRatchet(headDir);
    report.ratchet = {
      present: ratchet.present,
      ok: ratchet.ok,
      file: RATCHET_FILE,
      accepted: ratchet.names.length,
      risen: [],
      fallen: [],
      baseline_risen: [],
      reason: ratchet.reason,
    };
    if (!ratchet.ok) return finish('ratchet', ratchet.reason);
    if (ratchet.present) {
      const moved = compareRatchet(ratchet.names, after.result.red);
      report.ratchet.risen = moved.risen;
      report.ratchet.fallen = moved.fallen;
      say(`ratchet: ${ratchet.names.length} accepted, ${moved.risen.length} above it, ${moved.fallen.length} below`);
      if (moved.risen.length) {
        return finish('ratchet', `${moved.risen.length} red name${moved.risen.length === 1 ? '' : 's'} `
          + `${moved.risen.length === 1 ? 'is' : 'are'} not in the standing red set recorded in ${RATCHET_FILE}`);
      }
      // The BASELINE against the floor too — the check nothing ran the day
      // 57 red passed through a round whose floor said 55 (measured
      // 2026-08-23: #385's candidate measured a tree at 55, #386's baseline
      // measured the same content at 57 minutes later; the 57 was compared
      // against nothing and written into a log line). A base above its own
      // floor is the base's instability or regression, never this PR's
      // fault, so it is flagged as loudly as a stop without being one —
      // and it is the replacement for the accident that found the last
      // one: a carried baseline (A1) would never have measured the 57.
      const unstable = compareRatchet(ratchet.names, report.baseline.red);
      report.ratchet.baseline_risen = unstable.risen;
      if (unstable.risen.length) {
        say(`BASELINE UNSTABLE — ${unstable.risen.length} red name${unstable.risen.length === 1 ? '' : 's'} on the baseline ${unstable.risen.length === 1 ? 'is' : 'are'} not in ${RATCHET_FILE}: ${unstable.risen.slice(0, 5).join(', ')}${unstable.risen.length > 5 ? ', …' : ''} — the base itself is flaky or regressed; not this change's doing`);
      }
    }
    // The pull request's own tests (D-0157). The suite answers "did anything
    // else break?"; this answers "is this change proved?" — and a suite that
    // globs some directories and not others had answered neither for a PR
    // whose tests lived in one it did not glob: the same count as the day
    // before, with 114 new test lines. So every `*.test.js` the PR adds or
    // changes is run, wherever it lies, from the same diff that counts red.
    // A list of directories would fix yesterday's hole and make tomorrow's.
    if (!batch) {
      const own = await timed('pr tests', () => ownTests({
        git: askGit, tests: runTests, cwd: headDir, baseRef, say, flags: declared.declaration.pr_tests_flags || [],
      }));
      report.pr_tests = own.result;
      if (!own.ok) return finish('pr-tests', own.reason);
    } else {
      // Each pull request's own tests, by itself: the files *it* adds or
      // changes against the base, run on the batch candidate. The suite ran
      // once for all of them; this is what keeps the batch from hiding which
      // pull request carried which test, and a red here names the one.
      for (const [index, item] of all.entries()) {
        say(`#${item.number}'s own tests`);
        const own = await timed('pr tests', () => ownTests({
          git: askGit, tests: runTests, cwd: headDir, baseRef, head: item.head_sha, say, flags: declared.declaration.pr_tests_flags || [],
        }));
        report.prs[index].pr_tests = own.result;
        if (!own.ok) return finish('pr-tests', `#${item.number}: ${own.reason}`);
      }
    }

    // Gates beyond the suite, run on BOTH sides and judged by the delta —
    // the same differential rule the suite has always had. Measured
    // 2026-08-24 (#10909's round): the extra gate ran only on the candidate,
    // main's own contract suite was red the whole time (5 fail, the same 5
    // on untouched origin/main), and the round said "FAILED on the
    // candidate" — attributing the world's standing red to the one party in
    // the room. A track spent six minutes proving its innocence.
    //
    // The baseline side is carried when the A1 entry holds this gate's
    // result (after a green merge, main *is* the tree the candidate's gates
    // ran on); otherwise it runs in the baseline worktree. A gate that
    // prints TAP is compared by red *names*, like the suite; one that does
    // not is compared by exit code. And under the same rule as ever: a side
    // that could not run at all is a stop, never an approval.
    // The gates run in an environment that asks node's test runner for TAP,
    // the way the suite already does: node 24 writes its spec reporter to a
    // pipe (measured 2026-08-24 — `# tests` never appears), so without this
    // the name comparison silently degrades to exit codes on every gate
    // that is a node test. A command that is not node ignores the variable.
    const gateEnv = { ...env };
    delete gateEnv.NODE_TEST_CONTEXT;
    gateEnv.NODE_OPTIONS = `${String(env.NODE_OPTIONS || '').replace(/--test-reporter(-destination)?[=\s]\S+/gu, '').trim()} --test-reporter=tap`.trim();
    const baseKeys = {
      repoPath,
      commit: baseCommit,
      lockfileHash: lockfileHashAt({ git: askGit, repoPath, commit: baseCommit }),
      root,
    };
    for (const gate of gates) {
      // The baseline side: the A1 entry (a candidate result a green merge
      // promoted), else the measured store (a baseline result kept whatever
      // its colour — on a red main there is no green merge to promote
      // anything, and rerunning the same red cost 662 s per round,
      // measured 2026-08-24), else run it here.
      const saved = carriedGate(carried, gate)
        || (baseCommit ? loadMeasuredGate({ ...baseKeys, command: gate.command }) : null);
      let base;
      if (saved) {
        base = { ok: saved.ok, exit_code: saved.exit_code ?? null, ran: true, red: Array.isArray(saved.red) ? saved.red : null, carried: true };
        say(`extra gate ${gate.name} on the baseline: carried (${base.ok ? 'passed' : `failed, exit ${base.exit_code}${base.red ? `, ${base.red.length} red` : ''}`}${saved.measured_at ? `, measured ${saved.measured_at}` : ''}) — not rerun`);
      } else {
        say(`extra gate ${gate.name} on the baseline`);
        base = gateSide(await timed('extra gates baseline', async () => shell(gate.command, { cwd: baseDir, env: gateEnv })));
        // Saved the moment it is taken, red included: the same keys as A1,
        // and exactly as deterministic.
        if (base.ran && baseCommit) {
          attemptQuietly(() => saveMeasuredGate({ ...baseKeys, gate: { command: gate.command, ok: base.ok, exit_code: base.exit_code, red: base.red } }));
        }
      }
      say(`extra gate ${gate.name} on the candidate`);
      const outcome = await timed('extra gates', async () => shell(gate.command, { cwd: headDir, env: gateEnv }));
      const head = gateSide(outcome);
      // Names when both sides have them; exit codes are the fallback claim.
      const named = base.red !== null && head.red !== null;
      const delta = named ? compareRed(base.red, head.red) : { broke: [], fixed: [] };
      // What was compared, said out loud — a gate that does the right thing
      // silently is a gate nobody can trust next time (PM, 2026-08-24; and
      // track 3 called it before the round ran: "5 red on both sides" can
      // be five DIFFERENT red on each and report nothing new).
      if (named) {
        if (base.red.length || head.red.length) {
          say(`extra gate ${gate.name}: baseline red [${nameSome(base.red) || 'none'}] · candidate red [${nameSome(head.red) || 'none'}] — ${delta.broke.length} new, ${delta.fixed.length} fixed`);
        }
      } else if (!base.ok || !head.ok) {
        say(`extra gate ${gate.name}: could not compare by name — falling back to exit codes; a new failure over a red baseline would not be seen`);
      }
      report.extra_gates.push({
        name: gate.name,
        command: gate.command,
        // The candidate's outcome under the old keys, so every reader that
        // asked "did the gate pass" keeps its answer.
        ok: head.ok,
        exit_code: head.exit_code,
        ran: head.ran,
        baseline: base,
        candidate: head,
        broke: delta.broke,
        fixed: delta.fixed,
        already_red: !base.ok && !head.ok && (!named || delta.broke.length === 0),
      });
      if (!head.ran) return finish('extra-gate', `${gate.name} could not be run at all — that is not an approval`);
      if (!base.ran) return finish('extra-gate', `${gate.name} could not be run on the baseline — that is not a measurement`);
      if (head.ok) {
        // A candidate that repairs a red baseline is a pass with a sentence,
        // not a stop with an apology.
        if (!base.ok) say(`extra gate ${gate.name}: red on the baseline, green on the candidate — this change repairs it`);
        continue;
      }
      if (base.ok) {
        return finish('extra-gate', `${gate.name} failed on the candidate and passed on the baseline`
          + ` (${trim(outcome.stderr) || `exit ${head.exit_code}`})`
          + (named && delta.broke.length ? ` — ${delta.broke.length} new red: ${nameSome(delta.broke)}` : ''));
      }
      if (named && delta.broke.length) {
        return finish('extra-gate', `${gate.name} was already red on the baseline (${base.red.length} red)`
          + ` and the candidate adds ${delta.broke.length} more: ${nameSome(delta.broke)}`);
      }
      // Exit 127 is the shell's own word for "no such command". Two sides
      // that both said it are not a broken base — they are a gate that never
      // ran, and calling that main's fault would be the same misattribution
      // pointed the other way.
      if (base.exit_code === 127 && head.exit_code === 127) {
        return finish('extra-gate', `${gate.name} could not be run on either side (exit 127 — command not found); that is not an approval`);
      }
      return finish('extra-gate-baseline', `${gate.name} was already red before this PR — `
        + (named
          ? `${base.red.length} red on the baseline (${nameSome(base.red)}), ${head.red.length} on the candidate, `
            + `${sameSets(base.red, head.red) ? `the same ${base.red.length}` : 'none of them new'}`
          : `exit ${base.exit_code} on the baseline, exit ${head.exit_code} on the candidate; `
            + 'could not compare by name — a new failure over a red baseline would not be seen')
        + ` — the base itself is broken; not this change's doing`);
    }

    return finish(null, null);
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    clearWorkspace({ git: askGit, repoPath, workspace });
    // Always, and last. A round that died half way through must not leave the
    // repository held by a session that is no longer running — but a round
    // running inside somebody else's lease gives back nothing, because the
    // holder is still using it.
    if (holdLease) {
      releaseLease({ repoPath, holder, root });
      say('lease released');
    }
    // The suite right too — only if this round took it. A holder who claimed
    // it by hand before the round keeps it afterwards; that was their claim.
    if (ownSuiteRight) {
      releaseSuiteLease({ holder, root });
      say('suite right released');
    }
  }
}

/**
 * What the round decided, as one word.
 *
 * `green` and `no-new-red` are both passes and they are not the same claim.
 * The first says the suite is clean. The second says only that it is no
 * dirtier than the branch it is aimed at — which is what this gate has always
 * measured, and what it used to report as "GREEN" over fifty-five red names.
 * Anything a machine wants to branch on should branch on this rather than on
 * the prose, and the two passes are separate words precisely so that a reader
 * who only ever wanted the strict one can still ask for it.
 */
export function verdictFor(report) {
  if (report.stopped_at === 'red') return 'red';
  if (report.stopped_at === 'ratchet') return 'ratchet-risen';
  if (report.stopped_at !== null) return 'stopped';
  return report.standing_red ? 'no-new-red' : 'green';
}

/**
 * The verdict as a headline, and never the word "green" over standing red.
 *
 * The number goes in the line rather than in a footnote somewhere, because the
 * line is what gets read out loud and reported onward. A verdict that needed a
 * document beside it to be understood correctly is the thing being fixed here.
 */
export function verdictHeadline(report) {
  const standing = report.standing_red ?? 0;
  if (!standing) return 'GREEN — the test gate passes';
  return `NO NEW RED — ${standing} standing red name${standing === 1 ? '' : 's'} on ${report.pr?.base || 'the base'}`;
}

/** The same statement mid-sentence, for a round that is narrating itself. */
export function verdictPhrase(report) {
  const standing = report.standing_red ?? 0;
  if (!standing) return 'gate green';
  return `no new red (${standing} standing red on ${report.pr?.base || 'the base'})`;
}

/**
 * One side of the round: run the suite, read what failed out of it.
 *
 * A run that never printed its totals did not finish — it died on a missing
 * dependency, a syntax error, a killed process — and its empty red set would
 * read as a clean sweep. Since both sides would usually die the same way, that
 * failure mode produces a confident green from two runs that never ran, which
 * is the worst thing this module could do. So an unfinished run stops the
 * round rather than counting as evidence.
 */
async function measure({ suite, git, cwd, say, side }) {
  const at = git(['rev-parse', 'HEAD'], { cwd });
  const run = await suite({ cwd, onLine: (line) => say(`${side}: ${line}`) });
  const totals = tapTotals(run.tap);
  if (!totals.finished) {
    return { ok: false, reason: 'never reached its own summary — the suite did not run to the end' };
  }
  if (!totals.tests) return { ok: false, reason: 'reported no tests at all' };
  return {
    ok: true,
    result: {
      // The commit of the throwaway worktree this side ran in — for the
      // candidate that is the PR's head with the base merged into it, which is
      // a commit that exists nowhere but here and is easily mistaken for the
      // branch head. `is` says which one it is so nothing has to be inferred.
      commit: at?.status === 0 ? String(at.stdout || '').trim() : null,
      is: side === 'baseline' ? 'base-branch-as-fetched' : 'pr-head-with-base-merged-in',
      exit_code: run.code,
      totals,
      red: redNames(run.tap),
    },
  };
}

/**
 * What a pull request is, asked of the forge rather than assumed.
 *
 * Closed and merged ones are refused: a round against something already landed
 * measures nothing, and the answer it would give — green — is the one most
 * likely to be acted on.
 */
function prFacts({ gh, repoPath, pr }) {
  const asked = gh(
    ['pr', 'view', String(pr), '--json', 'number,headRefName,baseRefName,headRefOid,state,title'],
    { cwd: repoPath },
  );
  if (asked.status !== 0) return { ok: false, reason: trim(asked.stderr) || `could not read #${pr}` };

  let raw = null;
  try { raw = JSON.parse(asked.stdout); } catch { return { ok: false, reason: `#${pr} came back as something other than JSON` }; }
  if (!raw?.headRefName || !raw?.baseRefName || !raw?.headRefOid) {
    return { ok: false, reason: `#${pr} did not say which branch it is` };
  }
  if (raw.state && raw.state !== 'OPEN') {
    return { ok: false, reason: `#${pr} is ${String(raw.state).toLowerCase()}, so there is nothing to gate` };
  }
  return {
    ok: true,
    pr: {
      number: raw.number ?? Number(pr),
      head: raw.headRefName,
      base: raw.baseRefName,
      head_sha: raw.headRefOid,
      title: raw.title ?? null,
    },
  };
}

/**
 * The repository's own definition of its full suite — `npm test`, verbatim.
 *
 * Deliberately not mc's idea of how to run tests, and deliberately not a
 * shorter command. A gate that runs a faster subset is not the gate; the whole
 * value of this is that what it runs is what the repository means by "the
 * suite", so nobody has to keep two definitions in agreement.
 */
function suiteCommand({ repoPath }) {
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')); } catch { manifest = null; }
  const script = manifest?.scripts?.test;
  if (!script) return { ok: false, reason: `${repoPath} has no npm test script — the gate has no suite to run` };
  return { ok: true, command: `npm test  (${script})` };
}

/**
 * Worktrees the round made, taken back — and the directory with them.
 *
 * `git worktree remove --force` first so the repository's own administrative
 * record goes away with the directory; `prune` afterwards for the case where
 * the directory is already gone and only the record is left, which is what an
 * interrupted round leaves behind.
 */
function clearWorkspace({ git, repoPath, workspace }) {
  for (const name of ['baseline', 'candidate']) {
    const dir = join(workspace, name);
    if (existsSync(dir)) {
      try { git(['worktree', 'remove', '--force', dir], { cwd: repoPath }); } catch { /* pruned below */ }
    }
  }
  try { git(['worktree', 'prune'], { cwd: repoPath }); } catch { /* nothing to prune */ }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* gone */ }
}

function seconds(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function trim(value) {
  return String(value || '').trim().split('\n').slice(0, 3).join(' ');
}

/**
 * The real suite run: `npm test`, streamed, with TAP asked for through the
 * environment.
 *
 * The reporter cannot be appended to the command — node reads `--test-reporter`
 * before the file patterns, so a flag added on the end is silently ignored, and
 * a gate whose output format depended on that would parse an empty red set out
 * of a perfectly red run. `NODE_OPTIONS` reaches the same setting without
 * touching the repository's own command, which is the property worth keeping:
 * what runs is exactly `npm test`.
 *
 * Streamed rather than collected at the end because this takes tens of
 * minutes, and a round that says nothing for forty minutes is one nobody can
 * tell from a hung one.
 */
/**
 * A declared command, run where the round needs it.
 *
 * Through a shell because declarations are written the way a person writes
 * them — `npm ci`, `npm run test:msr:contract` — and splitting those by hand
 * would be a second grammar to get wrong. The strings come from mc's own table
 * or from a file only the operator can write, which is the same trust boundary
 * the suite command already sits on.
 */
/** A test file, by the name people actually give them. */
const TEST_FILE = /\.test\.(?:js|mjs|cjs)$/u;

/**
 * The pull request's own tests, run on the candidate.
 *
 * The files come from the same diff that counts red: what the PR adds or
 * changes against the base it is measured against (`--diff-filter=AM`, so a
 * deleted test is not asked to run). Held to the suite's rule — a run that
 * never summarised, or summarised nothing, is a stop, not an approval — and
 * one red among them stops the round even with the whole suite green, because
 * the suite never ran these and its green says nothing about them.
 *
 * A PR that touches no test file is recorded as exactly that, `files: []`,
 * and the round goes on: that fact belongs to the reviewer, not to the gate.
 */
async function ownTests({ git, tests, cwd, baseRef, head = 'HEAD', say, flags = [] }) {
  // `baseRef...head`: what the pull request changed since it left the base,
  // not what the base changed since — on a batch candidate, HEAD carries the
  // other pull requests' files too, and a plain two-dot diff would run them
  // under this one's name.
  const diff = git(['diff', '--name-only', '--diff-filter=AM', `${baseRef}...${head}`], { cwd });
  if (diff?.status !== 0) {
    return { ok: false, reason: 'could not list the files the pull request changes', result: null };
  }
  const files = String(diff.stdout || '').split('\n').map((line) => line.trim()).filter((line) => TEST_FILE.test(line));
  if (files.length === 0) {
    say('the pull request adds or changes no test file');
    return { ok: true, result: { files, totals: null, red: [], exit_code: null } };
  }
  say(`running the pull request's own tests: ${files.length} file${files.length === 1 ? '' : 's'}`);
  if (flags.length) say(`pr tests run with the declared flags: ${flags.join(' ')}`);
  const run = await tests({ cwd, files, flags, onLine: (line) => say(`pr tests: ${line}`) });
  const totals = tapTotals(run.tap);
  const red = redNames(run.tap);
  const result = { files, totals, red, exit_code: run.code };
  if (!totals.finished) return { ok: false, reason: 'the pull request\'s own tests never reached their summary', result };
  if (!totals.tests) return { ok: false, reason: 'the pull request\'s own test files reported no tests at all', result };
  if (red.length) {
    return { ok: false, reason: `${red.length} of the pull request's own tests ${red.length === 1 ? 'is' : 'are'} red: ${red.slice(0, 3).join(', ')}${red.length > 3 ? ', …' : ''}`, result };
  }
  return { ok: true, result };
}

/**
 * How the repository runs node tests, read from its own `test` script.
 *
 * A bare `node --test <file>` is not how every repository runs its tests:
 * this one needs `--import ./tests/_isolate-home.mjs` or its tests write into
 * the real home. So the flags the script gives node are kept — `--import`,
 * `--require`, `--conditions`, the experimental ones — and the globs are not,
 * since the files are the point. A script that is not a `node --test` line
 * gets bare `node --test`, and the report names the files either way.
 */
function nodeTestFlags(cwd) {
  let script = '';
  try {
    script = String(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts?.test || '');
  } catch { return []; }
  if (!/^node\s+(?:.*\s)?--test(?:\s|$)/u.test(script)) return [];
  const tokens = script.slice(4).trim().split(/\s+/u);
  const flags = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--test' || !token.startsWith('--')) continue;
    if (token.startsWith('--test-reporter') || token.startsWith('--test-')) continue;
    if (token.includes('=')) { flags.push(token); continue; }
    flags.push(token);
    if (['--import', '--require', '--conditions', '-C', '--loader'].includes(token) && tokens[i + 1]) {
      flags.push(tokens[i + 1]);
      i += 1;
    }
  }
  return flags;
}

function realTests({ cwd, files, flags = [], onLine = () => {}, env = process.env } = {}) {
  return new Promise((resolve) => {
    const clean = { ...env };
    delete clean.NODE_TEST_CONTEXT;
    const inherited = String(clean.NODE_OPTIONS || '')
      .replace(/--test-reporter(-destination)?[=\s]\S+/gu, '')
      .trim();
    // Declared flags first; the test-script heuristic only when none are.
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...(flags.length ? flags : nodeTestFlags(cwd)), ...files], {
      cwd,
      env: { ...clean, NODE_OPTIONS: inherited },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tap = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      tap += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (/^# (tests|pass|fail) /u.test(line)) onLine(line.trim());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { /* the verdict is in the TAP */ });
    child.on('error', (error) => resolve({ code: -1, tap, error: error.message }));
    child.on('close', (code) => resolve({ code, tap }));
  });
}

function shell(command, { cwd, env }) {
  return spawnSync(command, { cwd, env, shell: true, encoding: 'utf8' });
}

/**
 * One side of an extra gate, read off the run.
 *
 * The red names are taken only from output that finished as TAP — a gate
 * that prints something TAP-like but never summarised gets `red: null`, and
 * the comparison falls back to exit codes rather than trusting half a
 * parse. stdout and stderr both, because npm puts its own banner on one and
 * node's reporter writes on the other depending on the wrapper.
 */
function gateSide(outcome) {
  const ran = outcome.status !== null && outcome.status !== undefined;
  const output = `${outcome.stdout || ''}\n${outcome.stderr || ''}`;
  const finished = tapTotals(output).finished;
  return {
    ok: ran && outcome.status === 0,
    exit_code: outcome.status ?? null,
    ran,
    red: finished ? redNames(output) : null,
    carried: false,
  };
}

/** A few names, and how many were not named. */
function nameSome(names) {
  return `${names.slice(0, 5).join(', ')}${names.length > 5 ? `, … and ${names.length - 5} more` : ''}`;
}

/** The same red set on both sides — the sentence "the same five" hangs on this. */
function sameSets(a, b) {
  return a.length === b.length && a.every((name) => b.includes(name));
}

/** Best effort where failing must not fail the round — a cache is a saving, never a stop. */
function attemptQuietly(fn) {
  try { return fn(); } catch { return null; }
}

function realSuite({ cwd, onLine = () => {}, env = process.env } = {}) {
  return new Promise((resolve) => {
    // The suite is started in a clean test context, not this process's.
    //
    // `NODE_TEST_CONTEXT` is set by node inside a test run, and a suite that
    // inherits it decides it is being required recursively and skips running
    // its files altogether — output with no results, exit code 0. The gate's
    // unfinished-run guard turns that into a stop rather than a false green,
    // but the round could never run at all. Which is exactly what happened the
    // first time this module's own live test tried to gate a repository.
    const clean = { ...env };
    delete clean.NODE_TEST_CONTEXT;
    // And any reporter the caller's own environment was already asking for.
    // Node rejects a second `--test-reporter` without a matching destination
    // (`ERR_INVALID_ARG_VALUE`) and the suite dies before running a thing — so
    // a gate run from inside a TAP-reported test run could not gate anything.
    // Found by this gate refusing this module's own pull request.
    const inherited = String(clean.NODE_OPTIONS || '')
      .replace(/--test-reporter(-destination)?[=\s]\S+/gu, '')
      .trim();
    const child = spawn('npm', ['test'], {
      cwd,
      env: { ...clean, NODE_OPTIONS: `${inherited} --test-reporter=tap`.trim() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tap = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      tap += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      // Only the milestones: a TAP stream is thousands of lines and the point
      // of saying anything is to show the round is alive.
      for (const line of lines) if (/^# (tests|pass|fail) /u.test(line)) onLine(line.trim());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { /* npm's own noise; the verdict is in the TAP */ });

    child.on('error', (error) => resolve({ code: -1, tap, error: error.message }));
    child.on('close', (code) => resolve({ code, tap }));
  });
}
