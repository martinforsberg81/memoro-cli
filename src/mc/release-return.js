import { readFileSync } from 'node:fs';

import { ghCommand } from './commands/publish.js';
import { run as mergeRun } from './commands/merge.js';
import { openBranchPr } from './deploy-branch.js';
import { readRelease, releaseHolder, releaseShippedLines, sameRelease, writeRelease } from './deploy-release.js';
import { recordEnd, withDeploysLock } from './deploys.js';
import { tryGit } from './git.js';
import { mergesPath, parseQueue } from './merge-queue.js';
import { queueMerge } from './merger.js';
import { workRoot } from './paths.js';
import { realLock } from './runner-lock.js';

/** Re-read before writing. A late preparation must never overwrite a drop
 * or a newer head. All release writers use the runner/register lock. */
export function changeRelease(record, options, change) {
  const { env = process.env, root = workRoot(env), lock = realLock } = options;
  return withDeploysLock(env, () => {
    const current = readRelease(root);
    if (current?.closed || !sameRelease(record, current) || record.head !== current.head) return null;
    const next = change(current);
    if (next) writeRelease(root, next);
    return next;
  }, { root, lock, strict: true, name: 'release' });
}

function returnDeps(options) {
  const { env = process.env, root = workRoot(env), path } = options;
  return {
    git: options.git || tryGit,
    gh: options.gh || ((args) => ghCommand(args, path)),
    queue: options.queueMerge || ((request) => queueMerge({ env, ...request })),
    pending: options.pendingMerges || ((root) => {
      try { return parseQueue(readFileSync(mergesPath(root), 'utf8')); } catch { return []; }
    }),
    root,
  };
}

/** Persist the PR identity before queueing; the merger will not land an
 * unregistered release PR. Recover an interrupted create by branch/base. */
export function ensureMergeBack(release, options) {
  if (release.merge_landed) return release;
  const { git, gh, queue, pending, root } = returnDeps(options);
  const { path } = options;
  if (git(path, ['fetch', '--quiet', 'origin', 'main']) === null) return release;
  if (!release.merge_back && git(path, ['merge-base', '--is-ancestor', release.head, 'origin/main']) !== null) {
    return changeRelease(release, options, (r) => ({ ...r, merge_landed: true })) || release;
  }
  if (!release.merge_back) {
    let number;
    const found = gh(['pr', 'list', '--state', 'open', '--base', 'main', '--head', release.branch, '--json', 'number']);
    if (!found.ok) return release;
    try { number = JSON.parse(found.stdout)[0]?.number; } catch { return release; }
    if (!number) {
      const made = gh(['pr', 'create', '--base', 'main', '--head', release.branch, '--title', `Merge ${release.branch} back to main`,
        '--body', `Return ${release.branch} to main as a merge commit, preserving ${release.head}.`]);
      number = made.ok ? Number(/\/pull\/(\d+)/u.exec(made.stdout)?.[1]) : null;
    }
    if (!number) return release;
    release = changeRelease(release, options, (r) => ({ ...r, merge_back: number })) || release;
  }
  const pr = release.merge_back;
  const answer = gh(['pr', 'view', String(pr), '--json', 'state,baseRefName,mergeCommit']);
  let facts;
  try { if (answer.ok) facts = JSON.parse(answer.stdout); } catch { /* unknown */ }
  if (facts?.state === 'MERGED' && facts.baseRefName === 'main') {
    const merge = facts.mergeCommit?.oid;
    const parents = merge && git(path, ['log', '-1', '--format=%P', merge]);
    const sides = parents?.split(/\s+/u);
    if (sides?.length === 2 && git(path, ['merge-base', '--is-ancestor', merge, 'origin/main']) !== null &&
        git(path, ['merge-base', '--is-ancestor', release.head, sides[1]]) !== null) {
      return changeRelease(release, options, (r) => ({ ...r, merge_landed: true })) || release;
    }
  } else if (facts?.state === 'OPEN') {
    const job = pending(root).find((item) => item.repo === 'memoro' && Number(item.pr) === pr && !item.back);
    if (!job && !release.merge_queued) {
      queue({ root, repo: 'memoro', repoPath: path, pr, branch: release.branch, holder: { name: releaseHolder(release) } });
      release = changeRelease(release, options, (r) => ({ ...r, merge_queued: true, merge_status: 'queued' })) || release;
    } else if (job?.state && job.state !== release.merge_status) {
      release = changeRelease(release, options, (r) => ({ ...r, merge_status: job.state })) || release;
    }
  }
  return release;
}

/** Open the return PR before completing the deploy row, including recovery
 * after the deployer dies between the provider result and the forge reply. */
export function finishReleaseRow(release, options) {
  if (!release.shipped || release.row_finished || (!release.merge_back && !release.merge_landed)) return release;
  const { key, patch } = release.shipped;
  recordEnd(key, { ...patch, note: releaseShippedLines(release).join('\n') }, options.env);
  return changeRelease(release, options, (r) => ({ ...r, row_finished: true })) || release;
}

export async function settleReleaseReturn(release, options) {
  release = finishReleaseRow(ensureMergeBack(release, options), options);
  if (!release.merge_landed || (release.shipped && !release.row_finished)) return release;
  const { git, gh } = returnDeps(options);
  const { path, env } = options;
  if (release.pin_branch && !release.pin_pr) {
    const pin = await (options.openPin || openBranchPr)({
      worktree: path, branch: release.pin_branch, short: release.head.slice(0, 7), repo: 'memoro', git, gh,
      merge: options.merge || ((argv, deps) => mergeRun(argv, { ...deps, env })), stdout: options.stdout, stderr: options.stderr, recover: true,
    });
    if (!pin.queued) {
      options.stderr?.write(`mc: ${release.pin_branch} is not queued yet — ${pin.error}\n`);
      return release;
    }
    release = changeRelease(release, options, (r) => ({ ...r, pin_pr: pin.number })) || release;
  }
  const ref = `refs/heads/${release.branch}`;
  const remote = git(path, ['ls-remote', '--heads', 'origin', ref]);
  if (remote === null) return release;
  if (remote) {
    const head = remote.split(/\s+/u)[0];
    if (git(path, ['merge-base', '--is-ancestor', head, 'origin/main']) === null ||
        git(path, ['push', '--quiet', `--force-with-lease=${ref}:${head}`, 'origin', `:${ref}`]) === null) return release;
  }
  const closed = changeRelease(release, { ...options, env }, (r) => ({ ...r, closed: r.drop_reason ? 'dropped' : 'merged' }));
  return closed || release;
}
