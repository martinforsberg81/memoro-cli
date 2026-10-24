/**
 * `mc merge <repo> <pr>` — the one door through which a pull request lands.
 *
 * Without a flag it is the gate round that `mc repo merge` used to be
 * (repo.js still owns that code path; only the name moved). `--docs` lands a
 * documentation-only pull request once the tests that read documents are green — see docs-merge.js — and
 * a pull request GitHub lists as documents only is routed there without the
 * flag, landing in the call instead of queueing.
 */
import { docsMergeLines, docsOnly, prFiles, runDocsMerge } from '../docs-merge.js';
import { criteriaDoor } from '../merge-boundary.js';
import { landedPatch, stepForMerge } from '../merge-step.js';
import { workRoot } from '../paths.js';
import { listEntries, readEntry, updateStep } from '../register.js';
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
  if (!opts.docs && (opts.check || opts.prs)) return (deps.gate || gate)(opts, { stdout, stderr });

  if (opts.prs) { stderr.write('mc: --docs lands one pull request at a time\n'); return 2; }
  if (opts.check) { stderr.write('mc: --docs has nothing to check — it is the gate or it is documentation\n'); return 2; }
  const repoPath = await (deps.resolveRepoPath || resolveRepoPath)(opts.repo);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${opts.repo}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }
  // A pull request whose every file GitHub lists is a document under docs/
  // has no suite to run: its tests that read documents run first, and it lands as --docs would, in this call when they are green. Anything
  // else — gh could not say, one file outside docs/, a script — goes to the
  // merger as before.
  if (!opts.docs) {
    const files = (deps.prFiles || prFiles)(opts.pr, { repoPath, gh: deps.gh });
    if (!docsOnly(files)) return (deps.gate || gate)(opts, { stdout, stderr, resolveRepo: async () => repoPath });
    stderr.write(`mc: #${opts.pr} changes only documents under docs/ (${files.length} file${files.length === 1 ? '' : 's'}, no script) — landing it as mc merge --docs, now, after the tests that read documents\n`);
  }
  // The door `mc merge` has for the plan's last step (`criteriaDoor`), here
  // too: a docs-only close-out is the usual last step. A planning session's
  // pull request is nobody's step, and passes.
  const root = deps.root || workRoot(deps.env || process.env);
  const io = { read: deps.read, write: deps.writeJson, lock: deps.lock };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];
  const door = await (deps.criteriaDoor || criteriaDoor)({ repoPath, pr: opts.pr, gh: deps.gh, git: deps.git, env: deps.env || process.env, entries: listEntries(root, io) });
  if (door.checked && !door.ok) {
    for (const problem of door.problems) stderr.write(`mc: unmet-criteria — ${problem}\n`);
    return 1;
  }
  const report = await (deps.runDocsMerge || runDocsMerge)({ repoPath, pr: opts.pr, gh: deps.gh, measure: deps.measure, onProgress: (m) => stderr.write(`mc: ${m}\n`) });
  // The body is read for the step's remainder, not kept in the round log.
  const { body = null } = report;
  delete report.body;
  report.holder = currentHolder();
  recordRound(report, { mode: 'docs' });
  const booked = report.merged ? bookDocsLanding(report, body, deps) : null;
  if (opts.json) { stdout.write(`${JSON.stringify(report, null, 2)}\n`); return report.ok ? 0 : 1; }
  for (const line of docsMergeLines(report)) stdout.write(`${line}\n`);
  if (booked) stdout.write(`mc: ${booked}\n`);
  return report.ok ? 0 : 1;
}

/**
 * A docs-only pull request that is a step's lands here without the merger,
 * so the verb books it as the merger books a green round: the step is
 * `done` with its pull request. Without this the step stayed `running`, the
 * runner found no open pull request on the branch GitHub had deleted, and
 * wrote the step `failed` (msr-core-finish-measure steps 1 and 3, #13772 and
 * #13784, 2026-10-18). The step is found as the gate's door finds it
 * (`stepForMerge`); a planning session's pull request is nobody's step and
 * books nothing. A step already `done` or `blocked` is left as it is, as the
 * merger leaves it. Returns the line to print, or null.
 */
function bookDocsLanding(report, body, deps) {
  const root = deps.root || workRoot(deps.env || process.env);
  const io = { read: deps.read, write: deps.writeJson, lock: deps.lock };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];
  try {
    const step = stepForMerge({ env: deps.env || process.env, head: report.branch, entries: listEntries(root, io) });
    if (!step) return null;
    const standing = readEntry(root, step.project, io)?.steps?.[step.index];
    if (standing?.status === 'done' || standing?.status === 'blocked') return null;
    const stamp = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    updateStep({ root, project: step.project, index: step.index, patch: landedPatch({ pr: report.pr.number, report, now: stamp, body }), now: stamp, ...io });
    return `${step.project} step ${step.index + 1} is done`;
  } catch (error) {
    return `the landing is not booked on its step (${error?.message || error}) — mc step done <project> <n> --pr ${report.pr.number}`;
  }
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
    '        mc merge <repo> <pr> --docs [--json]                 docs-only: the tests that read documents, then squash, in this call\n',
    '                                                             (a pull request of documents only under docs/ lands this way without --docs)\n',
    '        mc merge watch <repo> <pr> [--timeout <min>] [--json]   follow a queued pull request until it lands or goes red\n',
  ].join('');
}
