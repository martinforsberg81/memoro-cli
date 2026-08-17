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
 *  6. give the lease back, whatever happened.
 *
 * There is no merge in here, and not behind a flag either. This module answers
 * one question — is the test gate green — and a module that could also merge
 * would be one `if` away from a round that merged on a verdict it had not
 * finished forming. Merging arrives as its own step, on top of this.
 *
 * It says "the test gate is green", never "the pull request is good". Reading
 * the diff against its contract is judgement, and judgement is not mechanical;
 * a green suite passing an unescalated design decision is exactly the mistake
 * that conflation would license.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { claimLease, releaseLease } from './repo-lease.js';
import { compareRed, redNames, tapTotals } from './tap-red.js';
import { currentHolder } from './work-identity.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';

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
  git = realGit,
  gh = realGh,
  suite = realSuite,
  onProgress = () => {},
  clock = () => Date.now(),
} = {}) {
  const startedAt = clock();
  const say = (message) => { try { onProgress(message); } catch { /* progress is a courtesy */ } };

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
    baseline: null,
    candidate: null,
    broke: [],
    fixed: [],
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

  const lease = claimLease({ repoPath, errand: `gate round for #${pr}`, holder, root });
  if (!lease.ok) {
    const held = lease.lease;
    return finish('lease', `${repoPath} is held by ${held.holder}${held.errand ? ` for “${held.errand}”` : ''}`);
  }
  say(`lease taken by ${holder.name}`);

  const workspace = join(gateRoot(root), repoFileSlug(repoPath));
  const baseDir = join(workspace, 'baseline');
  const headDir = join(workspace, 'candidate');

  try {
    // What the pull request actually is, rather than what the caller believes.
    // A number is all the caller has; the branch, its head, and the branch it
    // is aimed at all come from the forge.
    const facts = prFacts({ gh, repoPath, pr });
    if (!facts.ok) return finish('pr', facts.reason);
    Object.assign(report.pr, facts.pr);
    say(`#${facts.pr.number} — ${facts.pr.head} into ${facts.pr.base}`);

    // Fresh, always. The whole point of the baseline is that it is current,
    // and a stale remote-tracking ref is how a round measures against a main
    // that moved an hour ago.
    const fetched = git(['fetch', 'origin', '--prune'], { cwd: repoPath });
    if (fetched.status !== 0) return finish('fetch', trim(fetched.stderr) || 'git fetch failed');

    clearWorkspace({ git, repoPath, workspace });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });

    // Detached on purpose, both of them. The round must be able to merge the
    // base into the candidate without that ever becoming a commit on somebody's
    // branch: what is measured is a state, not a change to the repository.
    const baseRef = `origin/${facts.pr.base}`;
    const added = git(['worktree', 'add', '--detach', baseDir, baseRef], { cwd: repoPath });
    if (added.status !== 0) return finish('worktree', trim(added.stderr) || `could not check out ${baseRef}`);

    const candidate = git(['worktree', 'add', '--detach', headDir, facts.pr.head_sha], { cwd: repoPath });
    if (candidate.status !== 0) {
      return finish('worktree', trim(candidate.stderr) || `could not check out ${facts.pr.head_sha}`);
    }

    // The candidate is measured *after* merging the current base into it. A PR
    // that is green against the main its author branched from and red against
    // the main it is about to land on is exactly the collision this exists to
    // catch, and it is invisible if the head commit is tested on its own.
    const merged = git(['merge', '--no-edit', baseRef], { cwd: headDir });
    if (merged.status !== 0) {
      return finish('merge', `#${facts.pr.number} conflicts with ${baseRef} — ${trim(merged.stdout) || 'merge failed'}`);
    }
    say(`merged ${baseRef} into the candidate`);

    const commandLine = suiteCommand({ repoPath });
    if (!commandLine.ok) return finish('suite', commandLine.reason);
    report.command = commandLine.command;

    // Sequential, not parallel. Two full suites at once halves the wall clock
    // and loads the machine that both of them are measuring on — and the tests
    // that fail under load are the ones a gate can least afford to guess about.
    // The baseline goes first so a repository that cannot run its own suite is
    // found before the candidate's run is paid for.
    say('running the suite on the baseline — this takes a while');
    const before = await measure({ suite, git, cwd: baseDir, say, side: 'baseline' });
    if (!before.ok) return finish('suite', `the baseline run ${before.reason}`);
    report.baseline = before.result;

    say(`baseline: ${before.result.red.length} red`);
    say('running the suite on the candidate');
    const after = await measure({ suite, git, cwd: headDir, say, side: 'candidate' });
    if (!after.ok) return finish('suite', `the candidate run ${after.reason}`);
    report.candidate = after.result;

    const { broke, fixed } = compareRed(before.result.red, after.result.red);
    report.broke = broke;
    report.fixed = fixed;
    say(`candidate: ${after.result.red.length} red, ${broke.length} of them new`);

    if (broke.length) return finish('red', `${broke.length} test${broke.length === 1 ? '' : 's'} red on the candidate and green on the baseline`);
    return finish(null, null);
  } finally {
    clearWorkspace({ git, repoPath, workspace });
    // Always, and last. A round that died half way through must not leave the
    // repository held by a session that is no longer running.
    releaseLease({ repoPath, holder, root });
    say('lease released');
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
      commit: at?.status === 0 ? String(at.stdout || '').trim() : null,
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

function realGit(args, { cwd } = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function realGh(args, { cwd } = {}) {
  return spawnSync('gh', args, { cwd, encoding: 'utf8' });
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
function realSuite({ cwd, onLine = () => {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['test'], {
      cwd,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --test-reporter=tap`.trim() },
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
