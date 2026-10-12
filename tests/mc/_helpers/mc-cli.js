/**
 * Run the `mc` binary (src/mc-cli.js — the dispatcher the installed `mc`
 * actually is) as a subprocess. The sibling `cli.js` helper spawns
 * bin-mc.js, which routes a different, older command set; the work-world
 * commands live here.
 *
 * Every path a command might read is expected in `env` — MC_HOME,
 * MC_WORK_ROOT, MC_ROLES_DIR, CLAUDE_CONFIG_DIR, CODEX_HOME, PATH — so a
 * test passes identically inside and outside an mc-managed shell.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MC_CLI = join(HERE, '..', '..', '..', 'src', 'mc-cli.js');
const SINGLETON = join(HERE, 'role-singleton-entry.js');

/**
 * A guard against a command that never ends, not a measurement of one that is
 * slow. At 60 s it was a margin load could eat: on 2026-10-12, right after a
 * deploy, one test each in repo-status, repo-watch and work-resume went red in
 * the same round (the selection took 693 s instead of 130 s) and passed alone.
 * A child the guard kills comes back as `status: null` with `signal`
 * SIGTERM and `error.code` ETIMEDOUT, which `repo-fixture.js`'s `json` says.
 */
const HANG_MS = 10 * 60_000;

/**
 * `cwd` matters for the commands that read who is asking from where they are
 * standing — a lease is held by the work area the shell is in, so a test that
 * cannot choose a directory cannot test a second holder at all.
 */
export function runMcCli(args, env = {}, { cwd } = {}) {
  return spawnSync(process.execPath, [MC_CLI, ...args], {
    encoding: 'utf8',
    timeout: HANG_MS,
    cwd,
    env: { ...process.env, MC_TEST_MODE: '1', MEMORO_API_URL: 'http://127.0.0.1:1', ...env },
  });
}

/**
 * The singleton roles, as a subprocess. `mc pm` and `mc pm-helper` are
 * dormant (decision mc-1) and no longer dispatch, so their machinery is
 * driven through its own entry — same env pinning, same shape, one hop
 * closer to the module. Takes the role name first: `['pm', 'new']`.
 */
export function runRoleSingletonCli(args, env = {}, { cwd } = {}) {
  return spawnSync(process.execPath, [SINGLETON, ...args], {
    encoding: 'utf8',
    timeout: HANG_MS,
    cwd,
    env: { ...process.env, MC_TEST_MODE: '1', MEMORO_API_URL: 'http://127.0.0.1:1', ...env },
  });
}
