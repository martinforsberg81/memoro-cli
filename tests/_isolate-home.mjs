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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
// A gate started by an autonomous session runs its tests inside that session's
// environment. The session's identity is not the suite's: the verbs read it
// from process.env, and a fixture planning a goal would be refused as a step.
for (const name of ['MC_AUTONOMOUS_RUN', 'MC_AUTONOMOUS_ROLE', 'MC_PROGRAMME', 'MC_PROJECT']) delete process.env[name];
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

// The work root too — the channel lives there. A gate test that ran the real
// "tell the holder" path resolved `pm` against the user's real ~/mc and put
// two CLAIM REFUSED files, with a wake, in PM's actual inbox about a temp
// repository that never existed (2026-08-23). Same invariant, same shape: the
// runner starts with MC_WORK_ROOT pointing at an empty throwaway directory,
// so a send that escapes a fixture finds no area rather than a person.
if (!process.env.MC_WORK_ROOT) {
  process.env.MC_WORK_ROOT = mkdtempSync(join(tmpdir(), 'mc-test-isolated-work-'));
}
