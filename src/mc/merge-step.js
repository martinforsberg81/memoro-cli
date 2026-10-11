/**
 * What landing does for the step whose pull request it is.
 *
 * Ruling 21 (2026-09-12) made the step session run `mc merge <repo> <pr>`
 * itself, so that a red came back to the session with the diff in context.
 * Ruling 30 (2026-10-09) keeps the session's call and drops the wait: `mc
 * merge` puts the pull request in the merger's queue and the step is
 * `landing`; the session's work is over. The merger writes the answer here.
 * Green is `done`. Red is the step `ready` again with the gate's reason and
 * the pull request kept, so the runner's next session for the step picks up
 * the same branch and the same PR — until `MAX_MERGE_ATTEMPTS`, after which
 * it is `failed` and a person's.
 *
 * The step is found from `MC_STEP=<project>:<index>` in a runner session's
 * environment, and otherwise from the pull request's branch: the register
 * entry whose step stands on that branch, or the project the branch is named
 * after. A pull request that is nobody's step — a planning session's
 * `plan/<programme>`, a hand-made branch — gets the round and nothing else.
 *
 * The door — the plan boundary checked before the queue — is `planBoundary`
 * in merge-boundary.js.
 *
 * Pure over what it is handed; the verb and the merger do the reading.
 */
import { projectForBranch } from './project-prs.js';
import { currentIndex, parseStepEnv } from './register.js';

/** The stops that mean "somebody else is measuring; wait": the gate lock and the repository lease. */
export const WAIT_STOPS = Object.freeze(['busy', 'lease']);

/**
 * The step this pull request is, or null. `entries` is the whole register;
 * `head` is the pull request's branch as GitHub names it.
 */
export function stepForMerge({ env = {}, head = null, entries = [] } = {}) {
  const told = parseStepEnv(env.MC_STEP);
  if (told) {
    const entry = entries.find((item) => item.project === told.project) || null;
    return entry && told.index < entry.steps.length ? { project: told.project, index: told.index, entry, from: 'MC_STEP' } : null;
  }
  if (!head) return null;
  for (const entry of entries) {
    const index = entry.steps.findIndex((step) => step.branch === head && step.status !== 'done');
    if (index >= 0) return { project: entry.project, index, entry, from: 'branch' };
  }
  const project = projectForBranch(head, entries.map((entry) => entry.project));
  const entry = project ? entries.find((item) => item.project === project) : null;
  if (!entry) return null;
  const index = currentIndex(entry);
  return index >= 0 ? { project, index, entry, from: 'project' } : null;
}

/**
 * What a pull request's body says it left undone: the text under a
 * `## Remainder` heading, up to the next heading of that level or higher.
 * Null when there is none, or when it says nothing.
 *
 * A pull request that lands is a `done` step, and memoro #11732 landed three
 * modules of four: the fourth had no step left, and nothing but the pull
 * request's own body said so (2026-09-13). sql-readiness writes the heading
 * by protocol (memoro #11812); any project may.
 */
export function remainderOf(body) {
  const lines = String(body || '').split(/\r?\n/u);
  const start = lines.findIndex((line) => /^#{1,2}\s+remainder\s*$/iu.test(line.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/u.test(line));
  const text = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  if (!text || /^(none|nothing|n\/a|-|—)\.?$/iu.test(text)) return null;
  return text.length > REMAINDER_MAX ? `${text.slice(0, REMAINDER_MAX).trimEnd()} …` : text;
}
const REMAINDER_MAX = 1200;

/**
 * The register patch for a step whose pull request has just landed. A
 * remainder rides in `landed` and as a comment on the step, which is what
 * every reader of a step already shows — so a planning session sees that a
 * `done` step left something without opening the pull request.
 */
export function landedPatch({ pr, report, now, body = null }) {
  const remainder = remainderOf(body);
  return {
    status: 'done',
    pr: Number(pr),
    reason: null,
    landed: { sha: report?.merge_commit || null, into: report?.merged_into || null, at: now, ...(remainder ? { remainder } : {}) },
    ...(remainder ? { comment: `#${Number(pr)} landed with a remainder no step holds yet — ${remainder}` } : {}),
  };
}

/**
 * A red the merger sends back to a session this many times is a person's:
 * three sessions that could not make one pull request green are not going
 * to be helped by a fourth.
 */
export const MAX_MERGE_ATTEMPTS = 3;

/** The register patch for a step whose pull request is in the merger's queue. */
export function landingPatch({ pr, branch = null }) {
  return { status: 'landing', pr: Number(pr), ...(branch ? { branch } : {}) };
}

/**
 * The register patch for a step whose round did not land: the attempt
 * counted, the reason kept, the pull request kept. Below the cap the step is
 * `ready`, and the runner's next session for it is handed the reason and the
 * open pull request (`stepPrompt`'s `retry`); at the cap it is `failed`.
 * A round that cannot say whether it merged (`merge-unknown`) or merged off
 * the default branch is a person's at once: another session cannot find out.
 */
export function redPatch({ step, report }) {
  const attempts = (step?.attempts || 0) + 1;
  const reason = report?.reason || `the round stopped at ${report?.stopped_at || 'unknown'}`;
  const persons = report?.stopped_at === 'merge-unknown' || Boolean(report?.merged && report?.off_default);
  const status = persons || attempts >= MAX_MERGE_ATTEMPTS ? 'failed' : 'ready';
  return {
    status,
    attempts,
    reason: status === 'failed' && !persons ? `${reason} (attempt ${attempts} of ${MAX_MERGE_ATTEMPTS})` : reason,
  };
}

// `file-killed` (a test file ended by a signal from outside the round) must
// stay out of `MEND_STOPS` when mend.js lands (merger-hardening step 6): the
// merger measures it once more, and a second one is answered red as it stands,
// with nothing in the change to mend.

/** The stop is one the merger waits out, not one it answers. */
export function shouldWait(report) {
  return Boolean(report) && !report.ok && WAIT_STOPS.includes(report.stopped_at);
}
