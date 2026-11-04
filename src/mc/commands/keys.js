/** Trusted Node scripts receive the shared dotenv entries in their child environment. */
import { listScriptKeys, runScriptWithKeys, serveWithKeys } from '../keys-run.js';
import { commandUsage } from '../command-help.js';

/** The subcommands; a script's own arguments are its own (help-routes.test.js walks the help with it). */
export const ROUTES = { run: {}, serve: {}, list: {} };

export async function run(argv, deps = {}) {
  const [verb, script, ...args] = argv;
  if (verb === 'run' && script && !script.startsWith('-')) {
    return runScriptWithKeys(script, args, deps);
  }
  if (verb === 'serve' && script && !script.startsWith('-')) return serveWithKeys(script, args, deps);
  if (verb === 'list' && !script) return listScriptKeys(deps);
  (deps.stderr || process.stderr).write(usage());
  return 1;
}

// Everything after the script is the script's argv, including --help.
export function handlesHelp(argv) { return ['run', 'serve'].includes(argv[0]) && argv.length >= 2 && !argv[1].startsWith('-'); }
export function usage() {
  return commandUsage('keys');
}
