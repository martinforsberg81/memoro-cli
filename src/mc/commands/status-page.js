/**
 * The page — printed today by bare `mc status`, and by bare `mc` once the
 * front door moves (step 4). See page-collect.js for what it reads and
 * page-render.js for how it looks; this file parses two flags and prints.
 *
 * The page is offline: it answers from `~/mc/runner/plans.json` and
 * `~/mc/runner/prs.json` and says how old the PR cache is. `--fresh` is the
 * opt-in that fetches and asks GitHub. `--offline` is still accepted and
 * does nothing — it is what the page does now.
 *
 * `--json` prints the same object the renderer takes, so the two surfaces
 * cannot drift.
 */
import { getPackageVersion } from '../../lib/version.js';
import { collectPage } from '../page-collect.js';
import { colourFor, columnsFor, renderPage } from '../page-render.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const unknown = argv.find((arg) => !['--json', '--fresh', '--offline'].includes(arg));
  if (unknown) {
    stderr.write(`mc: unknown argument ${unknown}\n`);
    stderr.write('usage — mc status [--json] [--fresh] | mc status --sessions | mc status <name>\n');
    return 2;
  }
  const data = await (deps.collect || collectPage)({ fresh: argv.includes('--fresh') });
  if (argv.includes('--json')) {
    stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  stdout.write(renderPage(data, {
    columns: columnsFor(stdout),
    colour: colourFor(stdout, env),
    version: await getPackageVersion().catch(() => ''),
  }));
  return 0;
}
