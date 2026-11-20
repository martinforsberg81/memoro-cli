/** Goal contracts and the evidence retained when an unfinished cut is superseded. */
import { basename, dirname, join } from 'node:path';

import { FINISHED, GOALS_DIR, listDirsOf, readTextOrNull, renderGoal } from './goals.js';
import { goalParts } from './programme-turn.js';
import { repairDigest } from './repair-manifest.js';

export const repairGoalContract = goal => repairDigest(renderGoal({
  ...goal, stage: 'draft', status: 'ready', phase: 1, prs: [],
  success_criteria: goal.success_criteria.map(item => ({ ...item, met: false })),
}));

export function readRepairCut(dir, { list = listDirsOf, read = readTextOrNull } = {}) {
  const rows = goalParts({ home: dirname(dir), programme: basename(dir), list, read });
  const found = new Set(rows.map(row => row.dir));
  const goalsDir = join(dir, GOALS_DIR);
  const unreadable = list(goalsDir).filter(name => !name.startsWith('.') && !found.has(join(goalsDir, name)));
  return unreadable.length ? { problems: [`goals cannot be read: ${unreadable.join(', ')}`] } : { rows };
}

/** Caller holds the programme lock. Only a completed cut can certify that it checked a contract. */
export function interruptedRepairCut(dir, repair, options) {
  if (!repair.release || repair.reconciled?.revision === repair.release.revision) return {};
  const cut = readRepairCut(dir, options);
  if (cut.problems) return cut;
  const accepted = new Map(repair.reconciled?.goals ?? []);
  const unreconciled = cut.rows.filter(({ goal }) => !FINISHED.includes(goal.stage))
    .map(({ name, goal }) => [name, repairGoalContract(goal)])
    .filter(([name, contract]) => accepted.get(name) !== contract);
  return unreconciled.length ? { unreconciled } : {};
}
