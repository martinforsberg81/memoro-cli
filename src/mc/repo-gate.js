/**
 * The gate round, as a machine.
 *
 * The rule it enforces: a test the change reaches is either green, or the
 * round is red. Whether main was already red is not the round's question —
 * ruled by Martin on 2026-08-31, after the differential form spent half of
 * every round's wall clock, a second worktree and a second `npm ci` answering
 * it. What is measured is the diff: the test files the repository's selector
 * says the change reaches, and the command gates it named beside them.
 *
 * The round, in order, stopping at the first red step:
 *
 *  1. take the repository's lease, so two rounds cannot measure against each
 *     other's moving main;
 *  2. read what the pull request actually is, from `gh`;
 *  3. build ONE throwaway worktree — the PR's head with the current base
 *     merged into it, so what is measured is the state after merging rather
 *     than the state the author last saw;
 *  4. run what the repository's selection reached — or, with `full`, the
 *     repository's own whole suite, which is the only reading here that is
 *     about the code rather than about a change;
 *  5. run the command gates the repository's selection named;
 *  6. give the lease back, whatever happened.
 *
 * There is no merge in here, and not behind a flag either. This module answers
 * one question — is this change red — and a module that could also merge would
 * be one `if` away from a round that merged on a verdict it had not finished
 * forming. Merging lives in `repo-merge.js`, which runs this and acts on the
 * report; keeping it out of here is load-bearing rather than tidy, and a test
 * asserts against this file's source that it stays out.
 *
 * It says what it measured, never "the pull request is good". Reading the diff
 * against its contract is judgement, and judgement is not mechanical; a
 * passing suite carrying an unescalated design decision is exactly the mistake
 * that conflation would license.
 *
 * The strictness has a cost, and it is said out loud rather than discovered:
 * a change whose reached tests include one that is already red on main is red,
 * and cannot land until that test is green. The differential form let that
 * through, at the price of measuring main every round to find out. The repair
 * is a selector that reaches fewer unrelated tests, which belongs in the
 * repository rather than in a second measurement here.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { claimLease, releaseLease } from './repo-lease.js';
import { tellHolder } from './lease-refusal.js';
import { redNames, tapTotals } from './tap-red.js';
import { currentHolder } from './work-identity.js';
import { describeRunning, releaseGateLock, takeGateLock } from './gate-lock.js';
import { log } from './logger.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';
import { dependencyTree } from './dependency-tree.js';
import { declarationFor } from './repo-gate-table.js';

export const GATE_SCHEMA = 'mc-repo-gate';
export const GATE_VERSION = 1;

/** Where the throwaway worktree lives: mc's own home, never inside the repository. */
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
  // with all of them merged in, the suite once, and each pull
  // request's own tests still run by themselves so the batch never hides
  // which one carried which test. `pr` alone is the single-PR round it
  // always was.
  prs = null,
  // The whole suite on one tree, instead of the files the diff reaches. Asked
  // for, never scheduled: it is the one reading here that is about the code
  // rather than about a change, and with no pull request it measures the
  // default branch as fetched.
  full = false,
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
  // Whether the round owns the lease or is running inside somebody else's.
  //
  // The merge step has to hold one lease across the gate *and* the merge — a
  // round that let go in between would be measuring against a main another
  // round was free to move. So it claims first and passes `holdLease: false`,
  // and this module neither takes nor gives back what it did not claim.
  holdLease = true,
} = {}) {
  const startedAt = clock();
  // The narration goes two places. `onProgress` is the operator's stderr and
  // scrolls away with the pane; the log keeps it under this run's id, so a
  // round that is killed still says how far it had got and what it had decided
  // by then — the thing that was missing on 2026-08-30. One funnel, so a line
  // cannot reach one and miss the other.
  const say = (message) => {
    log('gate.say', { text: message });
    try { onProgress(message); } catch { /* progress is a courtesy */ }
  };

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

  const numbers = (Array.isArray(prs) && prs.length ? prs : [pr]).filter((n) => n !== null && n !== undefined).map(Number);
  const batch = numbers.length > 1;
  // `mc test <repo> --full` names no pull request: there is nothing to merge
  // in, and the one tree is the default branch as fetched.
  const wholeSuite = Boolean(full);
  const label = numbers.length ? (batch ? numbers.map((n) => `#${n}`).join(' ') : `#${numbers[0]}`) : 'the whole suite';

  const report = {
    schema: GATE_SCHEMA,
    version: GATE_VERSION,
    repo: repoPath,
    // What was measured, as a word: the diff a pull request makes, or the
    // repository's own suite on one tree.
    full: wholeSuite,
    pr: { number: numbers[0] ?? null, head: null, base: null, head_sha: null, title: null },
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
    // The branch the candidate was measured against, and the commit it stood
    // at when the round fetched. Not a measurement of it — nothing is run
    // there — but `mc merge` has to know whether the ground moved between the
    // round and the landing, and this is the ground.
    base: null,
    // What the round measured, when the repository selects by diff: the files
    // the change reaches. Null when the repository has no `select`, or when
    // `--full` asked for the whole suite instead.
    selection: null,
    extra_gates: [],
    // The pull request's own tests: every `*.test.js` it adds or changes, run
    // on the candidate after the suite (D-0157). `files: []` when it touches
    // none, which is said rather than left blank.
    pr_tests: null,
    candidate: null,
    // The prefix trees of a batch candidate as it was built, `T_1..T_N`:
    // what main must be, byte for byte, after each landing. Null for a
    // single round; `T_N` equals `candidate.tree`.
    candidate_trees: null,
    // The verdict as a word a reader can branch on: `green`, `red`, or
    // `stopped`. There is no third pass any more — `no-new-red` was the
    // differential form's word for "no dirtier than main", and the round no
    // longer measures main to be able to say it.
    verdict: null,
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

  // One gate round at a time on this machine (gate-lock.js). A full suite
  // pins the cores for a minute and a half, and this round runs two; two
  // rounds at once make both slower and both flakier, and the flakiness lands
  // on whichever pull request happened to be measured.
  //
  // A file and a pid, and nothing else. What was here was "the suite right" —
  // a lease with an errand, a liveness verdict, a --force release, an inbox
  // message, a row on the page and four verbs of its own. Four hundred lines
  // of vocabulary for "one at a time", under a name nobody could say without
  // explaining it.
  const held = takeGateLock({ repo: repoFileSlug(repoPath), pr: numbers[0] ?? null, root });
  if (!held.ok) {
    if (holdLease) releaseLease({ repoPath, holder, root });
    return finish('busy', describeRunning(held.running));
  }
  const ownGateLock = held.took;
  if (ownGateLock) say(`gate round started (pid ${process.pid}) — one at a time on this machine`);
  else say('the round lock could not be written — running anyway; another round could overlap this one');

  // The other half of the way back. A SIGTERM — a shell's timeout, a closed
  // pane — ends node without running any `finally`; the pid in the lease
  // covers that for the next claim, and this covers it now: give both back
  // and then exit the way the signal asked. SIGKILL runs nothing, and is
  // what the pid is for.
  const onSignal = (signal) => {
    try {
      // Written first, before the releases: this is the one line that says a
      // round ended by signal rather than by verdict, and a release that
      // throws must not be able to take it with it.
      log('gate.killed', { repo: repoFileSlug(repoPath), signal, pr: label, holder: holder?.name || null });
      if (holdLease) releaseLease({ repoPath, holder, root });
      if (ownGateLock) releaseGateLock({ root });
      say(`round cut short by ${signal} — the lease and the round lock are released`);
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
    if (ownGateLock) releaseGateLock({ root });
    return finish('declaration', declared.reason);
  }
  report.declaration = { source: declared.source, ...declared.declaration };
  // An override that shadows shipped fields does it in silence — it took
  // extra_gates on 2026-08-22 (D-0135) and pr_tests_flags on 2026-08-24,
  // one repository, same hole. The table says which fields fell out; the
  // round says it where somebody is listening.
  for (const field of declared.shadowed || []) {
    say(`DECLARATION SHADOWED — the override for ${declared.name} omits ${field}, which the shipped table declares; an override states every field it wants (D-0135)`);
  }

  const workspace = join(gateRoot(root), repoFileSlug(repoPath));
  // One worktree. There was a second, at the base branch, and everything that
  // ran in it answered "was main already red?" — the question the 2026-08-31
  // ruling took off the round.
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
    const facts = { pr: all[0] || null };
    if (facts.pr) Object.assign(report.pr, facts.pr);
    if (batch) {
      for (const [index, item] of all.entries()) Object.assign(report.prs[index], item);
      // One base, or it is not one candidate: a tree with two pull requests
      // aimed at different branches measures nothing anybody will land.
      const bases = [...new Set(all.map((item) => item.base))];
      if (bases.length > 1) return finish('pr', `the batch aims at ${bases.length} different bases (${bases.join(', ')}) — one round per base`);
    }

    // Fresh, always. What is measured is the tree after the current base has
    // been merged in, and a stale remote-tracking ref is how a round measures
    // a main that moved an hour ago.
    const fetched = await timed('fetch', async () => askGit(['fetch', 'origin', '--prune'], { cwd: repoPath }));
    if (fetched.status !== 0) return finish('fetch', trim(fetched.stderr) || 'git fetch failed');

    clearWorkspace({ git: askGit, repoPath, workspace });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });

    // The branch the change is aimed at — or, with no pull request to ask it
    // of, the default branch as the remote itself names it. Assuming `main`
    // here would measure a tree nobody asked about on a repository that calls
    // it something else, so it is read, and a repository that will not say is
    // a stop.
    const baseRef = facts.pr ? `origin/${facts.pr.base}` : defaultBaseRef({ git: askGit, repoPath });
    if (!baseRef) return finish('base', 'no pull request named a base and origin does not say which branch is its default');
    report.base = { ref: baseRef, commit: trim(askGit(['rev-parse', baseRef], { cwd: repoPath }).stdout) || null };

    // What gets run: the test files the repository's selector says this change
    // reaches, or the repository's own whole suite. `full` asks for the second
    // on purpose; a repository with no `select` gets it either way.
    const selects = Boolean(declared.declaration.select) && !wholeSuite;
    const commandLine = suiteCommand({ repoPath });
    if (!commandLine.ok && !selects) return finish('suite', commandLine.reason);
    report.command = selects ? declared.declaration.select : commandLine.command;

    // Detached on purpose. The round must be able to merge the base into the
    // candidate without that ever becoming a commit on somebody's branch:
    // what is measured is a state, not a change to the repository.
    if (!facts.pr) {
      const only = askGit(['worktree', 'add', '--detach', headDir, baseRef], { cwd: repoPath });
      if (only.status !== 0) return finish('worktree', trim(only.stderr) || `could not check out ${baseRef}`);
      say(`measuring ${baseRef} as fetched — the whole suite, one tree`);
    } else if (!batch) {
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

    // Whatever this repository needs before its suite can be believed. A
    // prepare that fails stops the round: a suite run on a tree that was not
    // prepared is exactly the incomplete run the declaration exists to
    // prevent. Once, now — it used to run in both worktrees, and on memoro
    // that was a second `npm ci` for a 492 MB tree every round.
    if (declared.declaration.prepare) {
      say(`preparing the candidate: ${declared.declaration.prepare}`);
      const ready = await timed('prepare', async () => shell(declared.declaration.prepare, { cwd: headDir, env }));
      if (ready.status !== 0) {
        return finish('prepare', `${declared.declaration.prepare} failed in the candidate — ${trim(ready.stderr)}`);
      }
    }

    // A suite in a worktree with no dependency tree does not fail, it shrinks
    // (D-0152): the tests that need nothing run and print a number with the
    // right shape, and the rest are neither run nor counted as skipped. So
    // the tree is checked after preparation and before the run, and a missing
    // one stops the round — unless the declaration vouches that this suite
    // runs without one (`prepare: null`, with the evidence in `prepare_why`),
    // in which case the round says so rather than assuming.
    const tree = dependencyTree(headDir);
    if (tree.missing) {
      if (declared.declaration.prepare === null) {
        say(`${tree.declares} dependencies declared and no node_modules — the declaration vouches the suite runs without one`);
      } else {
        return finish('dependencies', `the candidate declares ${tree.declares} dependencies and has no node_modules after preparation — a suite run there would count only what happens to run (D-0152)`);
      }
    }

    // What this change reaches, asked of the repository rather than assumed.
    let selection = null;
    if (selects) {
      selection = await timed('selection', () => selectFiles({
        command: declared.declaration.select, cwd: headDir, env, say,
      }));
      if (!selection.ok) return finish('selection', selection.reason);
      report.selection = {
        command: declared.declaration.select,
        files: selection.files.length,
        // The selector's own admission that it could not narrow this change,
        // carried through so the verdict does not read as a saving it is not.
        full_suite: Boolean(selection.full),
        why: selection.why,
        // The command gates the same answer named. Counted here and listed in
        // `extra_gates`, where every gate this round ran is listed.
        commands: selection.commands.length,
      };
      say(`selection: ${selection.files.length} test file${selection.files.length === 1 ? '' : 's'} reached by this change`);
      if (selection.files.length === 0) {
        return finish('selection', 'the repository selected no test files for this change at all — that is not a measurement');
      }
    }

    // The one run. What it finds red is the verdict: there is no second tree
    // to subtract, so a test the change reaches is either green or the round
    // is red.
    const flags = declared.declaration.pr_tests_flags || [];
    const is = facts.pr ? 'pr-head-with-base-merged-in' : 'base-branch-as-fetched';
    const after = selection
      ? await (say(`running the ${selection.files.length} file${selection.files.length === 1 ? '' : 's'} this change reaches`), timed('suite', () => measureSelected({
        tests: runTests, git: askGit, cwd: headDir, files: selection.files, flags, say, is,
      })))
      : await (say('running the whole suite — this takes a while'), timed('suite', () => measure({
        suite: runSuite, git: askGit, cwd: headDir, say, is,
      })));
    if (!after.ok) return finish('suite', `the run ${after.reason}`);
    report.candidate = after.result;
    // The measured tree's own hash, so a landing can later prove — not
    // assume — that main became exactly what was measured (track 3's
    // correction, 2026-08-23: "verified together" and "landed one at a
    // time" are two different claims, and only the first was measured).
    report.candidate.tree = trim(askGit(['rev-parse', 'HEAD^{tree}'], { cwd: headDir }).stdout) || null;

    // The gates the selection named, on the candidate. After the files, in the
    // order the selector gave, and before any verdict is reached — a round that
    // stopped at a red test and skipped them would report a contract as
    // unchecked exactly when it is least safe to assume it holds.
    const selectedGates = selection?.commands?.length
      ? await runSelectedCommands({
        commands: selection.commands, cwd: headDir, env, baseRef, say, timed, clock,
      })
      : [];
    report.extra_gates.push(...selectedGates);
    const failedGates = selectedGates.filter((gate) => !gate.ok);

    say(`${after.result.red.length} red`);
    if (after.result.red.length) {
      const red = after.result.red;
      return finish('red', `${red.length} test${red.length === 1 ? '' : 's'} red: ${nameSome(red)}`);
    }

    // A command gate the selection chose is a contract about this diff, and a
    // change that breaks one is red whatever its tests did. They all ran; the
    // stop names every one that failed rather than the first.
    if (failedGates.length) {
      return finish('selected-gate', `${failedGates.length} command gate${failedGates.length === 1 ? '' : 's'} the selection chose failed: `
        + `${failedGates.map((gate) => `${gate.name} (exit ${gate.exit_code})`).join(', ')}`);
    }

    // The pull request's own tests (D-0157). The suite answers "did anything
    // else break?"; this answers "is this change proved?" — and a suite that
    // globs some directories and not others had answered neither for a PR
    // whose tests lived in one it did not glob: the same count as the day
    // before, with 114 new test lines. So every `*.test.js` the PR adds or
    // changes is run, wherever it lies, from the same diff that counts red.
    // A list of directories would fix yesterday's hole and make tomorrow's.
    if (facts.pr && !batch) {
      const own = await timed('pr tests', () => ownTests({
        git: askGit, tests: runTests, cwd: headDir, baseRef, say, flags: declared.declaration.pr_tests_flags || [],
      }));
      report.pr_tests = own.result;
      if (!own.ok) return finish('pr-tests', own.reason);
    } else if (batch) {
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

    // Gates an operator declared beside the suite, run on the candidate.
    //
    // They ran on both sides until 2026-08-31 and were judged by the delta,
    // for the reason the suite was: an extra gate run only on the candidate
    // had attributed a red main to the one PR in the room (#10909's round,
    // 2026-08-24). That protection is gone with the baseline, deliberately —
    // the ruling is that main's own red is not the round's question, and a
    // declared gate that is red on main is red here.
    //
    // The gates run in an environment that asks node's test runner for TAP,
    // the way the suite already does: node 24 writes its spec reporter to a
    // pipe (measured 2026-08-24 — `# tests` never appears), so without this
    // the red names silently degrade to exit codes on every gate that is a
    // node test. A command that is not node ignores the variable.
    const gates = declared.declaration.extra_gates || [];
    const gateEnv = { ...env };
    delete gateEnv.NODE_TEST_CONTEXT;
    gateEnv.NODE_OPTIONS = `${String(env.NODE_OPTIONS || '').replace(/--test-reporter(-destination)?[=\s]\S+/gu, '').trim()} --test-reporter=tap`.trim();
    for (const gate of gates) {
      say(`extra gate ${gate.name}`);
      const outcome = await timed('extra gates', async () => shell(gate.command, { cwd: headDir, env: gateEnv }));
      const head = gateSide(outcome);
      report.extra_gates.push({
        // What an operator declared beside the suite, as opposed to what the
        // repository's selector chose for this diff.
        source: 'declaration',
        name: gate.name,
        command: gate.command,
        ok: head.ok,
        exit_code: head.exit_code,
        ran: head.ran,
        // The red names when the gate printed TAP that finished, null when it
        // did not — the difference between "these failed" and "it failed".
        red: head.red,
        output: trim(outcome.stderr) || trim(outcome.stdout) || null,
      });
      if (!head.ran) return finish('extra-gate', `${gate.name} could not be run at all — that is not an approval`);
      if (!head.ok) {
        return finish('extra-gate', `${gate.name} failed (${trim(outcome.stderr) || `exit ${head.exit_code}`})`
          + (head.red?.length ? ` — ${head.red.length} red: ${nameSome(head.red)}` : ''));
      }
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
    // And the round lock, only if this round wrote it, and only while it is
    // still ours — see releaseGateLock.
    if (ownGateLock) releaseGateLock({ root });
  }
}

/**
 * What the round decided, as one word.
 *
 * Three of them, and no more. `no-new-red` was the differential form's pass —
 * "no dirtier than the branch it is aimed at" — and it took a second worktree
 * and half the round's wall clock to be able to say. A round now measures one
 * tree, so a pass is a pass: `green`.
 *
 * Anything a machine wants to branch on should branch on this rather than on
 * the prose.
 */
export function verdictFor(report) {
  if (report.stopped_at === 'red') return 'red';
  // A contract gate this change breaks is red, and the word a reader acts on
  // should not depend on whether a test or a command found it.
  if (report.stopped_at === 'selected-gate') return 'red';
  if (report.stopped_at !== null) return 'stopped';
  return 'green';
}

/**
 * The verdict as a headline.
 *
 * It used to carry a number — the standing red on the base — because "GREEN"
 * over fifty-five red names was the larger claim read out of the smaller one.
 * The round no longer measures the base, so there is no number to carry and no
 * second reading to guard against: green is green. What ran is a count on the
 * line under it, not a clause in here (2026-08-31).
 */
export function verdictHeadline(report) {
  return `GREEN — the test gate passes${scopeOf(report)}`;
}

/** The same statement mid-sentence, for a round that is narrating itself. */
export function verdictPhrase(report) {
  return `gate green${scopeOf(report)}`;
}

/**
 * How far the verdict reaches — the one clause of it a reader must act on.
 *
 * It used to carry the number too: *"measured over the 17 test files this
 * change reaches, not the whole suite"*. The number is still in the verdict,
 * as a count on the line saying what ran (`ranPhrase` in `commands/repo.js`),
 * which meets ruling 4's second condition without the prose around it. Ruled
 * 2026-08-31: the sentence was the part a reader had to weigh.
 *
 * What is left is an admission, and it stays because it changes what to do
 * with the verdict. A selector that gave up and returned everything must not
 * read as a narrow measurement — "the 258 files this change reaches" when 258
 * is the whole suite is true and misleading in the same breath. `--full` says
 * so for the same reason from the other side: it measured a branch, not a
 * change.
 */
function scopeOf(report) {
  if (report.full) return ' — over the whole suite, asked for by --full';
  if (report.selection?.full_suite) return ' — over the whole suite: the selector could not narrow this change';
  return '';
}

/**
 * The whole suite, run once, with what failed read out of it.
 *
 * A run that never printed its totals did not finish — it died on a missing
 * dependency, a syntax error, a killed process — and its empty red set would
 * read as a clean sweep. With one side and nothing to compare against, that is
 * the whole verdict, so an unfinished run stops the round rather than counting
 * as evidence.
 */
async function measure({ suite, git, cwd, say, is }) {
  const at = git(['rev-parse', 'HEAD'], { cwd });
  const run = await suite({ cwd, onLine: (line) => say(line) });
  const totals = tapTotals(run.tap);
  if (!totals.finished) {
    return { ok: false, reason: 'never reached its own summary — the suite did not run to the end' };
  }
  if (!totals.tests) return { ok: false, reason: 'reported no tests at all' };
  return {
    ok: true,
    result: {
      // The commit of the throwaway worktree the run happened in — for a pull
      // request that is its head with the base merged into it, which is a
      // commit that exists nowhere but here and is easily mistaken for the
      // branch head. `is` says which one it is so nothing has to be inferred.
      commit: at?.status === 0 ? String(at.stdout || '').trim() : null,
      is,
      exit_code: run.code,
      totals,
      red: redNames(run.tap),
    },
  };
}

/**
 * The test files this change reaches, and the command gates beside them, asked
 * of the repository.
 *
 * The command prints JSON carrying a `files` array; anything else is a stop
 * rather than an empty list, because an empty list and a list that could not be
 * read look identical to a comparison and only one of them is a measurement.
 *
 * `commands` is the other half of the same answer and was thrown away until
 * 2026-08-31: memoro's selector reported six of them on #11158 — i18n three
 * times, `sdk:check`, `css:lint`, `css:tokens`, 20.0 s in all — and no round
 * had run one since `select` was declared. A gate that reads half a selection
 * and reports a verdict is a gate that lies about what it checked.
 *
 * Run in the candidate worktree, so the diff it computes is the pull request's.
 */
async function selectFiles({ command, cwd, env, say }) {
  const run = shell(command, { cwd, env });
  if (run.status !== 0) {
    return { ok: false, reason: `${command} failed in the candidate — ${trim(run.stderr) || `exit ${run.status}`}` };
  }
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch {
    return { ok: false, reason: `${command} did not print JSON — a selection that cannot be read is not a selection` };
  }
  const files = parsed?.files;
  if (!Array.isArray(files)) {
    return { ok: false, reason: `${command} printed JSON with no \`files\` array` };
  }
  const clean = files.map(String).filter(Boolean);
  // A selector may say it gave up and returned everything. memoro-cli's does
  // that whenever a changed path is not source it can trace, and the round has
  // to repeat the admission rather than present the whole suite as a narrow
  // measurement — "measured over the 258 files this change reaches" is true and
  // reads as a saving when 258 is the entire suite.
  const full = parsed?.why?.reason === 'full-suite';

  // The gates the selector named. A repository that reports none has none —
  // that is memoro-cli's own selector, and an absent field is not a fault. A
  // `commands` that is not a list, or an entry with no script to run, is the
  // same kind of unreadable as a missing `files`: it stops, because running
  // fewer gates than the repository asked for is exactly the silence this
  // whole reading exists to end.
  const declaredCommands = parsed?.commands;
  if (declaredCommands !== undefined && !Array.isArray(declaredCommands)) {
    return { ok: false, reason: `${command} printed a \`commands\` field that is not a list — a gate list that cannot be read is not a gate list` };
  }
  const commands = (declaredCommands || []).map((entry) => ({
    id: entry?.id ? String(entry.id) : null,
    packageScript: entry?.packageScript ? String(entry.packageScript) : null,
    passBaseRef: Boolean(entry?.passBaseRef),
    resourceClass: entry?.resourceClass ? String(entry.resourceClass) : null,
    selectedBy: Array.isArray(entry?.selectedBy) ? entry.selectedBy.map(String) : [],
  }));
  const nameless = commands.filter((entry) => !entry.packageScript);
  if (nameless.length) {
    return {
      ok: false,
      reason: `${command} named ${nameless.length} command gate${nameless.length === 1 ? '' : 's'} with no packageScript — `
        + 'mc cannot run what the selection did not name, and skipping it would be a green over an unchecked contract',
    };
  }

  say(`selection read from ${command}${full ? ' — it fell back to the whole suite' : ''}`
    + (commands.length ? `, with ${commands.length} command gate${commands.length === 1 ? '' : 's'}: ${commands.map((entry) => entry.packageScript).join(', ')}` : ''));
  return { ok: true, files: clean, commands, full, why: parsed?.why ?? null };
}

/**
 * The command gates the selection named, run on the candidate and nowhere else.
 *
 * These are gates about the change rather than measurements of a tree:
 * `css:tokens` and `i18n:contract` take `--base-ref` and are differential in
 * themselves, so the base branch is a ref they are handed rather than a tree
 * anything is run in.
 *
 * Every one of them runs, and a failure does not end the loop. `ci.mjs` wrote
 * the reason down where it makes the same choice about tests: while anything
 * else is red, a skipped command gate hides every contract regression it would
 * have caught. Reported all, judged all.
 *
 * Invoked the way memoro's own `runPackageCommand` invokes them — `npm run
 * <packageScript>`, plus `-- --base-ref <ref>` when the selection said the
 * command takes one — so the gate runs the repository's command rather than an
 * approximation of it.
 */
async function runSelectedCommands({ commands, cwd, env, baseRef, say, timed, clock }) {
  const results = [];
  // The one thing the round's environment must not carry in: node sets
  // NODE_TEST_CONTEXT inside a test run, and a command that inherits it
  // decides it is being required recursively and runs nothing at all — output
  // with no results and exit 0, which is the false green the whole module is
  // built to refuse. Everything else is the environment the round was given,
  // because that is what `runPackageCommand` passes.
  const commandEnv = { ...env };
  delete commandEnv.NODE_TEST_CONTEXT;
  for (const entry of commands) {
    const invocation = `npm run ${entry.packageScript}${entry.passBaseRef ? ` -- --base-ref ${baseRef}` : ''}`;
    say(`command gate ${entry.packageScript}`);
    const from = clock();
    const outcome = await timed('selected gates', async () => shell(invocation, { cwd, env: commandEnv }));
    const duration = clock() - from;
    const ran = outcome.status !== null && outcome.status !== undefined;
    results.push({
      // Which of the two kinds of gate this is. One list, because a reader
      // wants one list; the field is what tells an operator's declaration
      // apart from what the repository's selector chose for this diff.
      source: 'selection',
      name: entry.packageScript,
      command: invocation,
      ok: ran && outcome.status === 0,
      exit_code: outcome.status ?? null,
      ran,
      duration_ms: duration,
      resource_class: entry.resourceClass,
      selected_by: entry.selectedBy,
      // The last thing it said, so a red gate names something. The full
      // output belongs in a log, not in a verdict.
      output: trim(outcome.stderr) || trim(outcome.stdout) || null,
    });
    const last = results[results.length - 1];
    say(`command gate ${entry.packageScript}: ${last.ok ? 'passed' : `FAILED (exit ${last.exit_code})`} in ${seconds(duration)}`);
  }
  return results;
}

/**
 * The files the selection chose, run where the selection was asked for.
 *
 * Held to the suite's rule, and for the same reason — a run that never
 * summarised, or summarised nothing, is a stop rather than an approval. That
 * matters more here than for a full suite: a selected list is short enough that
 * "no tests ran" is an easy accident and an expensive one.
 */
async function measureSelected({ tests, git, cwd, files, flags, say, is }) {
  const at = git(['rev-parse', 'HEAD'], { cwd });
  const commit = at?.status === 0 ? String(at.stdout || '').trim() : null;
  const run = await tests({ cwd, files, flags, onLine: (line) => say(line) });
  const totals = tapTotals(run.tap);
  if (!totals.finished) {
    return { ok: false, reason: 'never reached its own summary — the selected files did not run to the end' };
  }
  if (!totals.tests) return { ok: false, reason: 'reported no tests at all' };
  return {
    ok: true,
    result: { commit, is, exit_code: run.code, totals, red: redNames(run.tap), selected: files.length },
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
 * The branch origin itself calls its default, for a reading with no pull
 * request to name one.
 *
 * Read rather than assumed: `main` is this machine's habit, not a fact about
 * every repository, and `mc test <repo> --full` measuring the wrong branch
 * would be a whole-suite answer about a tree nobody asked about. A remote that
 * does not say gives null, and the round stops rather than guessing.
 */
function defaultBaseRef({ git, repoPath }) {
  const asked = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath });
  const ref = asked?.status === 0 ? trim(asked.stdout) : '';
  return ref || null;
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
  // `candidate` is the only one the round makes now; `baseline` is swept for
  // the rounds that ran before 2026-08-31 and may have left one behind.
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
  // No declared flags and a test script the harvester cannot read is a
  // question the gate cannot answer — and it used to answer it anyway, in
  // silence: memoro's scripts.test became a wrapper (`node
  // scripts/testing/ci.mjs`), nodeTestFlags returned [] without a word,
  // and the round ran bare `node --test` with no loader. Nine files import
  // /js/ specifiers there; every PR touching one got red pr-tests that
  // were the gate's own (measured 2026-08-24: 2 FAIL bare, 30/30 with the
  // loader). Saying so is the ruling: silent-empty is the worst of the
  // three outcomes.
  if (flags.length === 0 && testScriptShape(cwd) === 'wrapper') {
    return {
      ok: false,
      reason: `the repository's test script is not a \`node --test\` line, so the gate cannot know which loaders these tests need — declare pr_tests_flags for this repository in the gate table (an override states every field it wants)`,
      result: { files, totals: null, red: [], exit_code: null },
    };
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
    // Counted by the summary's own `# fail`, never by the number of red
    // names: a failing test reddens its parent suites too, so two failures
    // can carry three names — and "3 of the pull request's own tests" was
    // the gate answering with confidence a question it had miscounted
    // (2026-08-24). The names stay, said as names.
    const failed = totals.fail ?? red.length;
    return { ok: false, reason: `${failed} of the pull request's own tests ${failed === 1 ? 'is' : 'are'} red — the red names, parent suites included: ${red.slice(0, 3).join(', ')}${red.length > 3 ? ', …' : ''}`, result };
  }
  return { ok: true, result };
}

/**
 * What kind of test script this repository has: a `node --test` line the
 * harvester below can read (`node-test`), something else (`wrapper` — a
 * runner like memoro's ci.mjs, whose loaders live where no heuristic
 * looks), or none at all.
 */
function testScriptShape(cwd) {
  let script = '';
  try {
    script = String(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts?.test || '');
  } catch { return 'none'; }
  if (!script) return 'none';
  return /^node\s+(?:.*\s)?--test(?:\s|$)/u.test(script) ? 'node-test' : 'wrapper';
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
 * An extra gate, read off the run.
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
  };
}

/** A few names, and how many were not named. */
function nameSome(names) {
  return `${names.slice(0, 5).join(', ')}${names.length > 5 ? `, … and ${names.length - 5} more` : ''}`;
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
