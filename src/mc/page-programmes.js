/** PROGRAMMES' own layout: programme → phase → goal → PR, without lane cells. */
import { mergeFailureSummary } from './merge-red.js';
import { clipCell, prTone, stateTone } from './page-grid.js';
import { activityLines, sessionGoal } from './page-activity.js';
import { width } from './status-render.js';

const finished = (goal) => ['done', 'dropped'].includes(goal.stage);
const one = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const noteworthy = (goal) => goal.running || ['blocked', 'Martin'].includes(goal.status)
  || goal.problems?.length || goal.prs?.length;

function line(c, wide, indent, text, styles = []) {
  const shown = clipCell(text, Math.max(0, wide - indent));
  return `${' '.repeat(indent)}${styles.length ? c(shown, ...styles) : shown}`;
}

function prLine(c, wide, pr) {
  const ref = `${pr.repo || 'unknown'}#${pr.number}`;
  const state = pr.merge_red ? 'red' : pr.merging === 'landing' ? 'landing' : pr.merging === 'queued' ? 'queued' : pr.draft ? 'draft' : 'open';
  const label = state === 'landing' ? 'merging' : state === 'queued' ? 'in queue' : state;
  const prefix = `          ↳ ${c(ref, ...prTone([pr]))} · ${c(label, ...stateTone(state))}  `;
  return `${prefix}${clipCell(pr.title || pr.branch || '', Math.max(0, wide - width(prefix)))}`.trimEnd();
}

function goalLines(lines, c, wide, goal, expand, sessions = []) {
  const isFinished = finished(goal);
  const stage = goal.stage || '—';
  const status = goal.status || '—';
  const tone = status === 'Martin' || status === 'blocked' ? ['red'] : isFinished ? ['grey'] : ['green'];
  const number = String(goal.number ?? '').padStart(3);
  lines.push(line(c, wide, 6, `${number} ${goal.title || goal.name}`, goal.running ? ['bold'] : []));
  const criteria = goal.criteria ? `${goal.criteria.met}/${goal.criteria.all}` : '—';
  const prefix = `          ${c(`stage ${stage}`, 'grey')} · status ${c(status, ...tone)} · `;
  const count = `criteria ${criteria}`;
  // Keep status and criteria whole, even when counts no longer fit one row.
  if (width(prefix) + count.length <= wide) lines.push(`${prefix}${c(count, 'grey')}`);
  else {
    lines.push(prefix.replace(/ · $/u, ''));
    lines.push(line(c, wide, 10, count, ['grey']));
  }
  if (goal.problems?.length) lines.push(line(c, wide, 10, `GOAL.json: ${goal.problems[0]}`, ['red']));
  else if (['blocked', 'Martin'].includes(goal.status)) {
    const reason = goal.question || goal.last?.comment || (goal.status === 'Martin' ? 'waits on Martin' : 'a mend session resolves the obstacle');
    lines.push(line(c, wide, 10, goal.stage === 'merge' && goal.status === 'blocked' ? mergeFailureSummary(reason) : reason, ['red']));
  }
  for (const session of sessions) lines.push(...activityLines(c, wide, session, { expand }));
  for (const pr of goal.prs || []) {
    lines.push(prLine(c, wide, pr));
    if (pr.merge_red) lines.push(line(c, wide, 12, mergeFailureSummary(pr.merge_red), ['red']));
  }
  if (!expand) return;
  const metadata = [goal.name, ...(goal.repos || []), `${goal.sessions ?? 0} sessions`].filter(Boolean).join(' · ');
  lines.push(line(c, wide, 10, metadata, ['grey']));
  const said = isFinished ? goal.last?.done || goal.last?.comment : goal.last?.next || goal.last?.comment;
  if (said && one(said) !== one(goal.question || (['blocked', 'Martin'].includes(goal.status) ? goal.last?.comment : ''))) {
    lines.push(line(c, wide, 10, said, isFinished ? ['grey'] : []));
  }
}

/** Every unfinished phase is explicit; only history is folded by default. */
export function programmeTreeLines(c, wide, group, { expand = false, sessions = [] } = {}) {
  const lines = [];
  const owned = (goal) => sessions.filter((s) => sessionGoal(s) === `${group.programme}/${goal.name}`);
  for (const phase of group.phases || []) {
    if (lines.length) lines.push('');
    const label = phase.number == null ? 'NEEDS ATTENTION' : `Phase ${phase.number}${phase.state === 'waiting' ? ` · after phase ${group.current_phase}` : ''}`;
    lines.push(line(c, wide, 4, label, phase.number == null ? ['red', 'bold'] : ['cyan', 'bold']));
    const visible = phase.goals.filter((goal) => expand || !finished(goal) || noteworthy(goal) || owned(goal).length);
    for (const [index, goal] of visible.entries()) {
      if (index > 0) lines.push('');
      goalLines(lines, c, wide, goal, expand, owned(goal));
    }
    const hidden = phase.goals.length - visible.length;
    if (hidden) lines.push(line(c, wide, 6, `▸ Finished · ${plural(hidden, 'goal')}`, ['grey']));
  }
  if (group.prs?.length) {
    lines.push(line(c, wide, 4, 'PRs without a goal', ['grey']));
    for (const pr of group.prs) {
      lines.push(prLine(c, wide, pr));
      if (pr.merge_red) lines.push(line(c, wide, 12, mergeFailureSummary(pr.merge_red), ['red']));
    }
  }
  return lines;
}
