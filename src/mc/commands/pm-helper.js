/** `mc pm-helper` — the helper's workspace: the one door in. See role-singleton.js. */
import { runRoleSingleton } from './role-singleton.js';

export async function run(argv, deps = {}) {
  return runRoleSingleton('pm-helper', argv, deps);
}
