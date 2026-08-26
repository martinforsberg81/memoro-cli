/**
 * Bare `mc status` — the page. See status-collect.js for what it reads;
 * this file only parses two flags and prints.
 */
import { collectStatus, renderStatus } from '../status-collect.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const unknown = argv.find((arg) => !['--json', '--offline'].includes(arg));
  if (unknown) {
    stderr.write(`mc: unknown argument ${unknown}\n`);
    stderr.write('usage — mc status [--json] [--offline] | mc status --sessions | mc status <name>\n');
    return 2;
  }
  const data = await (deps.collect || collectStatus)({ offline: argv.includes('--offline') });
  if (argv.includes('--json')) stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else stdout.write(renderStatus(data));
  return 0;
}
