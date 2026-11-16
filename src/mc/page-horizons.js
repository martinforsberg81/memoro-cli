/**
 * The page's HORIZONS section and the programme headings (docs/technical/mc-ui.md, The sections). `horizonsLines` draws
 * one row for every open horizon in the desk's order: its number and title, how many programmes it has and in what
 * state, and its goals (open, landed, held, open pull requests, a mark while a session works). The programmes are
 * drawn below it, each in its own frame (page-render.js), headed by `programmeHeading`: its number, its horizon and its
 * phase. Both draw from `data.horizons` and `data.programmes` alone, so what `mc --json` says and what the page draws
 * cannot differ.
 *
 * The module draws with its own small pieces and imports nothing from page-render.js, which imports it.
 */
import { PR_TONE, clipCell, kindTone } from './page-grid.js';
import { frameEnd, frameTop } from './page-operations.js';
import { attentionGoals } from './page-programmes.js';
import { sessionGoal } from './page-activity.js';
import { clip, width } from './status-render.js';

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

/** A run of `{ text, styles }` parts, painted. */
const painted = (c, parts) => parts.map((part) => (part.styles?.length ? c(part.text, ...part.styles) : part.text)).join('');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const GAP = '  ';

/**
 * The words for a programme's horizon: `horizon 5` (its number among the open horizons, in the desk's order),
 * `no horizon`, or the slug a record names that is not an open horizon, with that horizon's state. A page without
 * horizons says nothing.
 */
export function horizonWords(data, group) {
  if (!data.horizons) return '';
  const open = (data.horizons.open || []).find((horizon) => (horizon.programmes || []).includes(group.programme) || (group.horizon && horizon.slug === group.horizon));
  if (open) return open.position != null ? `horizon ${open.position}` : `horizon ${open.slug}`;
  return group.horizon ? `horizon ${group.horizon}${group.horizon_state ? ` (${group.horizon_state})` : ''}` : 'no horizon';
}

/**
 * A programme's frame heading: its number and name in the title; in the top rule its horizon, its phase, its goals and
 * proposals, then the figures it has always had (priority, done, an invalid record).
 */
export function programmeHeading(c, wide, data, group, facts) {
  const phase = group.record_state === 'draft' ? 'draft' : facts.unfinished && facts.current != null ? `phase ${facts.current}${facts.last != null ? ` of ${facts.last}` : ''}` : '';
  const goals = group.goals?.length || 0;
  // README.md Part 2: `28  name  ·  no horizon  ·  phase 1 of 2 · 2 goals · 7 proposals`.
  const rest = [
    phase,
    plural(goals, 'goal'),
    group.proposals ? plural(group.proposals, 'proposal') : '',
    group.priority ? `priority ${group.priority}` : '',
    facts.done ? `${facts.done} done` : '',
  ].filter(Boolean).map((text) => ({ text, styles: ['grey'] }));
  if (group.record_invalid) rest.push({ text: 'record invalid', styles: ['red'] });
  // With no horizons read there is no horizon to set apart: the facts follow the name as any frame's do.
  const horizon = horizonWords(data, group);
  if (horizon && rest.length) rest[0] = { ...rest[0], sep: '  ·  ' };
  const parts = horizon ? [{ text: horizon, styles: ['grey'], sep: '·  ' }, ...rest] : rest;
  const number = group.number != null ? `${group.number}  ` : '';
  return frameTop(c, wide, `${number}${group.programme}`, parts);
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
  const top = lines.length;
  lines.push(frameTop(c, wide, 'HORIZONS', [
    `${figures.length} open`,
    `${underway} ${underway === 1 ? 'programme' : 'programmes'} under way`,
    `${goalsOpen} ${goalsOpen === 1 ? 'goal' : 'goals'} open`,
    running ? `${running} running` : '',
  ].filter(Boolean).map((text) => ({ text, styles: ['grey'] }))));
  if (horizons.error) lines.push(`    ${c(clip(`horizons unreadable — ${horizons.error}`, wide - 4), 'red')}`);
  if (horizons.unreadable?.length) lines.push(`    ${c(clip(`${horizons.unreadable.length} horizon record${horizons.unreadable.length === 1 ? '' : 's'} cannot be read: ${horizons.unreadable.join(', ')}`, wide - 4), 'red')}`);

  const rows = figures.map((figure) => {
    const state = [
      figure.programmes ? plural(figure.programmes, 'programme') : 'no programme',
      figure.drafts ? `${figure.drafts} draft` : null,
      !figure.open && !figure.drafts && figure.programmes ? (figure.landed ? 'done' : 'nothing open') : null,
    ].filter(Boolean).join(' · ');
    const goals = [
      figure.open ? { text: `${figure.open} open`, styles: [] } : null,
      figure.landed ? { text: `${figure.landed} landed`, styles: ['grey'] } : null,
      figure.held ? { text: `⊘ ${figure.held}`, styles: ['red'] } : null,
      figure.prs ? { text: `${figure.prs} PR`, styles: [...PR_TONE] } : null,
    ].filter(Boolean);
    if (!figure.open && !figure.landed && !figure.held && !figure.prs) goals.push({ text: '0 goals open', styles: ['grey'] });
    if (figure.running) goals.push({ text: '●', styles: kindTone('build') });
    const joined = goals.flatMap((part, i) => (i && part.text !== '●' ? [{ text: ' · ', styles: ['grey'] }, part] : i ? [{ text: '  ' }, part] : [part]));
    return { figure, state, joined, goalsWidth: joined.reduce((n, part) => n + width(part.text), 0) };
  });
  const places = rows.map(({ figure }) => (figure.horizon.position != null ? `${figure.horizon.position}` : ''));
  const placeWidth = Math.max(0, ...places.map((place) => place.length));
  const stateWidth = Math.max(0, ...rows.map((row) => width(row.state)));
  const goalsWidth = Math.max(0, ...rows.map((row) => row.goalsWidth));
  const titleRoom = Math.max(8, wide - 4 - placeWidth - (placeWidth ? 2 : 0) - stateWidth - goalsWidth - 2 * GAP.length);
  const titleWidth = Math.min(titleRoom, Math.max(0, ...rows.map(({ figure }) => width(figure.horizon.title || figure.horizon.slug))));
  rows.forEach((row, index) => {
    const title = clipCell(row.figure.horizon.title || row.figure.horizon.slug, titleWidth);
    const text = `    ${c(places[index].padStart(placeWidth), 'grey')}${placeWidth ? GAP : ''}${c(title, 'bold')}${' '.repeat(Math.max(0, titleWidth - width(title)))}${GAP}${row.state}${' '.repeat(Math.max(0, stateWidth - width(row.state)))}${GAP}${painted(c, row.joined)}`;
    // The last resort: whatever still runs past the width is cut by the terminal's measure.
    lines.push(width(text) > wide ? clip(text.replace(/\u001b\[[0-9;]*m/gu, ''), wide) : text);
  });
  frameEnd(lines, c, wide, top);
}
