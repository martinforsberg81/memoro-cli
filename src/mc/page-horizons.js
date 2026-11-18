/** Horizon roll-up, per-horizon figures and programme headings for the overview.
 * Both the grouped renderer and its counts use the collected section membership.
 */
import { detail } from './page-operations.js';
import { attentionGoals } from './page-programmes.js';
import { sessionGoal } from './page-activity.js';
import { width } from './status-render.js';

const FINISHED = ['done', 'dropped'];

const finished = (goal) => FINISHED.includes(goal.stage);

/** The runner's sessions at work on a programme's goals: `<programme>/<goal>` is their identity. */
const onGoals = (group, sessions) => sessions.filter((session) => sessionGoal(session).startsWith(`${group.programme}/`));

/**
 * What a programme row says, from the group alone. `sessions` are the runner's. Exported for the tests that hold
 * the row to the data.
 */
export function programmeFacts(group, sessions = []) {
  const goals = group.goals || [];
  const unfinished = goals.filter((goal) => !finished(goal) && !goal.problems?.length);
  const stages = new Map();
  for (const goal of unfinished) stages.set(goal.stage || '—', (stages.get(goal.stage || '—') || 0) + 1);
  const phases = goals.map((goal) => goal.phase).filter((phase) => Number.isInteger(phase));
  const attention = attentionGoals(group, sessions).length;
  const prs = (group.prs?.length || 0) + goals.reduce((sum, goal) => sum + (goal.prs?.length || 0), 0);
  const kinds = new Map();
  const mark = (kind, n = 1) => { if (n) kinds.set(kind, (kinds.get(kind) || 0) + n); };
  mark('plan', group.planning_sessions?.length || 0);
  for (const session of group.sessions || []) mark(session.kind || 'programme');
  for (const session of onGoals(group, sessions)) mark(session.kind || 'build');
  const sessionCount = [...kinds.values()].reduce((sum, n) => sum + n, 0);
  return {
    stages: [...stages].sort(([a], [b]) => a.localeCompare(b)),
    unfinished: unfinished.length,
    done: group.finished ?? goals.filter(finished).length,
    current: group.current_phase ?? null,
    last: phases.length ? Math.max(...phases) : null,
    prs,
    marks: [...kinds].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => ({ kind, count })),
    sessions: sessionCount,
    martin: unfinished.filter((goal) => goal.status === 'Martin').length,
    blocked: unfinished.filter((goal) => goal.status === 'blocked').length,
    attention,
    // Something under way: an unfinished goal, a session, an open pull request or an item that needs a person's eye.
    underway: group.record_state === 'draft' || unfinished.length > 0 || sessionCount > 0 || prs > 0 || attention > 0,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The fallback horizon reference for a programme in Other: `no horizon`, an
 * invalid record, or the slug and its state. A page without horizon data says nothing.
 */
function horizonWords(data, group) {
  if (!data.horizons) return '';
  if (group.record_invalid) return 'horizon unknown';
  if (!group.horizon) return 'no horizon';
  const state = group.horizon_state === 'not held' && (data.horizons.error || data.horizons.unreadable?.includes(group.horizon))
    ? 'unreadable' : group.horizon_state;
  return `horizon ${group.horizon}${state ? ` (${state})` : ''}`;
}

const separator = (part, index) => part.sep ?? (index ? ' · ' : '');

/** Wrap the unpainted heading, keeping the style of each portion of a continuation row. */
function headingLines(c, wide, parts) {
  const lines = [];
  let text = '';
  const spans = parts.map((part, index) => {
    text += separator(part, index);
    const from = text.length;
    text += part.text;
    return { from, to: text.length, styles: part.styles };
  });
  for (let start = 0; start < text.length;) {
    while (text[start] === ' ') start += 1;
    const indent = lines.length ? 2 : 0;
    const room = wide - indent;
    const cut = text.length - start <= room ? text.length : text.lastIndexOf(' ', start + room);
    const end = cut > start ? cut : start + room;
    let row = ' '.repeat(indent);
    let at = start;
    for (const span of spans) {
      const from = Math.max(at, span.from);
      const to = Math.min(end, span.to);
      if (to <= from) continue;
      if (from > at) row += c(text.slice(at, from), 'grey');
      row += c(text.slice(from, to), ...span.styles);
      at = to;
    }
    lines.push(row + text.slice(at, end).trimEnd());
    start = end;
  }
  return lines;
}

/**
 * A programme's heading: name, fallback horizon in Other, phase or
 * record state when applicable, goal count and nonzero figures.
 */
export function programmeHeading(c, wide, data, group, facts) {
  const phase = group.record_state === 'draft' ? 'draft' : facts.unfinished && facts.current != null ? `phase ${facts.current}${facts.last != null ? ` of ${facts.last}` : ''}` : group.record_state === 'ready' ? 'ready' : '';
  const goals = group.goals?.length || 0;
  const rest = [
    phase,
    plural(goals, 'goal'),
    group.priority ? `priority ${group.priority}` : '',
    facts.done ? `${facts.done} finished in tree` : '',
  ].filter(Boolean).map((text) => ({ text, styles: ['grey'] }));
  const open = data.horizons?.open?.find((horizon) => horizon.programmes?.includes(group.programme));
  const horizon = open ? '' : horizonWords(data, group);
  const parts = [];
  const warning = { text: 'record invalid', styles: ['red'] };
  const warningAfterHorizon = group.record_invalid && data.horizons && !open;
  if (horizon) {
    parts.push({ text: horizon, styles: ['grey'] });
    if (warningAfterHorizon) parts.push(warning);
  }
  parts.push(...rest);
  if (group.record_invalid && !warningAfterHorizon) parts.push(warning);
  return headingLines(c, wide, [{ text: group.programme, styles: ['bold'] }, { ...parts[0], sep: '  ' }, ...parts.slice(1)]);
}

/**
 * What each open horizon says, from the data alone: its programmes' state and its goals. `sessions` are the runner's.
 * Exported for the tests that hold the row to the data.
 */
export function horizonFigures(data, sessions = []) {
  const groups = data.programmes?.programmes || [];
  const byName = new Map(groups.map((group) => [group.programme, group]));
  return (data.horizons?.open || []).map((horizon) => {
    const own = (horizon.programmes || []).map((name) => byName.get(name)).filter(Boolean);
    const all = own.map((group) => ({ group, facts: programmeFacts(group, sessions) }));
    const sum = (pick) => all.reduce((n, item) => n + pick(item), 0);
    return {
      horizon,
      programmes: own.length,
      drafts: own.filter((group) => group.record_state === 'draft').length,
      open: sum(({ facts }) => facts.unfinished),
      landed: sum(({ facts }) => facts.done),
      held: sum(({ group }) => (group.goals || []).filter((goal) => !finished(goal) && goal.hold).length),
      prs: sum(({ facts }) => facts.prs),
      running: sum(({ facts }) => facts.sessions),
    };
  });
}

/**
 * HORIZONS, drawn into `lines`: one row for every open horizon, in the desk's order. Nothing is drawn for a page
 * without `data.horizons`. `sessions` are the runner's (`runner.sessions`).
 */
export function horizonsLines(lines, c, wide, data, { sessions = [] } = {}) {
  const horizons = data.horizons;
  if (!horizons) return;
  const groups = data.programmes?.programmes || [];
  const figures = horizonFigures(data, sessions);
  const underway = groups.filter((group) => programmeFacts(group, sessions).underway).length;
  const goalsOpen = figures.reduce((n, item) => n + item.open, 0);
  const running = groups.reduce((n, group) => n + programmeFacts(group, sessions).sessions, 0);
  const summary = [
    `${figures.length} open`,
    `${underway} ${underway === 1 ? 'programme' : 'programmes'} under way`,
    `${goalsOpen} ${goalsOpen === 1 ? 'goal' : 'goals'} open`,
    running ? `${running} running` : '',
  ].filter(Boolean).join(' · ');
  if (width(summary) + 12 <= wide) lines.push(`  ${c('HORIZONS', 'bold')}  ${c(summary, 'grey')}`);
  else {
    lines.push(`  ${c('HORIZONS', 'bold')}`);
    detail(lines, c, wide, 4, summary);
  }
  if (horizons.error) detail(lines, c, wide, 4, `horizons unreadable — ${horizons.error}`, ['red']);
  if (horizons.unreadable?.length) {
    detail(lines, c, wide, 4, `${plural(horizons.unreadable.length, 'horizon record')} cannot be read: ${horizons.unreadable.join(', ')}`, ['red']);
  }
}

/** The title and facts share the far edge when possible. On narrow terminals
 * the title keeps its rule, and the facts continue against the same edge. */
export function horizonHeading(lines, c, wide, { horizon, ...figure }) {
  const title = `${horizon.position == null ? '' : `${String(horizon.position).padStart(2, '0')}  `}${horizon.title || horizon.slug}`;
  const facts = horizonFacts(figure);
  const rule = (n) => c('─'.repeat(n), 'rule');
  const room = wide - width(title) - width(facts) - 4;
  if (room >= 3) {
    lines.push(`  ${c(title, 'bold')} ${rule(room)} ${c(facts, 'grey')}`);
    return;
  }
  const titleRows = [];
  detail(titleRows, (text) => text, wide - 4, 2, title);
  const last = titleRows.pop();
  lines.push(...titleRows.map((row) => `  ${c(row.trimStart(), 'bold')}`));
  lines.push(`  ${c(last.trimStart(), 'bold')} ${rule(wide - width(last) - 1)}`);
  const factRows = [];
  detail(factRows, (text) => text, wide, 4, facts);
  for (const row of factRows) {
    const text = row.trimStart();
    lines.push(`${' '.repeat(wide - width(text))}${c(text, 'grey')}`);
  }
}

/** Facts belonging to one horizon, including dormant programmes. */
export function horizonFacts(figure) {
  return [
    figure.programmes ? plural(figure.programmes, 'programme') : 'No programmes',
    figure.drafts ? `${figure.drafts} draft` : null,
    `${plural(figure.open, 'goal')} open`,
    figure.landed ? `${figure.landed} finished in tree` : null,
    figure.held ? `${figure.held} held` : null,
    figure.prs ? `${figure.prs} PR` : null,
    figure.running ? `${figure.running} running` : null,
  ].filter(Boolean).join(' · ');
}
