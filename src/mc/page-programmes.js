/** PROGRAMMES' own layout: programme → phase → goal → PR, without lane cells. */
import { clipCell, prTone, stateTone } from './page-grid.js';
import { width } from './status-render.js';

const FINISHED = 'finished';
const LABEL = { ready: 'can start', running: 'running', waiting: 'waiting for phase', blocked: 'blocked',
  invalid: 'invalid', planning: 'needs plan', merging: 'awaiting merge', incomplete: 'needs criteria', finished: 'finished' };
const TONE = { ready: ['green'], running: ['green'], waiting: ['yellow'], blocked: ['red'], invalid: ['red'],
  planning: ['cyan'], merging: ['green'], incomplete: ['yellow'], finished: ['grey'] };
const one = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const noteworthy = (goal) => ['running', 'blocked', 'invalid', 'merging'].includes(goal.availability) || goal.prs?.length;

function line(c, wide, indent, text, styles = []) {
  const shown = clipCell(text, Math.max(0, wide - indent));
  return `${' '.repeat(indent)}${styles.length ? c(shown, ...styles) : shown}`;
}

/** Columns belong to this tree alone. No kind, session-count or free-text tail. */
function columns(wide) {
  const repo = wide >= 100 ? 12 : 0;
  return { name: Math.min(48, wide - 10 - 10 - 19 - repo), stage: 10, state: 19, repo };
}
function cell(c, text, room, tone = []) {
  if (!room) return '';
  const shown = clipCell(text, room - 1);
  return `${tone.length && shown ? c(shown, ...tone) : shown}${' '.repeat(room - shown.length)}`;
}
function columnHead(c, wide) {
  const col = columns(wide);
  return `          ${cell(c, 'GOAL', col.name, ['bold'])}${cell(c, 'STAGE', col.stage, ['bold'])}${cell(c, 'STATE', col.state, ['bold'])}${cell(c, 'REPO', col.repo, ['bold'])}`.trimEnd();
}

function prLine(c, wide, pr) {
  const ref = `${pr.repo || 'unknown'}#${pr.number}`;
  const state = pr.merge_red ? 'red' : pr.merging === 'landing' ? 'landing' : pr.merging === 'queued' ? 'queued' : pr.draft ? 'draft' : 'open';
  const prefix = `          ↳ ${c(ref, ...prTone([pr]))}  `;
  const room = Math.max(0, wide - width(prefix) - state.length - 2);
  const title = cell(c, pr.title || pr.branch || '', room);
  return `${prefix}${title}  ${c(state, ...stateTone(state))}`.trimEnd();
}

function goalLines(lines, c, wide, goal, expand) {
  const col = columns(wide);
  const finished = goal.availability === FINISHED;
  const stage = goal.stage ?? goal.state ?? '—';
  const tone = TONE[goal.availability] || ['grey'];
  const stageTone = goal.availability === 'blocked' || goal.availability === 'invalid' ? tone
    : stage === 'plan' ? ['cyan'] : stateTone(stage);
  const number = String(goal.number ?? '').padStart(3);
  lines.push((`      ${c(number, 'grey')} ${cell(c, goal.title || goal.name, col.name, goal.running ? ['bold'] : [])}`
    + `${cell(c, stage, col.stage, stageTone)}${cell(c, LABEL[goal.availability] || 'unknown', col.state, tone)}`
    + cell(c, (goal.repos || [goal.repo]).filter(Boolean).join(', '), col.repo, ['grey'])).trimEnd());
  if (goal.problems?.length) lines.push(line(c, wide, 10, `GOAL.json: ${goal.problems[0]}`, ['red']));
  else if (goal.availability === 'blocked') {
    lines.push(line(c, wide, 10, goal.question || goal.last?.comment || 'waits on a person', ['red']));
  }
  for (const pr of goal.prs || []) {
    lines.push(prLine(c, wide, pr));
    if (pr.merge_red) lines.push(line(c, wide, 12, pr.merge_red, ['red']));
  }
  if (!expand) return;
  const metadata = [goal.name, ...(goal.repos || []), `${goal.sessions ?? 0} sessions`].filter(Boolean).join(' · ');
  lines.push(line(c, wide, 10, metadata, ['grey']));
  const said = finished ? goal.last?.done || goal.last?.comment : goal.last?.next || goal.last?.comment;
  if (said && one(said) !== one(goal.question || (goal.availability === 'blocked' ? goal.last?.comment : ''))) {
    lines.push(line(c, wide, 10, said, finished ? ['grey'] : []));
  }
}

/** Fold quiet future phases; blockers, malformed records and open PRs stay visible. */
export function programmeTreeLines(c, wide, group, { expand = false } = {}) {
  const lines = [];
  let future = [];
  const finished = [];
  const flushFuture = () => {
    if (!future.length) return;
    const numbers = future.map((phase) => phase.number);
    const sequential = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
    const range = sequential && numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : numbers.join(', ');
    lines.push(line(c, wide, 4, `▸ Phases ${range} · ${plural(future.reduce((n, phase) => n + phase.goals.length, 0), 'goal')} · a to expand`, ['yellow']));
    future = [];
  };
  for (const phase of group.phases || []) {
    const open = phase.goals.filter((goal) => goal.availability !== FINISHED);
    const done = phase.goals.filter((goal) => goal.availability === FINISHED);
    finished.push(...done);
    if (!open.length) continue;
    if (phase.state === 'waiting' && !expand && !open.some(noteworthy)) {
      future.push(phase);
      continue;
    }
    flushFuture();
    const label = phase.number == null ? 'NEEDS ATTENTION' : `PHASE ${phase.number} · ${phase.state === 'current' ? 'CURRENT' : `WAITING FOR PHASE ${group.current_phase}`}`;
    lines.push(line(c, wide, 4, label, phase.number == null ? ['red', 'bold'] : phase.state === 'current' ? ['cyan', 'bold'] : ['yellow']));
    lines.push(columnHead(c, wide));
    for (const goal of open) goalLines(lines, c, wide, goal, expand);
  }
  flushFuture();
  if (finished.length) {
    const visible = expand ? finished : finished.filter(noteworthy);
    lines.push(line(c, wide, 4, `${visible.length ? '▾' : '▸'} Finished · ${plural(finished.length, 'goal')}${visible.length < finished.length ? ' · a to expand' : ''}`, ['grey']));
    if (visible.length) {
      lines.push(columnHead(c, wide));
      for (const goal of visible) goalLines(lines, c, wide, goal, expand);
    }
  }
  if (group.prs?.length) {
    lines.push(line(c, wide, 4, 'PRs WITHOUT A GOAL', ['cyan']));
    for (const pr of group.prs) {
      lines.push(prLine(c, wide, pr));
      if (pr.merge_red) lines.push(line(c, wide, 12, pr.merge_red, ['red']));
    }
  }
  return lines;
}
