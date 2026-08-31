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
 * command it is the test files the change reaches and the command gates the
 * same selection named beside them; without one it is the whole suite. One
 * tree either way, and the verdict is that tree's own red: whether main was
 * already red is not this round's question (ruled 2026-08-31).
 *
 * `mc test <repo> --full` is the other reading, and the only one here that is
 * about the code rather than about a change: the repository's whole suite on
 * the default branch as fetched. It is asked for, never scheduled.
 */
import { gate, parseMergeArgs } from './repo.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseMergeArgs(argv, { full: true });
  if (opts.error) {
    stderr.write(`mc: ${opts.error.replace(/mc merge <repo> <pr>[^\n]*/u, 'mc test <repo> <pr> | --full')}\n`);
    stderr.write(usage());
    return 2;
  }
  // The round never lands anything from here, whatever else was typed.
  return gate({ ...opts, check: true, verb: 'test' }, { stdout, stderr });
}

export function usage() {
  return [
    'usage — mc test <repo> <pr> [<pr>...] [--json]   measure the change; merge nothing\n',
    '        mc test <repo> --full [--json]           the repository\'s whole suite, on the default branch\n',
  ].join('');
}
