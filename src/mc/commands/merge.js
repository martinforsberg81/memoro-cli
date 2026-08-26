/**
 * `mc merge <repo> <pr>` — the one door through which a pull request lands.
 *
 * Without a flag it is the gate round that `mc repo merge` used to be
 * (repo.js still owns that code path; only the name moved). `--docs` lands a
 * documentation-only pull request without the suite — see docs-merge.js.
 */
import { docsMergeLines, runDocsMerge } from '../docs-merge.js';
import { recordRound } from '../repo-round-log.js';
import { currentHolder } from '../work-identity.js';
import { gate, parseMergeArgs, resolveRepoPath } from './repo.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseMergeArgs(argv, { docs: true });
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
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

export function usage() {
  return [
    'usage — mc merge <repo> <pr> [<pr>...] [--check] [--json]   the gate round, then squash\n',
    '        mc merge <repo> <pr> --docs [--json]                 docs-only: no suite, squash\n',
  ].join('');
}
