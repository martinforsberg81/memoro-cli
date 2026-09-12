/**
 * What `mc merge` does for the step whose pull request it is landing.
 *
 * Ruling 21 (2026-09-12): the step session runs `mc merge <repo> <pr>` itself.
 * Green is the merge, and the verb then writes `done` into the register and
 * ends the session — there is no further turn for it to take, and its
 * process tree is worth nothing (Martin: *"Processträdet saknar värde och
 * ska bara tas bort"*). Red comes back to the same session as the gate's own
 * lines, with the attempt counted in the register, and the session fixes it
 * with the diff already in its context. Nothing is queued for a merge lane
 * and nothing is repaired by a second session.
 *
 * The step is found from `MC_STEP=<project>:<index>` in a runner session's
 * environment, and otherwise from the pull request's branch: the register
 * entry whose step stands on that branch, or the project the branch is named
 * after. A pull request that is nobody's step — a planning session's
 * `plan/<programme>`, a hand-made branch — gets the round and nothing else.
 *
 * The door — the plan boundary checked before the gate — is `planBoundary`
 * in merge-boundary.js, landed by the runner's own step of this project.
 *
 * Pure over what it is handed; the verb does the reading.
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

/** The register patch for a step whose pull request has just landed. */
export function landedPatch({ pr, report, now }) {
  return {
    status: 'done',
    pr: Number(pr),
    reason: null,
    landed: { sha: report?.merge_commit || null, into: report?.merged_into || null, at: now },
  };
}

/** The register patch for a step whose gate went red: the attempt counted, the reason kept. */
export function redPatch({ step, report }) {
  return {
    attempts: (step?.attempts || 0) + 1,
    reason: report?.reason || `the round stopped at ${report?.stopped_at || 'unknown'}`,
  };
}

/** The stop is one the caller waits out, not one it answers. */
export function shouldWait(report) {
  return Boolean(report) && !report.ok && WAIT_STOPS.includes(report.stopped_at);
}
