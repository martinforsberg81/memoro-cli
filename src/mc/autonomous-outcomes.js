/** Trusted continuation: review reports are input, not merge commands. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readAutonomousState, recordAutonomousMergeEvent } from './autonomous-state.js';
import { reviewedLanding } from './goal-followup.js';
import { reviewDigest } from './autonomous-review-report.js';
import { autonomousMergeDoor, autonomousPrOwner } from './autonomous-pr.js';
import { mergesPath, parseQueue, queuedFor } from './merge-queue.js';
import { takeClaim, releaseClaim } from './resource-claim.js';

export const reportBinding = report => ({ report_id: report.id, report_digest: reviewDigest(report),
  goal_revision: report.session.assignment.goal_revision,
  head: report.session.head, branch: report.session.branch, pr: report.session.pr });
const ticketBinding = ticket => ({ report_id: ticket.review_id, report_digest: ticket.review_digest,
  goal_revision: ticket.goal_revision,
  head: ticket.head, branch: ticket.branch, pr: ticket.pr });

/** Damaged explicit metadata must not fall into v1 mend/retry ownership. */
export function autonomousJob(root, job) {
  return Object.hasOwn(job, 'autonomous') || !!autonomousPrOwner({ root, repoPath: job.repo_path, pr: job.pr,
    view: { headRefName: job.branch } }).owner;
}

/** Readback after a crash is an observation, not permission to merge again. */
export function autonomousLandingReadback(job, facts) {
  const ticket = job.autonomous;
  if (ticket?.head && facts.base === 'main' && facts.head === ticket.head && /^[a-f0-9]{40}$/u.test(facts.sha || '')) {
    return { ok: true, merged: true, merge_commit: facts.sha, merged_into: 'main', already_merged: true, stopped_at: null, reason: null };
  }
  return { ok: false, merged: false, stopped_at: 'autonomous-landing-unknown',
    reason: 'merged PR readback does not establish the admitted head and main landing' };
}

export function recordMergeOutcome({ root, job, report }) {
  if (!autonomousJob(root, job)) return null;
  const identity = autonomousPrOwner({ root, repoPath: job.repo_path, pr: job.pr, view: { headRefName: job.branch } });
  if (!identity.owner) throw new Error('autonomous outcome ownership is missing or unreadable; retain queue job');
  const owner = identity.owner;
  const state = readAutonomousState(root, owner.programme, owner.project);
  const latest = state.review_reports?.at(-1);
  const fallback = latest ? reportBinding(latest) : { report_id: null, report_digest: null,
    goal_revision: state.goal_revision,
    head: state.publication?.head || null, branch: owner.branch, pr: owner.pr };
  const ticket = job.autonomous;
  const binding = ticket?.review_id && ticket.pr === owner.pr && ticket.branch === owner.branch ? ticketBinding(ticket) : fallback;
  const matched = state.review_reports?.find(item => item.id === binding.report_id);
  const verified = !!matched && isDeepStrictEqual(reportBinding(matched), binding);
  const landed = /^[a-f0-9]{40}$/u.test(report?.merge_commit || '') && report?.ok && report.merged && report.merged_into === 'main' && !report.off_default && report.merge_commit;
  const type = landed && verified ? 'merge-landed' : landed || ['merge-unknown', 'autonomous-landing-unknown'].includes(report?.stopped_at) ? 'merge-unknown' : 'merge-failed';
  const mainFailures = report?.main_red?.red_on_main || report?.gate?.main_red?.red_on_main || [];
  const details = landed ? { merge_commit: report.merge_commit, merged_into: 'main',
    ...(!verified ? { reason: 'landing readback has no matching immutable review evidence' } : {}) }
    : { stopped_at: report?.stopped_at || 'unknown', reason: report?.reason || 'the round said nothing', ...(mainFailures.length ? { main_failures: [...new Set(mainFailures)].sort() } : {}) };
  return recordAutonomousMergeEvent(root, owner.programme, owner.project, { binding, type, details });
}

/** Only a persisted clean, not-yet-answered report has an automatic route.
 * A queued intent with no queue row is a crash gap, not a new build/review. */
export function reviewRoutePending(root, state) {
  const report = state.review_reports?.at(-1);
  if (state.active_run || reviewedLanding(state) || !report?.clean || !['plan_pending', 'landing'].includes(state.phase)
    || report.session.assignment.goal_revision !== state.goal_revision || report.session.head !== state.publication?.head
    || (state.merge_handoff?.status === 'answered' && state.merge_handoff.binding.report_id === report.id)) return false;
  const path = mergesPath(root);
  if (!existsSync(path)) return true;
  // Corruption is not an empty queue and not a reason to enqueue again.
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('merge queue is unreadable');
  return !queuedFor(parseQueue(JSON.stringify(entries)), state.contract.repo, state.ownership.pr);
}

export async function routeAutonomousReview({ root, programme, project, repoPath, env = process.env, gh, git, start }) {
  const path = join(root, 'runner', 'autonomous-routing', programme, `${project}.claim`);
  const claim = takeClaim(path, { pid: process.pid });
  if (!claim.ok) return { queued: false, reason: 'review routing already owned' };
  try {
    const state = readAutonomousState(root, programme, project);
    if (!reviewRoutePending(root, state)) return { queued: false, reason: 'report has no pending automatic route' };
    const report = state.review_reports.at(-1); const binding = reportBinding(report);
    const refuse = reason => {
      recordAutonomousMergeEvent(root, programme, project, { binding, type: 'merge-refused', details: { reason } });
      return { queued: false, reason };
    };
    // An interrupted direct round may have landed before it recorded its answer.
    if (state.phase === 'landing' && gh) {
      const seen = await gh(['pr', 'view', String(binding.pr), '--json', 'state,mergeCommit,baseRefName,headRefOid'], { cwd: repoPath });
      if (seen?.status === 0 || seen?.ok === true) {
        const facts = JSON.parse(seen.stdout);
        if (facts.state === 'MERGED') {
          const job = { repo_path: repoPath, pr: binding.pr, branch: binding.branch, autonomous: state.merge_handoff?.ticket };
          recordMergeOutcome({ root, job, report: autonomousLandingReadback(job,
            { sha: facts.mergeCommit?.oid, base: facts.baseRefName, head: facts.headRefOid }) });
          return { queued: false, reason: 'landing read back for plan' };
        }
      }
    }
    const door = await autonomousMergeDoor({ root, repoPath, pr: binding.pr, env, gh, git });
    if (!door.ok) return refuse(door.problems.join('; '));
    if (!door.autonomous) return refuse('autonomous admission did not establish ownership');
    // Import only at the handoff: the merger also consumes these outcome helpers.
    const { queueMerge } = await import('./merger.js');
    const queued = queueMerge({ root, repo: state.contract.repo, repoPath, pr: binding.pr, branch: binding.branch,
      env, autonomous: door.autonomous, ...(start ? { start } : {}) });
    return { queued: true, ...queued };
  } finally { releaseClaim(path, claim.marker); }
}
