/**
 * The main-watch: is the base branch green, and when did it go red?
 *
 * Ordered twice (D-0190, then D-0199) and built neither time. Nothing
 * measured whether main was green — it was discovered as a side effect of
 * some other round happening to measure the baseline. main was red for
 * seven hours of one landing, and red again the next day, found only when
 * the next merge tried to measure against it while two finished deliveries
 * waited (2026-08-24).
 *
 * What matters is the TRANSITION, not the state: main red for six hours and
 * main just-gone-red ask different things of the reader, so the round
 * knocks on the change and stays quiet on the standing fact.
 *
 * Measured per base-SHA, not per interval — main only changes when a
 * landing lands. Each pass:
 *
 *   1. fetch the base; read its commit. Unmoved since last pass → nothing,
 *      main cannot have changed.
 *   2. moved → is this commit already measured green in the gate's baseline
 *      cache (every green merge records it, keyed on commit+lockfile+
 *      command)? Then it is green for free.
 *   3. a cache miss is a landing that did not come through mc's gate — the
 *      way main actually goes red (a github merge, a squash that no longer
 *      matches the tree it was measured on). Measure it: the suite at that
 *      commit, in a detached worktree, under the suite right.
 *   4. compare to the last measurement. Newly red, or more red than before,
 *      knocks PM at once, and names the landings in the interval — the diff
 *      of two measurements is exactly `<last>..<now>`.
 *
 * A measurement it could not take (the suite right is held, the run never
 * summarised) advances nothing: the next pass tries again, and main is not
 * recorded green or red on a run that did not happen.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import { gateRoot, realSuite, suiteCommand } from './repo-gate.js';
import { declarationFor } from './repo-gate-table.js';
import { loadBaseline, lockfileHashAt } from './repo-baseline-cache.js';
import { compareRed, redNames, tapTotals } from './tap-red.js';
import { claimSuiteLease, releaseSuiteLease } from './suite-lease.js';
import { currentHolder } from './work-identity.js';
import { repoFileSlug } from './repo-snapshot.js';
import { readMainState, writeMainState } from './watch-main-store.js';

/** One pass. Everything the pass touches is injectable, so a test runs it in a millisecond. */
export async function mainRound({
  repoPath,
  base = 'origin/main',
  root = mcHome(),
  env = process.env,
  holder = currentHolder(),
  now = new Date(),
  git = null,
  suite = null,
  knock = null,
  log = () => {},
} = {}) {
  const askGit = git || ((args, options = {}) => spawnSync('git', args, { cwd: options.cwd, env, encoding: 'utf8' }));
  const runSuite = suite || ((options) => realSuite({ ...options, env }));
  const say = (message) => { try { log(message); } catch { /* logging is a courtesy */ } };
  const previous = readMainState({ root });

  const fetched = askGit(['-C', repoPath, 'fetch', 'origin', '--prune'], { cwd: repoPath });
  if (fetched.status !== 0) {
    say(`could not fetch ${base}: ${trim(fetched.stderr) || 'git fetch failed'}`);
    return { moved: false, measured: false, reason: 'fetch-failed' };
  }
  const commit = trim(askGit(['-C', repoPath, 'rev-parse', base], { cwd: repoPath }).stdout);
  if (!commit) return { moved: false, measured: false, reason: 'no-base' };

  // main has not moved: it cannot have changed, so there is nothing to measure.
  if (commit === previous.commit) {
    return { moved: false, measured: false, commit, red: previous.red };
  }

  const commandLine = suiteCommand({ repoPath });
  if (!commandLine.ok) {
    say(commandLine.reason);
    return { moved: true, measured: false, commit, reason: 'no-suite' };
  }
  const lockfileHash = lockfileHashAt({ git: (args, o) => askGit(['-C', repoPath, ...args], o || {}), repoPath, commit });

  // Already measured green by the gate on the merge that made it? Free.
  const cached = loadBaseline({ repoPath, commit, lockfileHash, command: commandLine.command, root });
  let red = null;
  let source = null;
  if (cached) {
    red = cached.red;
    source = 'gate-baseline';
    say(`${base} at ${short(commit)} is the gate's last green candidate — ${red.length} red, not rerun`);
  } else {
    const measured = await measureAt({
      repoPath, base, commit, root, env, git: askGit, suite: runSuite, holder, say,
    });
    if (!measured.ok) {
      // Nothing recorded: the next pass tries the same commit again.
      say(`could not measure ${base} at ${short(commit)}: ${measured.reason}`);
      return { moved: true, measured: false, commit, reason: measured.reason };
    }
    red = measured.red;
    source = 'measured';
  }

  const { broke } = compareRed(previous.red || [], red);
  const wasGreen = !previous.commit || (previous.red || []).length === 0;
  const wentRed = (wasGreen && red.length > 0) || broke.length > 0;

  // The landings in the interval — the diff of the two measurements is
  // exactly `<last measured commit>..<now>`. First-parent, so a squash
  // shows as one line and a branch's own history does not flood it.
  let landings = [];
  if (previous.commit) {
    const listed = askGit(['-C', repoPath, 'log', '--first-parent', '--format=%h %s', `${previous.commit}..${commit}`], { cwd: repoPath });
    if (listed.status === 0) landings = String(listed.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  }

  let knocked = null;
  if (wentRed && knock) {
    knocked = await knock(mainKnockText({ base, commit, red, broke, wasGreen, landings }));
    say(`${base} went red at ${short(commit)} — ${red.length} red, ${broke.length} new; PM knocked`);
  } else if (wentRed) {
    say(`${base} went red at ${short(commit)} — ${red.length} red, ${broke.length} new`);
  } else if (red.length > 0) {
    say(`${base} is still red at ${short(commit)} — ${red.length} red, none new; no knock`);
  } else {
    say(`${base} is green at ${short(commit)}`);
  }

  writeMainState({
    commit, red, measured_at: now.toISOString(), source, base,
    last_round: summary({ commit, red, wentRed, source }),
  }, { root, now });

  return { moved: true, measured: true, commit, red, broke, wentRed, source, landings, knock: knocked };
}

/**
 * Measure the suite at a commit, in a detached worktree under the suite
 * right. The same runner the gate uses (`realSuite`) so the two can never
 * disagree about what a run of this suite says; a run that never summarised
 * is not a measurement, exactly as the gate treats it.
 */
async function measureAt({ repoPath, base, commit, root, env, git, suite, holder, say }) {
  const declared = declarationFor(repoPath, { root, env });
  if (!declared.ok) return { ok: false, reason: `no declaration for this repository: ${declared.reason}` };

  const right = claimSuiteLease({ errand: `main-watch: measuring ${base}`, holder, ownerPid: process.pid, root });
  if (!right.ok) return { ok: false, reason: `the suite right is held by ${right.lease.holder}` };
  const ownRight = !right.already;

  const dir = join(gateRoot(root), `${repoFileSlug(repoPath)}-main-watch`);
  try {
    clearWorktree({ git, repoPath, dir });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const added = git(['-C', repoPath, 'worktree', 'add', '--detach', dir, commit], { cwd: repoPath });
    if (added.status !== 0) return { ok: false, reason: trim(added.stderr) || 'could not check out the base' };

    if (declared.declaration.prepare) {
      say(`preparing ${base} at ${short(commit)}: ${declared.declaration.prepare}`);
      const ready = spawnSync(declared.declaration.prepare, { cwd: dir, env, shell: true, encoding: 'utf8' });
      if (ready.status !== 0) return { ok: false, reason: `${declared.declaration.prepare} failed: ${trim(ready.stderr)}` };
    }

    say(`running the suite on ${base} at ${short(commit)} — this takes a while`);
    const run = await suite({ cwd: dir, onLine: (line) => say(`${base}: ${line}`) });
    const totals = tapTotals(run.tap);
    if (!totals.finished) return { ok: false, reason: 'the suite never reached its own summary' };
    if (!totals.tests) return { ok: false, reason: 'the suite reported no tests at all' };
    return { ok: true, red: redNames(run.tap) };
  } finally {
    clearWorktree({ git, repoPath, dir });
    if (ownRight) releaseSuiteLease({ holder, root });
  }
}

function clearWorktree({ git, repoPath, dir }) {
  git(['-C', repoPath, 'worktree', 'remove', '--force', dir], { cwd: repoPath });
  git(['-C', repoPath, 'worktree', 'prune'], { cwd: repoPath });
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

/**
 * What the knock says. The transition, the count, the new names, and the
 * landings in the interval — flat, no ranking, the guard's own voice.
 */
export function mainKnockText({ base, commit, red, broke, wasGreen, landings }) {
  const lines = [];
  lines.push(wasGreen
    ? `${base} WENT RED at ${short(commit)} — ${red.length} red name${red.length === 1 ? '' : 's'}, and it was green before this.`
    : `${base} has ${broke.length} NEW red name${broke.length === 1 ? '' : 's'} at ${short(commit)} (${red.length} red in all).`);
  const names = broke.length ? broke : red;
  for (const name of names.slice(0, 10)) lines.push(`  ${name}`);
  if (names.length > 10) lines.push(`  … and ${names.length - 10} more`);
  if (landings.length) {
    lines.push('');
    lines.push(landings.length === 1
      ? 'The landing since the last green measurement:'
      : `The ${landings.length} landings since the last measurement (newest first):`);
    for (const landing of landings.slice(0, 10)) lines.push(`  ${landing}`);
    if (landings.length > 10) lines.push(`  … and ${landings.length - 10} more`);
  }
  lines.push('');
  lines.push('The watch measured; which of these landings caused it is the review, and it is somebody\'s to do.');
  return lines.join('\n');
}

function summary({ commit, red, wentRed, source }) {
  return `${short(commit)}: ${red.length} red${wentRed ? ' — went red' : ''} (${source})`;
}

function short(commit) {
  return commit ? String(commit).slice(0, 7) : '(none)';
}

function trim(value) {
  return String(value ?? '').trim();
}
