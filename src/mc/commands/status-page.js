/**
 * Bare `mc status` — the page. See status-collect.js for what it reads;
 * this file only parses two flags and prints.
 *
 * The page is offline: it answers from `~/mc/runner/plans.json` and
 * `~/mc/runner/prs.json` and says how old the PR cache is. `--fresh` is the
 * opt-in that fetches and asks GitHub. `--offline` is still accepted and
 * does nothing — it is what the page does now.
 */
import { collectStatus, renderStatus } from '../status-collect.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const unknown = argv.find((arg) => !['--json', '--fresh', '--offline'].includes(arg));
  if (unknown) {
    stderr.write(`mc: unknown argument ${unknown}\n`);
    stderr.write('usage — mc status [--json] [--fresh] | mc status --sessions | mc status <name>\n');
    return 2;
  }
  const data = await (deps.collect || collectStatus)({ fresh: argv.includes('--fresh') });
  if (argv.includes('--json')) stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else stdout.write(renderStatus(data));
  return 0;
}
