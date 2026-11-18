/** PROGRAMMES' own layout: programme → phase → goal → PR, without lane cells. */
import { mergeFailureSummary } from './merge-red.js';
import { prTone, stateTone } from './page-grid.js';
import { activityLines, sessionGoal } from './page-activity.js';
import { width } from './status-render.js';
import { detail } from './page-operations.js';

const finished = (goal) => ['done', 'dropped'].includes(goal.stage);
const one = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
/**
 * Why a finished goal is still under `goals/` and needs a person's eye: the
 * runner's refusal to archive it (`archive_refused`), or an open pull request
 * the archive would refuse it for. Words the line under NEEDS ATTENTION.
 */
export function notArchived(goal) {
  if (goal.archive_refused) return `not archived — ${goal.archive_refused}`;
  if (goal.prs?.length) return `not archived — ${goal.prs.map((pr) => `${pr.repo || 'unknown'}#${pr.number}`).join(', ')} ${goal.prs.length === 1 ? 'is' : 'are'} open — land or close ${goal.prs.length === 1 ? 'it' : 'them'} first`;
  return null;
}

function line(lines, c, wide, indent, text, styles = []) {
  detail(lines, c, wide, indent, text, styles);
}

function prLines(c, wide, pr) {
  const ref = `${pr.repo || 'unknown'}#${pr.number}`;
  const state = pr.merge_red ? 'red' : pr.merging === 'landing' ? 'landing' : pr.merging === 'queued' ? 'queued' : pr.draft ? 'draft' : 'open';
  const label = state === 'landing' ? 'merging' : state === 'queued' ? 'in queue' : state;
  const prefix = `          ↳ ${c(ref, ...prTone([pr]))} · ${c(label, ...stateTone(state))}  `;
  const title = pr.title || pr.branch || '';
  if (width(prefix) + width(title) <= wide) return [`${prefix}${title}`.trimEnd()];
  const rows = [prefix.trimEnd()];
  detail(rows, c, wide, 12, title, []);
  return rows;
}

/**
 * One goal's rows. `paused` is why an unfinished goal gets no session although nothing is wrong with it (its
 * programme is draft, or it is held): its `ready` reads `paused`, grey, and its hold is a grey row. Red is kept for
 * what waits on someone (Martin, blocked, a malformed goal, `note`). `saidHolds` carries the hold reasons a programme's
 * tree has already drawn, so a reason shared by several goals is written once and then `as above`.
 */
function goalLines(lines, c, wide, goal, expand, sessions, note, { paused, saidHolds, stateIndent }) {
  const isFinished = finished(goal);
  const stage = goal.stage || '—';
  const waits = goal.status === 'Martin' || goal.status === 'blocked';
  const pausedNow = !isFinished && !waits && (paused || Boolean(goal.hold));
  const status = pausedNow && goal.status === 'ready' ? 'paused' : goal.status || '—';
  const tone = waits ? ['red'] : isFinished || pausedNow ? ['grey'] : ['green'];
  const number = String(goal.number ?? '').padStart(3);
  line(lines, c, wide, 6, `${number} ${goal.title || goal.name}`, goal.running ? ['bold'] : []);
  const criteria = goal.criteria ? `${goal.criteria.met}/${goal.criteria.all}` : '—';
  const prefix = `${' '.repeat(stateIndent)}${c(`stage ${stage}`, 'grey')} · status ${c(status, ...tone)} · `;
  const count = `criteria ${criteria}`;
  // Keep status and criteria whole, even when counts no longer fit one row.
  if (width(prefix) + count.length <= wide) lines.push(`${prefix}${c(count, 'grey')}`);
  else {
    lines.push(prefix.replace(/ · $/u, ''));
    line(lines, c, wide, stateIndent, count, ['grey']);
  }
  if (goal.hold) {
    const reason = goal.hold.reason ?? '—';
    const said = saidHolds?.has(reason);
    saidHolds?.add(reason);
    line(lines, c, wide, 10, `held by ${goal.hold.by ?? '—'} since ${goal.hold.at ?? '—'} — ${said ? 'as above' : reason}`, ['grey']);
  }
  if (goal.problems?.length) line(lines, c, wide, 10, `GOAL.json: ${goal.problems[0]}`, ['red']);
  else if (note) line(lines, c, wide, 10, note, ['red']);
  else if (['blocked', 'Martin'].includes(goal.status)) {
    const reason = goal.question || goal.last?.comment || (goal.status === 'Martin' ? 'waits on Martin' : 'a mend session resolves the obstacle');
    line(lines, c, wide, 10, goal.stage === 'merge' && goal.status === 'blocked' ? mergeFailureSummary(reason) : reason, ['red']);
  }
  for (const session of sessions) lines.push(...activityLines(c, wide, session, { expand }));
  for (const pr of goal.prs || []) {
    lines.push(...prLines(c, wide, pr));
    if (pr.merge_red) line(lines, c, wide, 12, mergeFailureSummary(pr.merge_red), ['red']);
  }
  const metadata = [goal.name, ...(goal.repos || []), `${goal.sessions ?? 0} session${goal.sessions === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  line(lines, c, wide, 10, metadata, ['grey']);
  const said = isFinished ? goal.last?.done || goal.last?.comment : goal.last?.next || goal.last?.comment;
  if (said && one(said) !== one(goal.question || (['blocked', 'Martin'].includes(goal.status) ? goal.last?.comment : ''))) {
    line(lines, c, wide, 10, said, isFinished ? ['grey'] : []);
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
 * a live session), which stays in its phase until the session ends. A phase none of whose goals
 * is drawn is not drawn; `expand` controls session metadata.
 * Under NEEDS ATTENTION, in both views: a malformed goal, a finished goal the
 * runner refused to archive (`archive_refused`) and a finished goal with an
 * open pull request, each with its line and its pull requests as child rows.
 */
export function programmeTreeLines(c, wide, group, { expand = false, sessions = [], stateIndent = 10 } = {}) {
  const lines = [];
  const owned = (goal) => sessions.filter((s) => sessionGoal(s) === `${group.programme}/${goal.name}`);
  const atWork = (goal) => goal.running || owned(goal).length > 0;
  const attention = (goal) => finished(goal) && !atWork(goal) && notArchived(goal) !== null;
  const needing = attentionGoals(group, sessions);
  const saidHolds = new Set();
  const goalOptions = { paused: group.record_state === 'draft', saidHolds, stateIndent };
  for (const phase of group.phases || []) {
    if (phase.number == null) continue;
    const visible = phase.goals.filter((goal) => !attention(goal) && (!finished(goal) || atWork(goal)));
    if (!visible.length) continue;
    if (lines.length) lines.push('');
    line(lines, c, wide, 4, `Phase ${phase.number}${phaseWaits(phase, group)}`, ['cyan', 'bold']);
    for (const [index, goal] of visible.entries()) {
      if (index > 0) lines.push('');
      goalLines(lines, c, wide, goal, expand, owned(goal), null, goalOptions);
    }
  }
  if (needing.length) {
    if (lines.length) lines.push('');
    line(lines, c, wide, 4, 'NEEDS ATTENTION', ['red', 'bold']);
    for (const [index, goal] of needing.entries()) {
      if (index > 0) lines.push('');
      goalLines(lines, c, wide, goal, expand, owned(goal), finished(goal) ? notArchived(goal) : null, goalOptions);
    }
  }
  if (group.prs?.length) {
    line(lines, c, wide, 4, 'PRs without a goal', ['grey']);
    for (const pr of group.prs) {
      lines.push(...prLines(c, wide, pr));
      if (pr.merge_red) line(lines, c, wide, 12, mergeFailureSummary(pr.merge_red), ['red']);
    }
  }
  return lines;
}
