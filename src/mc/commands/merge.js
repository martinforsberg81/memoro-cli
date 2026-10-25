/**
 * `mc merge <repo> <pr>` — the one door through which a pull request lands.
 *
 * Without a flag it is the gate round that `mc repo merge` used to be
 * (repo.js still owns that code path; only the name moved). `--docs` lands a
 * documentation-only pull request once the tests that read documents are green — see docs-merge.js — and
 * a pull request GitHub lists as documents only is routed there without the
 * flag, landing in the call instead of queueing.
 *
 * `--admin` is Martin's alone: it lands one pull request past the gate, with
 * GitHub's admin override and no round, and books it (`runAdmin`).
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from '../atomic-write.js';
import { runTool } from '../child-async.js';
import { docsMergeLines, docsOnly, prFiles, runDocsMerge } from '../docs-merge.js';
import { criteriaDoor } from '../merge-boundary.js';
import { dequeue, mergesPath, parseQueue } from '../merge-queue.js';
import { bookBuilt, landedPatch, stepForMerge } from '../merge-step.js';
import { workRoot } from '../paths.js';
import { dropPr } from '../page-cache.js';
import { listEntries, readEntry, realLock, updateStep } from '../register.js';
import { WATCH_TIMEOUT_MIN, followMerge } from '../merge-watch.js';
import { recordRound } from '../repo-round-log.js';
import { currentHolder } from '../work-identity.js';
import { scanArgs } from './flags.js';
import { gate, parseMergeArgs, resolveRepoPath } from './repo.js';
import { repoNameOf } from '../repos.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  // No repository can be called `watch` in `mc repo status`, so the word is free.
  if (argv[0] === 'watch') return runWatch(argv.slice(1), { stdout, stderr, ...deps });
  const opts = parseMergeArgs(argv, { docs: true, watch: true, admin: true });
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  // Before every other door: no criteria, no docs routing, no queue.
  if (opts.admin) return runAdmin(opts, { stdout, stderr, ...deps });
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
    for (const problem of door.problems) stderr.write(`mc: ${door.stop || 'unmet-criteria'} — ${problem}\n`);
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
 * merger leaves it. A review's landing books the steps built under it too
 * (`bookBuilt`). Returns the line to print, or null.
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
    const built = bookBuilt({ root, project: step.project, pr: report.pr.number, report, now: stamp, io, updateStep, readEntry });
    return `${step.project} step ${step.index + 1} is done${builtSaid(built)}`;
  } catch (error) {
    return `the landing is not booked on its step (${error?.message || error}) — mc step done <project> <n> --pr ${report.pr.number}`;
  }
}

/**
 * `mc merge <repo> <pr> --admin` — Martin's landing past the gate. A session
 * runs it only on his word. GitHub's admin override squashes the pull request
 * pinned to the head read here, and no round is formed. A round in flight on
 * it is the merger's to stop: its watch (`watchSubject`, merger.js) answers a
 * `landing` entry within a minute, so this never touches a round itself.
 *
 * Booked as the merger books a landing: the queue entry goes (a `landing` one
 * stays for that watch), the step is `done` with its landing, the page drops
 * the row, and the round log says `admin`.
 */
async function runAdmin(opts, { stdout, stderr, ...deps }) {
  const repoPath = await (deps.resolveRepoPath || resolveRepoPath)(opts.repo);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${opts.repo}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }
  const gh = deps.gh || ((args) => runTool('gh', args, { cwd: repoPath }));
  const number = String(opts.pr);
  const view = ghJson(await gh(['pr', 'view', number, '--json', 'number,title,state,headRefOid,headRefName,baseRefName,body,mergeCommit']));
  if (!view) {
    stderr.write(`mc: gh could not read #${opts.pr}\n`);
    return 1;
  }
  if (view.state !== 'OPEN' && view.state !== 'MERGED') {
    stderr.write(`mc: #${opts.pr} is closed, not merged — nothing to land\n`);
    return 1;
  }
  let sha = view.mergeCommit?.oid || null;
  if (view.state === 'MERGED') {
    stderr.write(`mc: #${opts.pr} was already merged as ${sha7(sha)} — booking it\n`);
  } else {
    // Pinned to the head read above: the squash lands that head and no other.
    if (!view.headRefOid) {
      stderr.write(`mc: gh could not read the head of #${opts.pr} — nothing merged\n`);
      return 1;
    }
    const merged = await gh(['pr', 'merge', number, '--squash', '--admin', '--subject', `${view.title} (#${view.number ?? opts.pr})`, '--match-head-commit', view.headRefOid]);
    const after = ghJson(await gh(['pr', 'view', number, '--json', 'state,mergeCommit']));
    // A read-back that failed is no answer either way: nothing is claimed.
    if (!after) {
      stderr.write(`mc: whether #${opts.pr} merged is UNKNOWN — gh could not read it back; check with gh pr view ${opts.pr}\n`);
      return 1;
    }
    if (after.state !== 'MERGED') {
      const last = String(merged?.stderr || '').trim().split('\n').pop();
      stderr.write(`mc: NOT merged — ${last || `gh could not merge #${opts.pr}`}\n`);
      return 1;
    }
    sha = after.mergeCommit?.oid || null;
  }

  // The queue, under the register's lock, as the merger writes it. The entry
  // is this pull request in this repository; `landing` is the merger's to answer.
  const root = deps.root || workRoot(deps.env || process.env);
  const io = { read: deps.read, write: deps.writeJson, lock: deps.lock };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];
  const queuePath = mergesPath(root);
  const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  const writeQueue = io.write || ((path, value) => writeJsonAtomic(path, value, { mode: 0o644 }));
  let entry = null;
  let queue = 'none';
  (io.lock || realLock)(root, () => {
    const entries = parseQueue((io.read || readText)(queuePath));
    entry = entries.find((item) => item.pr === opts.pr && (item.repo_path === repoPath || item.repo === repoNameOf(repoPath))) || null;
    if (!entry) return;
    if (entry.state === 'landing') { queue = 'landing'; return; }
    writeQueue(queuePath, dequeue(entries, { repo: entry.repo, pr: opts.pr }));
    queue = 'removed';
  });

  // The step, unless the merger has the entry: the entry's own, else the one
  // the pull request's branch stands on. Done or blocked is left as it is.
  let booked = null;
  let built = [];
  if (queue !== 'landing') {
    try {
      const step = entry?.step || stepForMerge({ env: deps.env || process.env, head: view.headRefName, entries: listEntries(root, io) });
      const standing = step ? readEntry(root, step.project, io)?.steps?.[step.index] : null;
      if (standing && standing.status !== 'done' && standing.status !== 'blocked') {
        const stamp = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
        updateStep({ root, project: step.project, index: step.index, patch: landedPatch({ pr: opts.pr, report: { merge_commit: sha, merged_into: view.baseRefName }, now: stamp, body: view.body }), now: stamp, ...io });
        built = bookBuilt({ root, project: step.project, pr: opts.pr, report: { merge_commit: sha, merged_into: view.baseRefName }, now: stamp, io, updateStep, readEntry });
        booked = step;
      }
    } catch (error) {
      // The merge stands; only its booking failed, and the line says how to book it by hand.
      stderr.write(`mc: the landing is not booked on its step (${error?.message || error}) — mc step done <project> <n> --pr ${opts.pr}\n`);
    }
  }

  // The page drops the row at once; a page that cannot be written costs nothing.
  try { dropPr({ root, repo: repoNameOf(repoPath), number: opts.pr }); } catch { /* the page catches up on its own */ }

  const now = deps.now ? deps.now() : new Date();
  recordRound({ repo: repoPath, pr: { number: opts.pr }, ok: true, merged: true, merge_commit: sha, stopped_at: null, reason: null, holder: currentHolder(), started_at: now.toISOString() }, { mode: 'admin' });

  const step = booked ? { project: booked.project, index: booked.index } : null;
  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: true, merged: true, merge_commit: sha, merged_into: view.baseRefName, step, queue }, null, 2)}\n`);
    return 0;
  }
  stdout.write(`mc: merged #${opts.pr} into ${view.baseRefName} as ${sha7(sha)} (squash, --admin: no gate round)\n`);
  if (booked) stdout.write(`mc: ${booked.project} step ${booked.index + 1} is done${builtSaid(built)}\n`);
  if (queue === 'landing') stdout.write(`mc: #${opts.pr} is landing in the merger's queue — the merger's round for it stops within a minute and books it\n`);
  return 0;
}

/** The JSON of a `gh` answer that succeeded, or null: an answer that failed is no answer. */
function ghJson(answer) {
  if (!answer || answer.status !== 0) return null;
  try { return JSON.parse(answer.stdout); } catch { return null; }
}

/** The short commit a line names, or nothing when there is none. */
const sha7 = (sha) => String(sha || '').slice(0, 7);

/** The clause that says which built steps a review's landing booked done with it, or nothing. */
const builtSaid = (built) => (built.length ? `; steps ${built.map((index) => index + 1).join(', ')} were built on its branch — done with it` : '');

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
    '        mc merge <repo> <pr> --admin [--json]                Martin\'s: squash with GitHub\'s admin override, no gate round, booked as landed\n',
    '        mc merge watch <repo> <pr> [--timeout <min>] [--json]   follow a queued pull request until it lands or goes red\n',
  ].join('');
}
