/** A delivery decision belongs to one reconciled repair release and its PR heads. */
import { basename, dirname, join } from 'node:path';

import { ARCHIVE_DIR, GOAL_FILE, parseGoal, readTextOrNull } from './goals.js';
import { readRecord } from './programme-record.js';
import { repairGoalAdmission } from './repair-reconcile.js';

export const REPAIR_HANDOFF = '.repair-handoff.json';
const refused = problem => ({ problem });

export function repairHandoff(goal, { read = readTextOrNull } = {}) {
  try { return JSON.parse(read(join(goal.dir, REPAIR_HANDOFF)) ?? 'null'); }
  catch { return null; }
}

/** Null means ordinary delivery. Supplying a revision never upgrades an old job. */
export function repairMergeBinding(goal, { read = readTextOrNull, revision } = {}) {
  const parent = dirname(goal.dir);
  const dir = dirname(basename(parent) === ARCHIVE_DIR ? dirname(parent) : parent);
  const found = readRecord(dir, { read });
  if (found.status === 'invalid') return refused(`${goal.programme} has no valid programme record`);
  if (!found.record?.repair) return revision ? refused('repair merge no longer has its programme record') : null;
  const contract = parseGoal(read(join(goal.dir, GOAL_FILE)));
  const admission = repairGoalAdmission(dir, goal.goal, { read, record: found.record, contract, revision });
  if (admission?.problems) return refused(admission.problems[0]);
  const handoff = repairHandoff(goal, { read });
  if (contract.stage !== 'merge' || contract.status !== 'ready' || handoff?.revision !== admission.release.revision || !Array.isArray(handoff.prs)
      || handoff.prs.length !== contract.prs.length
      || contract.prs.some(item => !handoff.prs.some(pr => pr?.repo === item.repo && pr.pr === item.pr && /^[0-9a-f]{40}$/u.test(pr.sha)))) {
    return refused(`${goal.programme}/${goal.goal} has no merge handoff for this repair release`);
  }
  return handoff;
}

/** Check registered ownership and the goal branch, including archived dropped goals. */
export function repairPrBinding({ goals, repo, pr, branch, goal, revision, read }) {
  let binding = null;
  if (goal) {
    const own = repairMergeBinding(goal, { read, revision });
    if (own?.problem) return own;
    if (own) binding = { ...own, goal };
  }
  for (const owner of goals) {
    if (goal && owner.dir === goal.dir) continue;
    if (!owner.prs?.some(item => item.repo === repo && Number(item.pr) === Number(pr))
      && !(owner.repos?.includes(repo) && branch === `goal/${owner.goal}`)) continue;
    const own = repairMergeBinding(owner, { read });
    if (own?.problem) return own;
    if (own && binding) return refused('the pull request is carried by more than one repair goal');
    if (own) binding = { ...own, goal: { dir: owner.dir, programme: owner.programme, goal: owner.goal } };
  }
  if (!binding) return revision ? refused('repair merge has no owning goal') : null;
  if (revision !== undefined && revision !== binding.revision) return refused('the merge job belongs to a different repair release');
  const head = binding.prs.find(item => item.repo === repo && Number(item.pr) === Number(pr));
  return head ? { goal: binding.goal, revision: binding.revision, sha: head.sha }
    : refused('the pull request is not in the repair merge handoff');
}
