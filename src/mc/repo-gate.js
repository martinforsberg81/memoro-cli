/**
 * The gate round, as a machine.
 *
 * The rule it enforces is not new: a pull request may not make the suite red
 * anywhere main was green, and that has to be measured against a main that
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
 *  6. give the lease back, whatever happened.
 *
 * There is no merge in here, and not behind a flag either. This module answers
 * one question — did anything go red that was green — and a module that merged
 * too would be one `if` away from a round that merged on a verdict it had not
 * finished forming. Merging lives in `repo-merge.js`, which runs this and acts
 * on the report; keeping it out of here is load-bearing rather than tidy, and
 * a test asserts against this file's source that it stays out.
 *
 * It says "the test gate passes", never "the pull request is good". Reading
 * the diff against its contract is judgement, and judgement is not mechanical;
 * a passing suite waving through an unescalated design decision is exactly the
 * mistake that conflation would license.
 *
 * And it will not say "green" over a baseline that is red. The verdict is
 * `green` only when nothing was red on either side; otherwise it is
 * `no-new-red` and carries the standing count, because that word is what
 * somebody quotes when they decide to merge. The red already standing is
 * `red-ratchet.js`'s subject: it may go down and it may not go up.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { claimLease, releaseLease } from './repo-lease.js';
import { compareRed, redNames, tapTotals } from './tap-red.js';
import { currentHolder } from './work-identity.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';
import { declarationFor } from './repo-gate-table.js';
import { compareRatchet, readRatchet } from './red-ratchet.js';

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
  holder = currentHolder(),
  root = mcHome(),
  env = process.env,
  git = null,
  gh = null,
  suite = null,
  onProgress = () => {},
  clock = () => Date.now(),
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

  const report = {
    schema: GATE_SCHEMA,
    version: GATE_VERSION,
    repo: repoPath,
    pr: { number: Number(pr), head: null, base: null, head_sha: null, title: null },
    holder: holder.name,
    ok: false,
    merged: false,
    stopped_at: null,
    reason: null,
    command: null,
    declaration: null,
    extra_gates: [],
    baseline: null,
    candidate: null,
    broke: [],
    fixed: [],
    // `green` only when the baseline had nothing red. Anything else is
    // `no-new-red`, which is a different statement and has to read as one:
    // the word green over 55 standing red names is what this field exists to
    // stop the round from saying.
    verdict: null,
    standing_red: null,
    ratchet: null,
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

  if (holdLease) {
    const lease = claimLease({ repoPath, errand: `gate round for #${pr}`, holder, root });
    if (!lease.ok) {
      const held = lease.lease;
      return finish('lease', `${repoPath} is held by ${held.holder}${held.errand ? ` for “${held.errand}”` : ''}`);
    }
    say(`lease taken by ${holder.name}`);
  }

  // What this repository needs, read before any work is done. A round that
  // cannot know whether the suite will be complete is a round whose green
  // means nothing, so it stops here rather than after two suite runs.
  const declared = declarationFor(repoPath, { root, env });
  if (!declared.ok) {
    if (holdLease) releaseLease({ repoPath, holder, root });
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
    const facts = prFacts({ gh: askGh, repoPath, pr });
    if (!facts.ok) return finish('pr', facts.reason);
    Object.assign(report.pr, facts.pr);
    say(`#${facts.pr.number} — ${facts.pr.head} into ${facts.pr.base}`);

    // Fresh, always. The whole point of the baseline is that it is current,
    // and a stale remote-tracking ref is how a round measures against a main
    // that moved an hour ago.
    const fetched = askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
    if (fetched.status !== 0) return finish('fetch', trim(fetched.stderr) || 'git fetch failed');

    clearWorkspace({ git: askGit, repoPath, workspace });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });

    // Detached on purpose, both of them. The round must be able to merge the
    // base into the candidate without that ever becoming a commit on somebody's
    // branch: what is measured is a state, not a change to the repository.
    const baseRef = `origin/${facts.pr.base}`;
    const added = askGit(['worktree', 'add', '--detach', baseDir, baseRef], { cwd: repoPath });
    if (added.status !== 0) return finish('worktree', trim(added.stderr) || `could not check out ${baseRef}`);

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

    const commandLine = suiteCommand({ repoPath });
    if (!commandLine.ok) return finish('suite', commandLine.reason);
    report.command = commandLine.command;

    // Whatever this repository needs before its suite can be believed, run in
    // both worktrees. A prepare that fails stops the round: a suite run on a
    // tree that was not prepared is exactly the incomplete run the declaration
    // exists to prevent.
    if (declared.declaration.prepare) {
      for (const [side, dir] of [['baseline', baseDir], ['candidate', headDir]]) {
        say(`preparing the ${side}: ${declared.declaration.prepare}`);
        const ready = shell(declared.declaration.prepare, { cwd: dir, env });
        if (ready.status !== 0) {
          return finish('prepare', `${declared.declaration.prepare} failed in the ${side} — ${trim(ready.stderr)}`);
        }
      }
    }

    // Sequential, not parallel. Two full suites at once halves the wall clock
    // and loads the machine that both of them are measuring on — and the tests
    // that fail under load are the ones a gate can least afford to guess about.
    // The baseline goes first so a repository that cannot run its own suite is
    // found before the candidate's run is paid for.
    say('running the suite on the baseline — this takes a while');
    const before = await measure({ suite: runSuite, git: askGit, cwd: baseDir, say, side: 'baseline' });
    if (!before.ok) return finish('suite', `the baseline run ${before.reason}`);
    report.baseline = before.result;

    say(`baseline: ${before.result.red.length} red`);
    say('running the suite on the candidate');
    const after = await measure({ suite: runSuite, git: askGit, cwd: headDir, say, side: 'candidate' });
    if (!after.ok) return finish('suite', `the candidate run ${after.reason}`);
    report.candidate = after.result;

    const { broke, fixed } = compareRed(before.result.red, after.result.red);
    report.broke = broke;
    report.fixed = fixed;
    say(`candidate: ${after.result.red.length} red, ${broke.length} of them new`);

    // Standing red is main's, so it is the baseline's count — what this
    // repository is already carrying, independent of the change in front of
    // the gate.
    report.standing_red = before.result.red.length;
    report.verdict = report.standing_red === 0 ? 'green' : 'no-new-red';

    if (broke.length) return finish('red', `${broke.length} test${broke.length === 1 ? '' : 's'} red on the candidate and green on the baseline`);

    // The ratchet, read from the candidate and measured against it: the file
    // describes what main's standing red becomes once this lands, so the one
    // pull request that acknowledges a new red name is able to pass.
    report.ratchet = compareRatchet({
      recorded: readRatchet(headDir),
      measured: after.result.red,
    });
    if (report.ratchet.blocks) {
      return finish('ratchet', report.ratchet.malformed
        ? `${report.ratchet.path} exists and cannot be read: ${report.ratchet.malformed}`
        : `${report.ratchet.rose.length} red name${report.ratchet.rose.length === 1 ? '' : 's'} on ${report.pr.base} that ${report.ratchet.path} does not record`);
    }

    // Gates beyond the suite, on the candidate, under the same rule: one that
    // did not reach its own end is not an approval. A command that could not be
    // run at all is a stop, exactly like a suite that never summarised.
    for (const gate of declared.declaration.extra_gates) {
      say(`extra gate: ${gate.name}`);
      const outcome = shell(gate.command, { cwd: headDir, env });
      const passed = outcome.status === 0;
      report.extra_gates.push({
        name: gate.name,
        command: gate.command,
        ok: passed,
        exit_code: outcome.status ?? null,
        ran: outcome.status !== null && outcome.status !== undefined,
      });
      if (outcome.status === null || outcome.status === undefined) {
        return finish('extra-gate', `${gate.name} could not be run at all — that is not an approval`);
      }
      if (!passed) return finish('extra-gate', `${gate.name} failed on the candidate (${trim(outcome.stderr) || `exit ${outcome.status}`})`);
    }

    return finish(null, null);
  } finally {
    clearWorkspace({ git: askGit, repoPath, workspace });
    // Always, and last. A round that died half way through must not leave the
    // repository held by a session that is no longer running — but a round
    // running inside somebody else's lease gives back nothing, because the
    // holder is still using it.
    if (holdLease) {
      releaseLease({ repoPath, holder, root });
      say('lease released');
    }
  }
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
function shell(command, { cwd, env }) {
  return spawnSync(command, { cwd, env, shell: true, encoding: 'utf8' });
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
