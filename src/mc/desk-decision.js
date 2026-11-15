/** Eligibility and durable unsuccessful endings for the decision lane. */
import { join } from 'node:path';
import { itemDirectory, updateDeskItem } from './desk-items.js';
import { recordUnsettled } from './desk-lessons.js';
import { programsHome, workRoot } from './paths.js';
import { turnStatePath } from './programme-turn.js';

/** The decision pass takes prepared items only: no clock brings one, and a for-martin item is Martin's. */
export function decisionEligible(item) {
  return item?.state === 'prepared';
}
/** What a programme item adds: the programme's directory and the planning turn's state file, where its failures are kept. */
function programmeLine(item, env) {
  const programme = item.reference.slice('programme:'.length);
  return `Programme: ${programme}. Programme directory: ${join(programsHome(env), programme)}. The planning turn's failures are in ${turnStatePath(workRoot(env), programme)}; read them and each session log they name. Repair what failed within your reach, then close --by decision so the runner plans the programme again. A text of Martin's that would have to change goes to a brief instead.\n`;
}

export function decisionPrompt(item, { env, goal }) {
  const dir = itemDirectory(item, env);
  return `Decide desk item ${item.id}. Item directory: ${dir}. Read prepared.md there first, then mc martin item ${item.id} for the live source and state.\n`
    + (item.kind === 'programme' ? programmeLine(item, env) : '')
    + (goal ? `Goal: ${item.reference}. Goal directory: ${goal.dir}. Read the goal, its whole LOG.md, worktree state and stage role, and record takeover before acting.\n` : item.kind === 'programme' ? '' : 'No goal identity is assigned; work in the item directory.\n')
    + 'Settle and close --by decision. A remaining change to a text Martin holds is written to brief.md in Swedish, in the form of docs/technical/mc-martin.md (## Vad den säger, ## Vad som föreslås, ## Vad som hittades; no options, no recommendation) and marked brief --sort text --text \'<the text>\' --reversible yes|no; a reserved act is marked brief --sort reserved --reversible yes|no. No clock carries out a brief.\n'
    + 'Keep evidence, gate, review, publish and merge unchanged. Do not launch another decision or Martin session.';
}

/** A decision pass ended on this item unfinished: not closed, and not one that is already Martin's. */
export function decisionUnfinished(item) {
  return Boolean(item) && item.state !== 'closed' && (item.state !== 'for-martin' || decisionEligible(item));
}

/**
 * The pass ended without settling item `id`. The failure, stamped with the state the item is in, is added to
 * the record read under the lock, and only while that record is still `unfinished`. The limit is two entries
 * in the item's current state (an entry without `state` was written while prepared), decided on that record
 * inside the hold. Then `{ item, lessonError }` — the record written — is returned. When the record is missing
 * or was settled meanwhile nothing is written and `item` is null.
 * `brief.md` and the unsettled lesson are written after the hold, only for a record that reached the limit.
 * `lock`, `read` and `writeJson` are the caller's seams for the hold (see `updateDeskItem`).
 */
export function decisionFailure(id, { reason, at, env, write, writeJson, lock, read, unfinished = (item) => decisionUnfinished(item), now = new Date(at) }) {
  let limited = false;
  const { item, written } = updateDeskItem(id, (current) => {
    if (!current || !unfinished(current)) return null;
    const state = current.state;
    current.decision_failures = [...(current.decision_failures || []), { at, reason, state }];
    const inState = current.decision_failures.filter(failure => (failure.state ?? 'prepared') === state).length;
    if (inState >= 2) {
      limited = true;
      Object.assign(current, { state: 'for-martin', sort: 'mechanical', reversible: false, due_at: null });
    }
    return current;
  }, { env, ...(lock ? { lock } : {}), ...(read ? { read } : {}), ...(writeJson ? { write: writeJson } : {}) });
  if (!written) return { item: null, lessonError: null };
  // Giving up is a lesson: what this item needed that the pass did not have. The state above stands whether or not it is written.
  if (!limited) return { item, lessonError: null };
  write(join(itemDirectory(item, env), 'brief.md'), `## Vad det gäller\nBeslutspasset kunde inte avgöra ärendet ${item.id}; arbetet kan inte fortsätta automatiskt.\n\n## Alternativ och konsekvenser\n- Undersök underlaget: arbetet kan återupptas när felet är löst.\n- Låt ärendet vänta: arbetet står kvar.\n\n## Rekommendation och skäl\nUndersök underlaget; två beslutssessioner slutade utan att avgöra ärendet.\n\n## Vad som står still\nÄrendet väntar på Martin. Felunderlag:\n${item.decision_failures.map(x => `- ${x.at}: ${x.reason}`).join('\n')}\n\n## Kan valet ändras efteråt?\nIngen automatisk tillämpning; detta är ett mekaniskt fel som kräver undersökning.\n`);
  try {
    const lesson = recordUnsettled({ env, item, failures: item.decision_failures, now: Number.isFinite(now.getTime()) ? now : new Date() });
    return { item, lessonError: lesson.error ?? null };
  } catch (error) { return { item, lessonError: error.message }; }
}
