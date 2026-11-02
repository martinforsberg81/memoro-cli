/**
 * `mc prs` — every open pull request in every repository, and whose it is.
 *
 * The page draws a project's pull requests under its row and the merger's in
 * MERGES, and what is left under PULL REQUESTS. This is all of them at once,
 * grouped by owner — a project's step, a plan session, a workarea, a folder
 * elsewhere, or nobody — because with twenty projects in runner sessions and
 * more in a terminal, a pull request nobody is holding is the one that gets
 * lost (Martin, 2026-10-09).
 *
 * It asks GitHub, unlike the bare page: the question is *what is open now*,
 * and the answer refills the page's cache as `mc --fresh` does. `--offline`
 * reads the cache instead. Nothing is closed, merged or moved — it reads.
 */
import { collectPage } from '../page-collect.js';
import { colourFor, columnsFor, renderPrsLines } from '../page-render.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

/** Each subcommand and the scan it is read with; '' is the bare verb, '*' a first word that names something. help-routes.test.js walks the help with it. */
/** `check`: what the scanned arguments may not be — null, or what is wrong; the verb runs it, and help-routes.test.js walks the help with it. */
export const ROUTES = {
  '': { booleans: ['--json', '--offline'], check: ({ positional }) => (positional.length ? `mc prs takes no positional (${positional.join(' ')})` : null) },
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const scanned = scanArgs(argv, ROUTES['']);
  const refused = scanned.error || ROUTES[''].check(scanned);
  if (refused) { stderr.write(`mc: ${refused}\n${usage()}`); return 2; }

  const offline = Boolean(scanned.flags.offline);
  const data = await (deps.collect || collectPage)({ fresh: !offline, offline });
  if (scanned.flags.json) {
    stdout.write(`${JSON.stringify(data.prs, null, 2)}\n`);
    return 0;
  }
  const lines = renderPrsLines(data.prs, { columns: columnsFor(stdout), colour: colourFor(stdout, env) });
  // What could not be asked is said, not swallowed: an empty list from a
  // repository GitHub did not answer for is not *nothing open*.
  for (const note of data.notes || []) {
    if (/gh pr list/u.test(note)) lines.push(`  note: ${note}`);
  }
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export function usage() {
  return commandUsage('prs');
}
