#!/usr/bin/env node
/**
 * memoro-cli entry point.
 * Tiny argv parser → dispatch to command modules.
 */

import { login, logout, status } from './commands/auth.js';
import { configSet, configGet } from './commands/config.js';
import { uploadSession } from './commands/session.js';
import { pullLens } from './commands/lens.js';
import { hookInstall, hookUninstall } from './commands/hook.js';
import { runCodex } from './commands/codex.js';
import { showSection, listSections } from './commands/show.js';
import { showUpdateNoticeIfAvailable, spawnBackgroundUpdateCheck } from './lib/update-check.js';

const HELP = `memoro-cli — bridge your coding tools to Memoro

USAGE
  memoro-cli <command> [args...]

COMMANDS
  login                              Save a Memoro API token (paste when prompted)
  logout                             Remove the stored token
  status                             Show token + last activity

  config set <key> <value>           Set config (e.g. api-url)
  config get <key>                   Read config

  session upload <transcript>        Clean + POST a coding-session transcript
  lens pull [--tool <id>] [--repo <name>]
                                     Fetch portrait-coding lens into tool config
  codex run [-- <codex args...>]     Run Codex with lens pull + post-session upload

  show <section> [--repo <name>]     Print one lens section (loose-ends, decisions,
                                     rules, stack, repos, practices, tool-use)

  hook install [--tool claude-code]  Wire SessionStart + SessionEnd hooks + slash commands
  hook uninstall [--tool claude-code] Remove hooks + slash commands

OPTIONS
  --help, -h                         Show this help
  --version, -v                      Show version
  --api <url>                        Override Memoro base URL (default: https://meetmemoro.app)

See README for details. MIT license.
`;

async function loadPackageVersion() {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(await readFile(join(here, '../package.json'), 'utf8'));
  return pkg.version;
}

async function main(argv) {
  const args = argv.slice(2);

  // Fire the update notice before anything else, so even --help / --version
  // users get nudged. Any failure here is silenced inside the function.
  try {
    const currentVersion = await loadPackageVersion();
    await showUpdateNoticeIfAvailable(currentVersion);
  } catch { /* best effort */ }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(await loadPackageVersion());
    return 0;
  }

  const [cmd, sub, ...rest] = args;

  try {
    switch (cmd) {
      case 'login':    return await login(rest);
      case 'logout':   return await logout(rest);
      case 'status':   return await status(rest);
      case 'config':
        if (sub === 'set') return await configSet(rest);
        if (sub === 'get') return await configGet(rest);
        throw new Error(`Unknown config subcommand: ${sub}`);
      case 'session':
        if (sub === 'upload') return await uploadSession(rest);
        throw new Error(`Unknown session subcommand: ${sub}`);
      case 'lens':
        if (sub === 'pull') return await pullLens(rest);
        throw new Error(`Unknown lens subcommand: ${sub}`);
      case 'codex':
        if (sub === 'run') return await runCodex(rest);
        throw new Error(`Unknown codex subcommand: ${sub}`);
      case 'show':
        // `memoro show <section>` — sub is the section name, not a subcommand
        return await showSection(sub ? [sub, ...rest] : rest);
      case 'hook':
        if (sub === 'install')   return await hookInstall(rest);
        if (sub === 'uninstall') return await hookUninstall(rest);
        throw new Error(`Unknown hook subcommand: ${sub}`);
      default:
        console.error(`Unknown command: ${cmd}`);
        console.error(HELP);
        return 2;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (process.env.MEMORO_CLI_DEBUG) console.error(err.stack);
    return 1;
  }
}

main(process.argv).then(async code => {
  // Kick off the background cache refresh after the command completes.
  // The parent gates on staleness before spawning, so most invocations
  // pay zero extra cost; when it does spawn, the child is detached +
  // unref'd and the parent exits without waiting on it.
  try { await spawnBackgroundUpdateCheck(); } catch { /* silent */ }
  process.exit(code ?? 0);
});
