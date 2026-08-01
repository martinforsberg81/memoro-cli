import { run as runResume } from './resume.js';

export async function run(argv, deps = {}) {
  return runResume(argv, { ...deps, commandName: 'open' });
}
