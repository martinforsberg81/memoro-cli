/** `mc brief` is refused: the interactive manager it was an alias of is gone (D10); `mc manager --headless --prompt` is the manual run. */
import { MANAGER_GONE } from './manager.js';
import { commandUsage } from '../command-help.js';
export { ROUTES } from './manager.js';
export function usage() { return commandUsage('brief'); }
export async function run(_argv, deps = {}) {
  (deps.stderr || process.stderr).write(`${MANAGER_GONE}\n`);
  return 2;
}
