/**
 * `mc status <name>` — one project. See status-project.js for what it reads;
 * this file parses the two flags and prints.
 */
import { collectProject, renderProject } from '../status-project.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const names = [];
  for (const arg of argv) {
    if (arg === '--json' || arg === '--offline') continue;
    if (arg.startsWith('--')) {
      stderr.write(`mc: unknown argument ${arg}\n`);
      stderr.write('usage — mc status <name> [--json] [--offline]\n');
      return 2;
    }
    names.push(arg);
  }
  if (names.length !== 1) {
    stderr.write('usage — mc status <name> [--json] [--offline]\n');
    return 2;
  }
  const data = await (deps.collect || collectProject)(names[0], { offline: argv.includes('--offline') });
  if (!data) {
    stderr.write(`mc: no project or workarea "${names[0]}" — mc status lists them; mc status --sessions ${names[0]} asks about a pre-V1 session\n`);
    return 1;
  }
  if (argv.includes('--json')) stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else stdout.write(renderProject(data));
  return 0;
}
