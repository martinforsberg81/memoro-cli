/** Script keys are released only through the committed source-closure runner. */
import { listScriptKeys, runScriptWithKeys } from '../keys-run.js';

export async function run(argv, deps = {}) {
  const [verb, script, ...args] = argv;
  if (verb === 'run' && script && !script.startsWith('-')) {
    return runScriptWithKeys(script, args, deps);
  }
  if (verb === 'list' && !script) return listScriptKeys(deps);
  (deps.stderr || process.stderr).write(usage());
  return 1;
}

// Everything after the script is the script's argv, including --help.
export function handlesHelp(argv) { return argv[0] === 'run' && argv.length >= 2 && !argv[1].startsWith('-'); }
export function usage() {
  return 'usage — mc keys run <script> [args…]\n'
    + '        mc keys list\n'
    + '        Uses the repository’s committed .mc-keys.json; never exports plaintext.\n';
}
