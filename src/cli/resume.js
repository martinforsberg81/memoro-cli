import { run as runOpen } from './open.js';

export async function run(argv, deps = {}) {
  return runOpen(argv, deps);
}
