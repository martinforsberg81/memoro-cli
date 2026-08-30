/**
 * `mc test <repo> <pr>` — measure a pull request against the branch it is
 * aimed at, and stop there.
 *
 * This is the gate round without the landing. It was reachable before as
 * `mc merge <repo> <pr> --check`, which is a flag on the verb for merging: a
 * name nobody looks under when the question is "is this change red?". Ruled
 * 2026-08-29 that the measurement gets its own verb and that `mc merge` runs
 * the same one — not a second implementation that could drift from it.
 *
 * One measurement, two doors. `mc test` runs `runGate` and reports; `mc merge`
 * runs `runGate` and, if it came back clean, lands the change. There is no
 * path here that merges anything, which `repo-gate.js` asserts against its own
 * source and this file inherits by having no merge code to assert about.
 *
 * What it measures depends on what the repository declares. With a `select`
 * command it is the test files the change reaches, run on both sides; without
 * one it is the whole suite, run on both sides. Either way the verdict is
 * differential — red on the candidate and green on the base — because a red
 * that main already carries is not this change's to answer for.
 */
import { gate, parseMergeArgs } from './repo.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseMergeArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error.replace(/mc merge <repo> <pr>[^\n]*/u, 'mc test <repo> <pr>')}\n`);
    stderr.write(usage());
    return 2;
  }
  // The round never lands anything from here, whatever else was typed.
  return gate({ ...opts, check: true, verb: 'test' }, { stdout, stderr });
}

export function usage() {
  return [
    'usage — mc test <repo> <pr> [<pr>...] [--json]   measure the change; merge nothing\n',
  ].join('');
}
