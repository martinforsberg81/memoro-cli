/**
 * The page's HORIZONS section: the open horizons in the desk's order, and under each one row for every programme that
 * names it and has something under way; then the programmes that serve none, the same way; then one folded row for
 * every other programme (docs/technical/mc-ui.md, The sections). `horizonsLines` draws it from `data.horizons` and
 * `data.programmes` alone, so what `mc --json` says and what the page draws cannot differ.
 *
 * The row is the programme's one-line answer to "is it going, and where": its number, its name, the phase it is in,
 * its unfinished goals by stage, what is done, the open pull requests, then a mark for each session at work on it and
 * the flags for a goal that waits on Martin (⚑), is blocked (⊘) or needs attention (!). Its goals, phases and session
 * frames are in the programme's own view (the number or the name at the prompt) and in `a`.
 *
 * The module draws with its own small pieces and imports nothing from page-render.js, which imports it.
 */
import { PR_TONE, STAGE_TONE, clipCell, kindTone } from './page-grid.js';
import { attentionGoals } from './page-programmes.js';
import { sessionGoal } from './page-activity.js';
import { clip, width } from './status-render.js';

/** At most this many marks of one kind on a row; more are drawn `●×n`, as the pipeline draws them. */
const MARK_CAP = 8;
const FINISHED = ['done', 'dropped'];
const INDENT = 4;

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

/** The stage counts in the order the pipeline runs them, the stages it does not know after, by name. */
const STAGES = Object.keys(STAGE_TONE);
const stageOrder = (stages) => [...stages].sort(([a], [b]) => {
  const x = STAGES.indexOf(a), y = STAGES.indexOf(b);
  return (x < 0 ? STAGES.length : x) - (y < 0 ? STAGES.length : y) || a.localeCompare(b);
});

/** A run of `{ text, styles }` parts, painted. */
const painted = (c, parts) => parts.map((part) => (part.styles?.length ? c(part.text, ...part.styles) : part.text)).join('');
const plainWidth = (parts) => parts.reduce((sum, part) => sum + width(part.text), 0);

/**
 * One programme row, painted, within `wide`. `extra` are parts the row adds after its facts (the horizon a programme
 * under `Serving no horizon` names, and that horizon's state). Narrow, the facts give way first, the least telling
 * first (`priority`, then `done`, then the phase); the marks and the flags, the stage counts and the open pull
 * requests stay, and the name is clipped last.
 */
export function programmeRow(c, wide, group, facts, { digits = 2, extra = [], nameWidth = 0 } = {}) {
  const parts = []; // the facts, each with the rank at which it is dropped: higher goes first
  const add = (rank, text, styles = []) => text && parts.push({ rank, text, styles });
  if (group.record_state === 'draft') add(4, group.sign_off_waiting ? 'waits for sign-off' : 'draft');
  else if (facts.unfinished && facts.current != null) add(4, `phase ${facts.current}${facts.last != null ? ` of ${facts.last}` : ''}`);
  if (facts.unfinished) {
    const counts = stageOrder(facts.stages).map(([stage, n]) => ({ text: `${n} ${stage}`, styles: STAGE_TONE[stage] || ['grey'] }));
    counts.forEach((part, index) => parts.push({ rank: 2, text: part.text, styles: part.styles, joined: index > 0 ? ' · ' : null, group: 'stages' }));
  }
  if (facts.done) add(5, `${facts.done} done`, ['grey']);
  if (facts.prs) add(1, `${facts.prs} PR`, [...PR_TONE]);
  if (group.priority) add(6, `priority ${group.priority}`);
  if (group.record_invalid) add(0, 'record invalid', ['red']);
  for (const item of extra) add(0, item.text, item.styles);
  if (group.dormant && !parts.length) add(7, 'dormant', ['grey']);

  const marks = [];
  for (const { kind, count } of facts.marks) {
    if (marks.length) marks.push({ text: ' ' });
    marks.push({ text: count <= MARK_CAP ? '●'.repeat(count) : `●×${count}`, styles: kindTone(kind) });
  }
  const flags = [
    facts.martin ? { text: `⚑${facts.martin}`, styles: ['yellow'] } : null,
    facts.blocked ? { text: `⊘${facts.blocked}`, styles: ['red'] } : null,
    facts.attention ? { text: `!${facts.attention}`, styles: ['red'] } : null,
  ].filter(Boolean);
  const tail = [];
  for (const part of [...marks, ...(marks.length && flags.length ? [{ text: ' ' }] : []), ...flags.flatMap((flag, i) => (i ? [{ text: ' ' }, flag] : [flag]))]) tail.push(part);

  const number = `${String(group.number ?? '').padStart(digits)} `;
  const room = wide - INDENT;
  const sep = ' · ';
  const build = (kept) => {
    const out = [];
    for (const part of kept) {
      if (out.length) out.push({ text: part.joined ?? sep, styles: ['grey'] });
      out.push({ text: part.text, styles: part.styles });
    }
    return out;
  };
  const tailWidth = tail.length ? 2 + plainWidth(tail) : 0;
  let name = group.programme;
  let kept = [...parts];
  // The facts start in one column when there is room for it, and not otherwise.
  const column = () => (kept.length || tail.length ? Math.max(width(name), nameWidth) : width(name));
  const used = () => width(number) + column() + (kept.length ? 2 + plainWidth(build(kept)) : 0) + tailWidth;
  while (used() > room && kept.some((part) => part.rank >= 1)) {
    const top = Math.max(...kept.map((part) => part.rank));
    const at = kept.map((part) => part.rank).lastIndexOf(top);
    // A stage count is dropped with its whole run, never one stage of several.
    if (kept[at].group === 'stages') kept = kept.filter((part) => part.group !== 'stages');
    else kept.splice(at, 1);
  }
  if (used() > room) name = clipCell(name, Math.max(4, room - (used() - width(name))));
  const gap = kept.length && used() <= room ? ' '.repeat(Math.max(0, column() - width(name))) : '';
  const facing = kept.length ? `${gap}  ${painted(c, build(kept))}` : '';
  const trail = tail.length ? `  ${painted(c, tail)}` : '';
  const text = `${' '.repeat(INDENT)}${c(number, 'grey')}${c(name, 'bold')}${facing}${trail}`;
  // The last resort: whatever still runs past the width (a name that cannot be clipped further) is cut by the terminal's measure.
  return width(text) > wide ? clip(text.replace(/\u001b\[[0-9;]*m/gu, ''), wide) : text;
}

const sectionHeading = (lines, c, wide, counts) => {
  const left = `  ${c('HORIZONS', 'bold', 'cyan')}`;
  const shown = counts ? `  ${c(clip(counts, Math.max(8, wide - 12)), 'grey')}` : '';
  lines.push(`${left}${shown}`);
};

/** What a row under `Serving no horizon` adds: the slug the record names, and why it is not an open horizon. */
const extraFor = (group) => (group.horizon ? [{ text: `${group.horizon} (${group.horizon_state})`, styles: ['yellow'] }] : []);

/**
 * What a drawn HORIZONS can fold (`fold`, below), without drawing it: the programme rows under `Serving no horizon` and
 * the programme rows under the open horizons, as the default page shows them (the ones under way).
 */
export function horizonsFoldable(data, { sessions = [] } = {}) {
  const horizons = data.horizons;
  if (!horizons) return { none: 0, horizons: 0 };
  const groups = data.programmes?.programmes || [];
  const byName = new Map(groups.map((group) => [group.programme, group]));
  const shown = (name) => programmeFacts(byName.get(name), sessions).underway;
  const named = (horizons.open || []).flatMap((horizon) => (horizon.programmes || []).filter((name) => byName.has(name) && shown(name)));
  const none = (horizons.none || []).filter((name) => byName.has(name) && shown(name));
  return { none: none.length, horizons: named.length };
}

/**
 * HORIZONS, drawn into `lines`. `data` is the page's data; `expand` (`a`) draws every programme as a row under its
 * horizon and no folded row; `sessions` are the runner's (`runner.sessions`). `fold` is what the overview's budget
 * folds (page-overview.js): `none` programme rows from the end of `Serving no horizon`, and `horizons` programme rows
 * from the last open horizon up, each horizon keeping its title and saying how many of its rows it folded. Nothing is
 * drawn for a page without `data.horizons` (a page from before this section).
 */
export function horizonsLines(lines, c, wide, data, { expand = false, sessions = [], fold = {} } = {}) {
  const horizons = data.horizons;
  if (!horizons) return;
  const groups = data.programmes?.programmes || [];
  const byName = new Map(groups.map((group) => [group.programme, group]));
  const facts = new Map(groups.map((group) => [group.programme, programmeFacts(group, sessions)]));
  const digits = String(Math.max(0, ...groups.map((group) => group.number ?? 0))).length;
  const nameWidth = Math.min(28, Math.floor(wide / 3), Math.max(0, ...groups.filter((group) => facts.get(group.programme).underway || expand).map((group) => width(group.programme))));
  const shown = (name) => expand || facts.get(name)?.underway;

  const open = horizons.open || [];
  const underway = groups.filter((group) => facts.get(group.programme).underway).length;
  sectionHeading(lines, c, wide, `${open.length} open horizon${open.length === 1 ? '' : 's'} · ${underway} programme${underway === 1 ? '' : 's'} under way`);
  if (horizons.error) lines.push(`  ${c(clip(`horizons unreadable — ${horizons.error}`, wide - 2), 'red')}`);
  if (horizons.unreadable?.length) lines.push(`  ${c(clip(`${horizons.unreadable.length} horizon record${horizons.unreadable.length === 1 ? '' : 's'} cannot be read: ${horizons.unreadable.join(', ')}`, wide - 2), 'red')}`);

  const rows = (names, extra = () => []) => names.map((name) => byName.get(name)).filter(Boolean)
    .filter((group) => shown(group.programme))
    .forEach((group) => lines.push(programmeRow(c, wide, group, facts.get(group.programme), { digits, nameWidth, extra: extra(group) })));

  // The rows each horizon folds: from the last horizon up, a horizon's rows all before the one above it.
  const folded = new Map();
  let left = expand ? 0 : fold.horizons || 0;
  for (const horizon of [...open].reverse()) {
    const count = (horizon.programmes || []).filter((name) => byName.has(name) && shown(name)).length;
    folded.set(horizon, Math.min(left, count));
    left -= folded.get(horizon);
  }
  for (const horizon of open) {
    const title = horizon.title || horizon.slug;
    const place = horizon.position != null ? `${horizon.position}  ` : '';
    const slug = horizon.title && horizon.title !== horizon.slug ? `  ${horizon.slug}` : '';
    lines.push(`  ${c(`${place}${clip(title, Math.max(8, wide - 4 - place.length - slug.length))}`, 'bold')}${slug ? c(clip(slug, Math.max(0, wide - 6 - width(title) - place.length)), 'grey') : ''}`);
    const named = (horizon.programmes || []).filter((name) => byName.has(name) && shown(name));
    const take = folded.get(horizon) || 0;
    if (named.length) rows(named.slice(0, named.length - take));
    else lines.push(`${' '.repeat(INDENT)}${c('nothing under way', 'grey')}`);
    if (take) lines.push(`${' '.repeat(INDENT)}${c(`▸ ${take} programme${take === 1 ? '' : 's'} folded — a shows ${take === 1 ? 'it' : 'them'}`, 'grey')}`);
  }
  const none = (horizons.none || []).filter((name) => byName.has(name));
  const noneShown = none.filter(shown);
  if (noneShown.length) {
    const take = expand ? 0 : Math.min(fold.none || 0, noneShown.length);
    lines.push(`  ${c('Serving no horizon', 'bold')}`);
    rows(noneShown.slice(0, noneShown.length - take), extraFor);
    if (take) lines.push(`${' '.repeat(INDENT)}${c(`▸ ${take} more not serving a horizon — a shows ${take === 1 ? 'it' : 'them'}`, 'grey')}`);
  }
  const nothing = expand ? 0 : groups.filter((group) => !shown(group.programme)).length;
  if (nothing) lines.push(`  ${c(`▸ ${nothing} with nothing under way`, 'grey')}`);
  lines.push('');
}
