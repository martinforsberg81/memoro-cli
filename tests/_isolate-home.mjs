/**
 * Test-runner safety net: no suite may ever see the user's real mc home.
 *
 * A bare readRegistry() (or any MC_HOME-defaulting path) that escapes a
 * fixture was a silent no-op for as long as reads never changed anything —
 * until the registry v3 heal-on-read migration ran under a leaked default
 * and rewrote the REAL ~/.memoro/mc/registry.json mid-development. Reads
 * that mutate are legitimate (that is what self-healing means), so the
 * invariant must live here instead: the runner starts with MC_HOME already
 * pointing at a throwaway directory, and a suite that manages its own
 * MC_HOME keeps overriding it exactly as before.
 *
 * Loaded via --import before any test module (see the npm test script).
 */
import { accessSync, appendFileSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REAL_GIT_FILES } from './_real-git-files.mjs';

// Four variables a suite inherits isolated: HOME, TMPDIR, MC_HOME and
// MC_WORK_ROOT. A git identity comes with the home (below), so every commit a
// test makes keeps an identity and no signing key is looked for.
//
// Temporary directories too. Over a hundred suites mkdtemp under tmpdir() and
// none of them removes what it made: ~95 000 mc-* directories had piled up in
// the user's temp dir by 2026-10-23. Each process — the runner and every test
// file it spawns, which inherit the variable — points TMPDIR at a directory
// of its own and removes it on exit, so a suite's leftovers go with it.
// Created first, so the two homes below land inside it as well.
const tmpRoot = mkdtempSync(join(tmpdir(), 'mc-test-tmp-'));
// A gate started by a session runs its tests inside that session's environment.
// The session's identity is not the suite's: the verbs read it from process.env.
for (const name of ['MC_PROGRAMME', 'MC_PROJECT']) delete process.env[name];
process.env.TMPDIR = tmpRoot;
process.once('exit', () => rmSync(tmpRoot, { recursive: true, force: true }));

// HOME too. No suite may read or write the person's real home, and
// `homedir()` answers from HOME: `archiveVerdict` read the real ~/mc through it
// and failed on one machine only (fixed in #1062). The home sits inside
// tmpRoot, so it goes with the run, and carries a git identity so a commit a
// test makes does not depend on the person's ~/.gitconfig.
const homeRoot = mkdtempSync(join(tmpRoot, 'home-'));
process.env.HOME = homeRoot;
writeFileSync(join(homeRoot, '.gitconfig'), [
  '[user]',
  '\tname = mc tests',
  '\temail = mc-tests@example.invalid',
  '[init]',
  '\tdefaultBranch = main',
  '[commit]',
  '\tgpgsign = false',
  '',
].join('\n'));

if (!process.env.MC_HOME) {
  process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-test-isolated-home-'));
}

// Git, counted on the way to zero. Martin, 2026-11-01: "Testerna ska inte göra
// ett enda gitanrop — vi har ju kopia på repot lokalt." Measured the same day
// on origin/main: 64 of 248 test files reach git, 99 % of the suite's measured
// time, and one autonomy test makes ~380 git processes at ≥47 ms each.
//
// So a test file answers git from a repository model (`_fake-git-default.mjs`)
// and starts none; the files that keep real git are named one by one in
// `_real-git-files.mjs`, a list that only shrinks. The runner puts a `git`
// first on PATH that appends `<test file>\t<args>` to its log and runs the real
// git, or answers from the model where a child has one. What a process spawns
// inherits PATH, the log and MC_GIT_TEST, so an `mc` or a script a test starts
// counts against that test's file, and a file off the list that reached git
// ends red. The runner prints the count to stderr on exit; MC_GIT_CALLS_KEEP
// names a file to keep the log in.
const testFile = /\.test\.[cm]?js$/u.test(process.argv[1] || '') ? relative(process.cwd(), process.argv[1]) : null;
if (testFile) process.env.MC_GIT_TEST = testFile;
if (!process.env.MC_GIT_CALLS) {
  const realGit = (process.env.PATH || '').split(delimiter).map((dir) => dir && join(dir, 'git')).find((candidate) => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  });
  if (realGit) {
    const bin = join(tmpRoot, 'bin');
    const log = join(tmpRoot, 'git-calls.tsv');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      // A process outside node's reach — a shell script — asks the model too.
      `[ -n "$MC_FAKE_GIT_STATE" ] && exec '${process.execPath}' '${fileURLToPath(new URL('./_fake-git-cli.mjs', import.meta.url))}' "$@"`,
      `[ -n "$MC_GIT_CALLS" ] && printf '%s\\t%s\\n' "$MC_GIT_TEST" "$*" >> "$MC_GIT_CALLS"`,
      `exec '${realGit.replace(/'/gu, "'\\''")}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(log, '');
    process.env.MC_GIT_CALLS = log;
    process.env.PATH = `${bin}${delimiter}${process.env.PATH || ''}`;
    // Before the handler above that removes tmpRoot, and the log with it.
    process.prependOnceListener('exit', () => {
      let lines = [];
      try { lines = readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { /* nothing called git */ }
      if (!lines.length) return;
      const perFile = new Map();
      for (const line of lines) {
        const file = line.slice(0, line.indexOf('\t')) || '(runner)';
        perFile.set(file, (perFile.get(file) || 0) + 1);
      }
      const top = [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([file, n]) => `  ${String(n).padStart(6)}  ${file}`);
      process.stderr.write(`git calls during tests: ${lines.length} in ${perFile.size} file${perFile.size === 1 ? '' : 's'} — the goal is 0\n${top.join('\n')}\n`);
      if (process.env.MC_GIT_CALLS_KEEP) appendFileSync(process.env.MC_GIT_CALLS_KEEP, `${lines.join('\n')}\n`);
    });
  }
}

if (testFile && !REAL_GIT_FILES.has(testFile)) {
  const { installFakeGitDefault } = await import('./_fake-git-default.mjs');
  installFakeGitDefault();
  // The stop. A file off the list that reached git anyway fails by its own exit
  // code, whatever its tests said: a new git call is a red, not a slower suite.
  process.prependOnceListener('exit', () => {
    let lines = [];
    try { lines = readFileSync(process.env.MC_GIT_CALLS, 'utf8').split('\n').filter((line) => line.startsWith(`${testFile}\t`)); } catch { /* nothing logged */ }
    if (!lines.length) return;
    process.stderr.write(`${testFile} started git ${lines.length} time(s), and tests make no git call: ${lines[0].split('\t')[1]}\n`);
    process.exitCode = 1;
  });
}

// The work root too — the channel lives there. A gate test that ran the real
// "tell the holder" path resolved `pm` against the user's real ~/mc and put
// two CLAIM REFUSED files, with a wake, in PM's actual inbox about a temp
// repository that never existed (2026-08-23). Same invariant, same shape: the
// runner starts with MC_WORK_ROOT pointing at an empty throwaway directory,
// so a send that escapes a fixture finds no area rather than a person.
if (!process.env.MC_WORK_ROOT) {
  process.env.MC_WORK_ROOT = mkdtempSync(join(tmpdir(), 'mc-test-isolated-work-'));
}
