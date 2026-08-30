/**
 * `mc status <name>` — one project.
 *
 * Bare `mc status` was the page. The page is `mc` now (decision mc-3): one
 * surface that lists, and none other. So this verb no longer prints a second
 * one — it says where the page went, and answers only when it is given a
 * project to answer about.
 *
 * The old board went with it: `--sessions`, `--watch`, `--wait` and
 * `--timeout` were a second page over the same ground, built on a scan of
 * 1 417 transcripts that cost 7.26 s. `mc status <name>` and `mc work <name>`
 * are what remain. `mc --watch` was the page on a timer and went the same day
 * it arrived, so this sentence names it nowhere: what it points at is what
 * runs.
 */
export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  // A number belongs to the flag before it, so it is not a name.
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      if (/^\d+$/u.test(argv[index + 1] || '')) index += 1;
      continue;
    }
    positional.push(arg);
  }
  // The board's own flags, said by name: a person who types one is asking for
  // the page, and `unknown argument --sessions` would not tell them where it
  // went.
  const board = ['--sessions', '--watch', '--wait', '--timeout'].filter((flag) => argv.includes(flag));
  if (positional.length === 0 || board.length > 0) {
    if (board.length > 0) stderr.write(`mc: ${board.join(', ')} went with the old board\n`);
    stderr.write('mc: mc status is now mc — one page, and it is what mc prints\n');
    stderr.write('    mc                  the page, and at a terminal a way in\n');
    stderr.write('    mc --json           the same page, as one object\n');
    stderr.write('    mc status <name>    one project\n');
    return 2;
  }
  const module = await import('../mc/commands/status-project.js');
  return module.run(argv, deps);
}
