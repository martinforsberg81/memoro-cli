/** PROGRAMMES' own layout: programme → phase → goal → PR, without lane cells. */
import { mergeFailureSummary } from './merge-red.js';
import { clipCell, prTone, stateTone } from './page-grid.js';
import { activityLines, sessionGoal } from './page-activity.js';
import { width } from './status-render.js';

const finished = (goal) => ['done', 'dropped'].includes(goal.stage);
const one = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
/**
 * Why a finished goal is still under `goals/` and needs a person's eye: the
 * runner's refusal to archive it (`archive_refused`), or an open pull request
 * the archive would refuse it for. Words the line under NEEDS ATTENTION.
 */
function notArchived(goal) {
  if (goal.archive_refused) return `not archived — ${goal.archive_refused}`;
  if (goal.prs?.length) return `not archived — ${goal.prs.map((pr) => `${pr.repo || 'unknown'}#${pr.number}`).join(', ')} ${goal.prs.length === 1 ? 'is' : 'are'} open — land or close ${goal.prs.length === 1 ? 'it' : 'them'} first`;
  return null;
}

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

function goalLines(lines, c, wide, goal, expand, sessions = [], note = null) {
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
  if (goal.hold) lines.push(line(c, wide, 10, `held by ${goal.hold.by ?? '—'} since ${goal.hold.at ?? '—'} — ${goal.hold.reason ?? '—'}`, ['red']));
  if (goal.problems?.length) lines.push(line(c, wide, 10, `GOAL.json: ${goal.problems[0]}`, ['red']));
  else if (note) lines.push(line(c, wide, 10, note, ['red']));
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

/**
 * What follows a phase's number in its heading: a waiting phase of a programme
 * whose phases run in sequence is `after phase <the current one>`; of one whose
 * record states them, `after phase <every phase it is stated to wait for>`
 * (the phase's `after`); an open or finished phase, and any phase of a
 * programme whose record is invalid, says nothing.
 */
function phaseWaits(phase, group) {
  if (phase.state !== 'waiting') return '';
  if (phase.after === undefined) return ` · after phase ${group.current_phase}`;
  return phase.after.length ? ` · after phase ${phase.after.join(', ')}` : '';
}

/**
 * The goals under a programme's NEEDS ATTENTION, in the order the tree draws them: a malformed goal, a finished goal
 * the runner refused to archive and a finished goal with an open pull request (one still at work is not). `sessions`
 * are the runner's.
 */
export function attentionGoals(group, sessions = []) {
  const atWork = (goal) => goal.running || sessions.some((s) => sessionGoal(s) === `${group.programme}/${goal.name}`);
  const needing = [];
  for (const phase of group.phases || []) {
    if (phase.number == null) needing.push(...phase.goals);
    else needing.push(...phase.goals.filter((goal) => finished(goal) && !atWork(goal) && notArchived(goal) !== null));
  }
  return needing;
}

/**
 * The goals of one programme, by phase. The default view draws every unfinished
 * goal and, of the finished ones, only a goal still at work (running, or owning
 * a live session), which stays in its phase until the session ends; `expand`
 * (`a`) draws them all. A phase none of whose goals is drawn is not drawn.
 * Under NEEDS ATTENTION, in both views: a malformed goal, a finished goal the
 * runner refused to archive (`archive_refused`) and a finished goal with an
 * open pull request, each with its line and its pull requests as child rows.
 */
export function programmeTreeLines(c, wide, group, { expand = false, sessions = [] } = {}) {
  const lines = [];
  const owned = (goal) => sessions.filter((s) => sessionGoal(s) === `${group.programme}/${goal.name}`);
  const atWork = (goal) => goal.running || owned(goal).length > 0;
  const attention = (goal) => finished(goal) && !atWork(goal) && notArchived(goal) !== null;
  const needing = attentionGoals(group, sessions);
  for (const phase of group.phases || []) {
    if (phase.number == null) continue;
    const visible = phase.goals.filter((goal) => !attention(goal) && (expand || !finished(goal) || atWork(goal)));
    if (!visible.length) continue;
    if (lines.length) lines.push('');
    lines.push(line(c, wide, 4, `Phase ${phase.number}${phaseWaits(phase, group)}`, ['cyan', 'bold']));
    for (const [index, goal] of visible.entries()) {
      if (index > 0) lines.push('');
      goalLines(lines, c, wide, goal, expand, owned(goal));
    }
  }
  if (needing.length) {
    if (lines.length) lines.push('');
    lines.push(line(c, wide, 4, 'NEEDS ATTENTION', ['red', 'bold']));
    for (const [index, goal] of needing.entries()) {
      if (index > 0) lines.push('');
      goalLines(lines, c, wide, goal, expand, owned(goal), finished(goal) ? notArchived(goal) : null);
    }
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
