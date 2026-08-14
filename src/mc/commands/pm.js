/** `mc pm` — the PM's workspace: the one door in. See role-singleton.js. */
import { runRoleSingleton } from './role-singleton.js';

export async function run(argv, deps = {}) {
  return runRoleSingleton('pm', argv, deps);
}
