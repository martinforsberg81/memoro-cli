/** Eligibility and durable unsuccessful endings for the decision lane. */
import { join } from 'node:path';
import { itemDirectory } from './desk-items.js';

export function decisionDue(item, now) {
  return item.state === 'for-martin' && item.reversible === true
    && ['product', 'judgement'].includes(item.sort)
    && Number.isFinite(Date.parse(item.due_at)) && Date.parse(item.due_at) <= now.getTime();
}
export function decisionEligible(item, now) {
  return item?.state === 'prepared' || Boolean(item && decisionDue(item, now));
}
export function decisionPrompt(item, { env, goal, now }) {
  const dir = itemDirectory(item, env);
  return `Decide desk item ${item.id}. Item directory: ${dir}. Read prepared.md there first, then mc martin item ${item.id} for the live source and state.\n`
    + (goal ? `Goal: ${item.reference}. Goal directory: ${goal.dir}. Read the goal, its whole LOG.md, worktree state and stage role, and record takeover before acting.\n` : 'No goal identity is assigned; work in the item directory.\n')
    + (decisionDue(item, now)
      ? `This item is DUE: its reversible ${item.sort} brief waited until ${item.due_at}. Read brief.md, carry out its recommendation as if Martin chose it, and close --by default.\n`
      : 'Settle and close --by decision, or write brief.md in Swedish and mark brief --sort product|judgement|reserved --reversible yes|no.\n')
    + 'Keep evidence, gate, review, publish and merge unchanged. Do not launch another decision or Martin session.';
}

export function decisionFailure(item, { reason, at, env, write, writeJson }) {
  item.decision_failures = [...(item.decision_failures || []), { at, reason }];
  if (item.decision_failures.length >= 2) {
    write(join(itemDirectory(item, env), 'brief.md'), `## Vad det gäller\nBeslutspasset kunde inte avgöra ärendet ${item.id}; arbetet kan inte fortsätta automatiskt.\n\n## Alternativ och konsekvenser\n- Undersök underlaget: arbetet kan återupptas när felet är löst.\n- Låt ärendet vänta: arbetet står kvar.\n\n## Rekommendation och skäl\nUndersök underlaget; två beslutssessioner slutade utan att avgöra ärendet.\n\n## Vad som står still\nÄrendet väntar på Martin. Felunderlag:\n${item.decision_failures.map(x => `- ${x.at}: ${x.reason}`).join('\n')}\n\n## Kan valet ändras efteråt?\nIngen automatisk tillämpning; detta är ett mekaniskt fel som kräver undersökning.\n`);
    Object.assign(item, { state: 'for-martin', sort: 'mechanical', reversible: false, due_at: null });
  }
  writeJson(join(itemDirectory(item, env), 'item.json'), item);
}
