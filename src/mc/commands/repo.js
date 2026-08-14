/**
 * `mc repo` — a repository, seen whole.
 *
 * `mc status` groups by piece of work: what is each conversation doing. This
 * groups by repository, which is the other half of the same picture and the
 * one people were assembling by hand: what main is, which pull requests are
 * open and how far behind main they have drifted, which work areas are
 * standing on it, and whether the installation on this machine is in step.
 *
 *   mc repo status [repo] [--json] [--offline]
 *
 * It reads. The one thing it writes is a `git fetch` — remote-tracking refs
 * and nothing else — and `--offline` removes even that, at the price of
 * saying so on the page rather than quietly showing yesterday's main.
 */
import { renderRepoLines } from '../repo-render.js';
import { repoStatus } from '../repo-status.js';
import { scanArgs } from './flags.js';

const VERBS = ['status'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc repo status [repo] [--json] [--offline]\n');
    return 2;
  }

  const report = await repoStatus({ names: opts.names, offline: opts.offline });

  if (opts.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(`${renderRepoLines(report, {
      columns: stdout.columns || 100,
      colour: Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined,
    }).join('\n')}\n`);
  }

  // A name that matched nothing is the one thing here that is an error: the
  // question was about a particular repository and it was not answered.
  if (report.unknown.length) {
    for (const name of report.unknown) {
      stderr.write(`mc: no repository called "${name}" — mc repo status lists the ones mc can see\n`);
    }
    return 1;
  }
  return 0;
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json', '--offline'] });
  const opts = {
    verb: 'status',
    names: [],
    json: scanned.flags.json,
    offline: scanned.flags.offline,
  };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];
  // Bare `mc repo` is the whole view. Making the verb compulsory would be
  // mc's grammar rather than the user's, and there is only one verb to guess.
  if (VERBS.includes(positional[0])) opts.verb = positional.shift();
  opts.names = positional;
  return opts;
}
