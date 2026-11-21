import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import { cutFromOrder } from './goal-parts.js';
import { GOAL_FILE, GOALS_DIR, listDirsOf, parseGoal, readTextOrNull } from './goals.js';
import { workRoot } from './paths.js';
import { changeProgrammeRecord, normalized, PHASES_ORDER, readRecord } from './programme-record.js';
import { partsOrder, splitProgrammeParts } from './programme-turn.js';
import { readRepairCut, repairGoalContract } from './repair-cut.js';
import { repairArtifactNames, repairDigest, repairSnapshot } from './repair-manifest.js';
import { deskRepairDraft, isDesk, repairReleaseState } from './repair-release.js';

const refused = problem => ({ problems: [problem] });

/** The reason the runner's cut records with a reconciliation: no reader compared anything, the goals are the parts. */
export const CUT_REASON = 'cut by code: one goal per released part';
/** What the runner writes into a goal it returns to build before a release is reconciled (`reconciledRecord`). */
export const PART_CHANGED = 'its released part changed';

/**
 * The record change of the runner's cut of a released repair order (mc-run.md, "The cut of a ready order"): the
 * release is recorded as reconciled with the goals `cutParts` left, and the order its parts give is written into
 * `phases.after` in the same write. `current` is the release and the snapshot the goals were cut from, as
 * `programmeDue` read them. The caller holds the runner lock, so none is taken here. `toBuild({ name, dir })` returns
 * a goal to build with the runner's log entry and gives null, or the problem that kept it. A programme whose goals
 * are all of the old form keeps the dependencies its record states.
 */
export function reconcileRepair({ dir, current, root, toBuild, list = listDirsOf, read = readTextOrNull, write }) {
  const programme = basename(dir);
  return changeProgrammeRecord(dir, record => {
    if (record.state !== 'ready' || record.repair?.release?.revision !== current.release.revision) return refused(`${programme} is not ready at the release that was cut`);
    const reconciled = reconciledRecord({ record, current, dir, reason: CUT_REASON, list, read, toBuild });
    if (reconciled.problems || !readRepairCut(dir, { list, read }).rows.some(({ goal }) => cutFromOrder(goal))) return reconciled;
    return normalized({ ...reconciled, phases: { order: PHASES_ORDER, after: partsOrder(current.snapshot.text).after } });
  }, { root, lock: (_root, fn) => fn(), read, ...(write ? { write } : {}) }, 'repair-reconcile');
}

/**
 * The normal desk state command is the authorising word for a takeover.
 * Check and bind its whole cut under the same lock; the runner never plans
 * unfinished reconciliation on behalf of the desk.
 */
export function setDeskRepairState(dir, target, env, { list = listDirsOf, read = readTextOrNull, lock } = {}) {
  const programme = basename(dir);
  return changeProgrammeRecord(dir, record => {
    if (!isDesk(env) || !record.repair?.desk || record.repair.stop_item) return refused('only interactive Martin may set a taken-over order ready');
    if (target === 'draft' && ['draft', 'ready'].includes(record.state)) return { ...record, state: 'draft' };
    if (target !== 'ready' || !deskRepairDraft(env, record)) {
      if (target === 'ready' && record.state === 'ready' && repairReleaseState(dir, record)?.release) return record;
      return refused('set the taken-over order to draft before changing its release');
    }
    const snapshot = repairSnapshot(dir);
    const { takeover_cut: unreconciled, ...repair } = record.repair;
    const release = { revision: randomUUID(), manifest: snapshot.manifest, ...(unreconciled ? { unreconciled } : {}) };
    const current = { release, snapshot };
    return reconciledRecord({ record: { ...record, state: 'ready', repair: { ...repair, release } },
      current, dir, reason: repair.disposition.reason, list, read });
  }, { root: workRoot(env), lock, read }, 'repair-desk-state');
}

function partContracts({ text, manifest }) {
  const { parts, shared, sharedContract } = splitProgrammeParts(text);
  const common = new Set(repairArtifactNames(shared));
  const artifacts = manifest.inputs.slice(1);
  return parts.map(([number, section]) => {
    const local = new Set(repairArtifactNames(section));
    const inputs = artifacts.filter(([path]) => common.has(path) || local.has(path));
    return [number, repairDigest(JSON.stringify([sharedContract, section, inputs]))];
  });
}

/**
 * The record with `current`'s release reconciled, or the refusal. A goal cut from the order (`cutFromOrder`) holds no
 * text and its sessions read the released snapshot, so it differs from an authored goal: the documentation goal names
 * no part and is accepted; a changed part or an earlier cut that never reconciled asks no contract change of it; one
 * whose part has left the release is left out, so nothing of it is admitted, and the desk drops it; and one in review
 * or merge whose part changed is returned to build (`toBuild`), after every other check, or refused where no caller
 * can do that.
 */
function reconciledRecord({ record, current, dir, reason, list, read, toBuild }) {
  const revision = current.release.revision;
  const prior = record.repair.reconciled;
  if (prior?.revision === revision) return record;
  if (typeof reason !== 'string' || !reason.trim()) return refused('reconciliation needs the comparison against the released parts');
  const parts = partContracts(current.snapshot);
  const nextParts = new Map(parts);
  if (!parts.length || parts.length !== nextParts.size) return refused('the released order must have uniquely numbered parts');
  const previousParts = new Map(prior?.parts);
  const previousGoals = new Map(prior?.goals?.map(([name, digest, named]) => [name, { digest, named }]));
  const goalsDir = join(dir, GOALS_DIR);
  const cut = readRepairCut(dir, { list, read });
  if (cut.problems) return cut;
  const unreconciled = new Map(current.release.unreconciled);
  const goals = [];
  const covered = new Set();
  const returning = [];
  for (const { name, dir: goalDir, named, goal } of cut.rows) {
    if (goal.stage === 'dropped') continue;
    const landed = goal.stage === 'done';
    const previous = previousGoals.get(name);
    const selected = landed && previous ? previous.named : [...named];
    const fromOrder = !landed && cutFromOrder(goal);
    if (fromOrder && selected.some(number => !nextParts.has(number))) continue;
    if (!fromOrder && !landed && previous?.named.some(number => !nextParts.has(number))) return refused(`${name}: retire unfinished work for its removed part`);
    if (!fromOrder && !landed && (!selected.length || selected.some(number => !nextParts.has(number)))) {
      return refused(`${name}: retire unfinished work for a removed part or name its current parts through mc goal`);
    }
    if (!landed && goalDir !== join(goalsDir, name)) return refused(`${name}: unfinished goal is archived`);
    const contract = repairGoalContract(goal);
    const matching = number => nextParts.has(number) && previousParts.get(number) === nextParts.get(number);
    const changed = Boolean(previous && (!selected.every(matching) || !previous.named.every(number => selected.includes(number))));
    const staleContract = unreconciled.get(name);
    const back = fromOrder && selected.length > 0 && ['review', 'merge'].includes(goal.stage) && !(previous && selected.every(matching));
    if (back) returning.push({ name, dir: goalDir });
    if (!fromOrder && !landed && (staleContract || changed) && (contract === staleContract || contract === previous?.digest
        || !['draft', 'build'].includes(goal.stage) || goal.success_criteria.some(item => item.met))) {
      const why = staleContract ? 'the earlier cut never reconciled' : 'the released part changed';
      return refused(`${name}: ${why} — update its contract, take back its criterion marks and return it to draft or build before reconciliation`);
    }
    if (!back && !landed && !previous && !['draft', 'build'].includes(goal.stage)) return refused(`${name}: return unversioned work to draft or build before reconciliation`);
    if (!back && !landed && goal.stage === 'merge') return refused(`${name}: return the old merge handoff to build before reconciling this release`);
    for (const number of selected) if (!landed || !prior || (previous && matching(number))) covered.add(number);
    goals.push([name, contract, landed ? selected.filter(number => !prior || (previous && matching(number))) : selected]);
  }
  const missing = parts.map(([number]) => number).filter(number => !covered.has(number));
  if (missing.length) return refused(`no current goal covers released part(s) ${missing.join(', ')}`);
  if (new Set(goals.map(([name]) => name)).size !== goals.length) return refused('a goal name exists more than once');
  for (const one of returning) {
    const kept = toBuild ? toBuild(one) : 'return it to build before reconciliation';
    if (kept) return refused(`${one.name}: ${PART_CHANGED} — ${kept}`);
  }
  return { ...record, repair: { ...record.repair, reconciled: { revision, reason: reason.trim(), parts, goals } } };
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
    if (goal.problems || !accepted.goals.some(([known, digest]) => known === name && digest === repairGoalContract(goal))) {
      return refused(`${name} is not reconciled for this repair release`);
    }
  }
  return current;
}
