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

const MC_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'mc-cli.js');

export function runMcCli(args, env = {}) {
  return spawnSync(process.execPath, [MC_CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, MC_TEST_MODE: '1', MEMORO_API_URL: 'http://127.0.0.1:1', ...env },
  });
}
