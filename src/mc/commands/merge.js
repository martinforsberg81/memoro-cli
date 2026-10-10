/**
 * `mc merge <repo> <pr>` — the one door through which a pull request lands.
 *
 * Without a flag it is the gate round that `mc repo merge` used to be
 * (repo.js still owns that code path; only the name moved). `--docs` lands a
 * documentation-only pull request without the suite — see docs-merge.js.
 */
import { docsMergeLines, runDocsMerge } from '../docs-merge.js';
import { WATCH_TIMEOUT_MIN, followMerge } from '../merge-watch.js';
import { recordRound } from '../repo-round-log.js';
import { currentHolder } from '../work-identity.js';
import { scanArgs } from './flags.js';
import { gate, parseMergeArgs, resolveRepoPath } from './repo.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  // No repository can be called `watch` in `mc repo status`, so the word is free.
  if (argv[0] === 'watch') return runWatch(argv.slice(1), { stdout, stderr, ...deps });
  const opts = parseMergeArgs(argv, { docs: true, watch: true });
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  // `--check` was the measurement wearing the merge verb's clothes. It still
  // works, and it says where the measurement lives now: a person asking "is
  // this red?" should not have to find it under the verb for landing things.
  if (opts.check && !opts.docs) stderr.write('mc: --check is now mc test <repo> <pr> — same round, running it\n');
  if (!opts.docs) return gate(opts, { stdout, stderr });

  if (opts.prs) { stderr.write('mc: --docs lands one pull request at a time\n'); return 2; }
  if (opts.check) { stderr.write('mc: --docs has nothing to check — it is the gate or it is documentation\n'); return 2; }
  const repoPath = await (deps.resolveRepoPath || resolveRepoPath)(opts.repo);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${opts.repo}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }
  const report = await (deps.runDocsMerge || runDocsMerge)({ repoPath, pr: opts.pr, gh: deps.gh, onProgress: (m) => stderr.write(`mc: ${m}\n`) });
  report.holder = currentHolder();
  recordRound(report, { mode: 'docs' });
  if (opts.json) { stdout.write(`${JSON.stringify(report, null, 2)}\n`); return report.ok ? 0 : 1; }
  for (const line of docsMergeLines(report)) stdout.write(`${line}\n`);
  return report.ok ? 0 : 1;
}

/** `mc merge watch <repo> <pr> [--timeout <min>] [--json]` — the arguments. */
export function parseWatchArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--timeout'] });
  const opts = { repo: null, pr: null, json: scanned.flags.json, timeoutMs: WATCH_TIMEOUT_MIN * 60_000 };
  if (scanned.error) return { ...opts, error: scanned.error };
  const [repo, number, ...rest] = scanned.positional;
  if (!repo) return { ...opts, error: 'which repository? mc merge watch <repo> <pr>' };
  if (number == null) return { ...opts, error: 'which pull request? mc merge watch <repo> <pr>' };
  if (rest.length) return { ...opts, error: 'mc merge watch follows one pull request — one call per pull request' };
  const pr = String(number).replace(/^#/u, '');
  if (!/^\d+$/u.test(pr)) return { ...opts, error: `"${number}" is not a pull request number` };
  if (scanned.flags.timeout !== null) {
    const minutes = Number(scanned.flags.timeout);
    if (!Number.isFinite(minutes) || minutes <= 0) return { ...opts, error: '--timeout needs a number of minutes' };
    opts.timeoutMs = Math.round(minutes * 60_000);
  }
  return { ...opts, repo, pr: Number(pr) };
}

async function runWatch(argv, { stdout, stderr, ...deps }) {
  const opts = parseWatchArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  const repoPath = await (deps.resolveRepoPath || resolveRepoPath)(opts.repo);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${opts.repo}" — mc repo status lists the ones mc can see\n`);
    return 2;
  }
  return followMerge({ repoPath, pr: opts.pr, timeoutMs: opts.timeoutMs, json: opts.json, stdout, deps });
}

export function usage() {
  return [
    'usage — mc merge <repo> <pr> [<pr>...] [--check] [--json]   the gate round, then squash\n',
    '        mc merge <repo> <pr> --watch [--json]                queue it, then follow it until it lands or goes red\n',
    '        mc merge <repo> <pr> --docs [--json]                 docs-only: no suite, squash\n',
    '        mc merge watch <repo> <pr> [--timeout <min>] [--json]   follow a queued pull request until it lands or goes red\n',
  ].join('');
}
