import { basename, join } from 'node:path';

import { GOAL_FILE, GOALS_DIR, listDirsOf, parseGoal, readTextOrNull, renderGoal } from './goals.js';
import { workRoot } from './paths.js';
import { changeProgrammeRecord, readRecord } from './programme-record.js';
import { goalParts, partSections } from './programme-turn.js';
import { repairDigest } from './repair-manifest.js';
import { repairReleaseState } from './repair-release.js';

const refused = problem => ({ problems: [problem] });
const contractOf = goal => repairDigest(renderGoal({
  ...goal, stage: 'draft', status: 'ready', phase: 1, prs: [],
  success_criteria: goal.success_criteria.map(item => ({ ...item, met: false })),
}));

export function repairPlanRevision(env, name, revision) {
  return ['plan', 'plan-session'].includes(env.MC_ROLE) && env.MC_HEADLESS === '1' && !env.MC_GOAL
    && env.MC_PROGRAMME === name && env.MC_REPAIR_REVISION === revision;
}

export function reconcileRepair({ home, programme, env, reason, list = listDirsOf, read = readTextOrNull, lock }) {
  const dir = join(home, programme);
  return changeProgrammeRecord(dir, record => {
    const current = repairReleaseState(dir, record);
    if (!current) return refused(`${programme} is not a repair-owned programme`);
    if (!current.release || record.state !== 'ready') return refused(current.problems?.[0] ?? `${programme} is not ready`);
    const revision = current.release.revision;
    if (!repairPlanRevision(env, programme, revision)) return refused('only the programme planner for this release may reconcile it');
    const prior = record.repair.reconciled;
    if (prior?.revision === revision) return record;
    if (typeof reason !== 'string' || !reason.trim()) return refused('reconciliation needs the comparison against the released parts');
    const parts = partSections(current.snapshot.text).map(([number, text]) => [number, repairDigest(text)]);
    const nextParts = new Map(parts);
    if (!parts.length || parts.length !== nextParts.size) return refused('the released order must have uniquely numbered parts');
    const previousParts = new Map(prior?.parts);
    const previousGoals = new Map(prior?.goals?.map(([name, digest, named]) => [name, { digest, named }]));
    const goalsDir = join(dir, GOALS_DIR);
    const readGoals = goalParts({ home, programme, list, read });
    const recorded = new Set(readGoals.map(item => item.dir));
    const unreadable = list(goalsDir).filter(name => !name.startsWith('.') && !recorded.has(join(goalsDir, name)));
    if (unreadable.length) return refused(`goals cannot be read: ${unreadable.join(', ')}`);
    const goals = [];
    const covered = new Set();
    for (const { name, dir: goalDir, named, goal } of readGoals) {
      if (goal.stage === 'dropped') continue;
      const landed = goal.stage === 'done';
      const previous = previousGoals.get(name);
      const selected = landed && previous ? previous.named : [...named];
      if (!landed && previous?.named.some(number => !nextParts.has(number))) return refused(`${name}: retire unfinished work for its removed part`);
      if (!landed && (!selected.length || selected.some(number => !nextParts.has(number)))) {
        return refused(`${name}: retire unfinished work for a removed part or name its current parts through mc goal`);
      }
      if (!landed && goalDir !== join(goalsDir, name)) return refused(`${name}: unfinished goal is archived`);
      const contract = contractOf(goal);
      const matching = number => nextParts.has(number) && previousParts.get(number) === nextParts.get(number);
      const changed = Boolean(previous && (!selected.every(matching) || !previous.named.every(number => selected.includes(number))));
      if (!landed && changed && (contract === previous.digest || !['draft', 'build'].includes(goal.stage) || goal.success_criteria.some(item => item.met))) {
        return refused(`${name}: the released part changed — update its contract, take back its criterion marks and return it to draft or build before reconciliation`);
      }
      if (!landed && !previous && !['draft', 'build'].includes(goal.stage)) return refused(`${name}: return unversioned work to draft or build before reconciliation`);
      for (const number of selected) if (!landed || !prior || (previous && matching(number))) covered.add(number);
      goals.push([name, contract, landed ? selected.filter(number => !prior || (previous && matching(number))) : selected]);
    }
    const missing = parts.map(([number]) => number).filter(number => !covered.has(number));
    if (missing.length) return refused(`no current goal covers released part(s) ${missing.join(', ')}`);
    if (new Set(goals.map(([name]) => name)).size !== goals.length) return refused('a goal name exists more than once');
    return { ...record, repair: { ...record.repair, reconciled: { revision, reason: reason.trim(), parts, goals } } };
  }, { root: workRoot(env), lock, read }, 'repair-reconcile');
}

/** Check delivery admission against both the programme inputs and this goal's accepted contract. */
export function repairGoalAdmission(dir, name, { read = readTextOrNull, record, contract, revision } = {}) {
  if (record === undefined) {
    const found = readRecord(dir, { read });
    if (found.status === 'invalid') return refused(`${basename(dir)} has no valid programme record`);
    record = found.record;
  }
  const current = repairReleaseState(dir, record);
  if (!current || !current.release) return current;
  const accepted = record.repair.reconciled;
  if (revision !== undefined && revision !== current.release.revision) return refused('the session belongs to a different repair release');
  if (record.state !== 'ready' || accepted?.revision !== current.release.revision) return refused(`${basename(dir)} is not reconciled for this repair release`);
  if (name !== null) {
    const goal = contract ?? parseGoal(read(join(dir, GOALS_DIR, name, GOAL_FILE)));
    if (goal.problems || !accepted.goals.some(([known, digest]) => known === name && digest === contractOf(goal))) {
      return refused(`${name} is not reconciled for this repair release`);
    }
  }
  return current;
}
