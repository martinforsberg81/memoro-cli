/**
 * The page's overview: what a person reads first, as long as the work (docs/technical/mc-ui.md, The overview).
 *
 * In order: the compact header, DESK, the warnings, HORIZONS, its horizon groups and OTHER PROGRAMMES, MAINTENANCE for what belongs to no
 * programme, and one row for each merge and deploy that is queued or running. The operational panels, the hero frame and
 * the pipeline are the operations view (`o`), drawn by page-render.js.
 *
 * `overviewLines` draws from `data` alone — what `mc --json` prints. There is no row budget or programme fold.
 *
 * Like page-horizons.js, this module imports nothing from page-render.js, which imports it.
 */
import { DESKS } from './session-owner.js';
import { mergeFailureSummary } from './merge-red.js';
import { ageWords } from './page-cache.js';
import { deskLines } from './page-desk.js';
import { clipCell } from './page-grid.js';
import { horizonFigures, horizonHeading, horizonsLines } from './page-horizons.js';
import { dayWords, howLong, straysReading } from './page-maintenance.js';
import { detail, frameTop, panelEnd } from './page-operations.js';
import { sessionGoal } from './page-activity.js';
import { clip, width } from './status-render.js';

const one = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();
const money = (n) => (n == null ? null : `≈$${n < 10 ? n.toFixed(2) : Math.round(n)}`);
/** A run of `{ text, styles }` parts, painted. */
const painted = (c, parts) => parts.map((part) => (part.styles?.length ? c(part.text, ...part.styles) : part.text)).join('');

/* ----------------------------------------------------------------- warnings */

/**
 * What the page puts above everything else: the red line of a run stopped inside a language gap, then the runner's
 * pause and not-running warnings.
 */
export function warningLines(lines, c, wide, data) {
  const gap = data.language?.open_gap;
  if (gap) {
    lines.push(`  ${c(clip(one(`language: ${gap.manifest} stopped after ${gap.act} — ${gap.says} · mc language resume`), wide - 2), 'red', 'bold')}`);
    lines.push('');
  }
  const runner = data.runner || {};
  if (runner.process?.alive) {
    if (runner.pressure && (runner.pressure.admission_blocked ?? (runner.pressure.status !== 'healthy'))) detail(lines, c, wide, 2, 'New sessions paused — low disk space', ['yellow']);
    if (runner.memory?.line) detail(lines, c, wide, 2, 'New sessions paused — low memory', ['yellow']);
    if (runner.stop) detail(lines, c, wide, 2, 'New sessions paused — runner stopping', ['yellow']);
  } else detail(lines, c, wide, 2, 'Runner not running — mc run starts it', ['yellow']);
}

/* ------------------------------------------------------------------- header */

/**
 * The header: `MC <version> · runner on|off · <n>/<m> lanes · runner ≈$<x> today · deploy <when>`, with `d  mc martin` at
 * the right edge of the first row. A second row only where the facts do not fit one at the width.
 * Model priority and cached provider usage follow on wrapped rows, visible without opening operations.
 */
export function headerRows(c, wide, data, version) {
  const runner = data.runner || {};
  const lanes = runner.setting?.lanes;
  const at = runner.production?.at;
  const facts = [
    { text: `MC${version ? ` ${version}` : ''}`, styles: ['bold'] },
    { text: `runner ${runner.process?.alive ? 'on' : 'off'}`, styles: runner.process?.alive ? [] : ['yellow'] },
    lanes ? { text: `${(runner.sessions || []).length}/${lanes} lanes`, styles: ['grey'] } : null,
    runner.day?.cost == null ? null : { text: `runner ${money(runner.day.cost)} today`, styles: ['grey'] },
    { text: `deploy ${at ? at.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z$/u, '') : 'none recorded'}`, styles: ['grey'] },
  ].filter(Boolean);
  const action = 'd  mc martin';
  const rows = [[]];
  const used = () => rows.at(-1).reduce((n, part, i) => n + width(part.text) + (i ? 3 : 0), 0);
  for (const fact of facts) {
    const room = rows.length === 1 ? wide - 2 - action.length - 2 : wide - 2;
    if (rows.at(-1).length && used() + 3 + width(fact.text) > room) rows.push([]);
    rows.at(-1).push(fact);
  }
  const lines = rows.slice(0, 2).map((row, index) => {
    const parts = row.flatMap((part, i) => (i ? [{ text: ' · ', styles: ['grey'] }, part] : [part]));
    const left = painted(c, parts);
    if (index) return `  ${left}`;
    return `  ${left}${' '.repeat(Math.max(2, wide - 2 - width(painted(c, parts).replace(/\u001b\[[0-9;]*m/gu, '')) - action.length))}${c(action, 'cyan')}`;
  });
  detail(lines, c, wide, 2, `MODEL PRIORITY  ${data.providerPriority || 'auto'}`, []);
  detail(lines, c, wide, 2, `PROVIDERS  ${data.billing || 'usage unknown'}`, []);
  return lines;
}

/* ----------------------------------------------------------------- Sessions */

/** A session's identity, so the same one seen twice is counted once: the desk's and a programme's copies of a plan session. */
const identity = (session) => JSON.stringify([session.verb || session.kind || '', session.name || '', session.pid ?? '', session.started ?? '']);

const RUNNER_KINDS = ['plan', 'build', 'review', 'mend'];

/**
 * Every session at work, as rows (they are counted in DESK's title, drawn under their goal and programme, and — with no
 * programme or goal — in MAINTENANCE; the rows are the page's key): `desk` (the sessions of every desk kind, by name: martin, manager, helper, and a kind
 * added later), `interactive` (the plan and programme sessions somebody has open) and `runner` (the runner's, by kind
 * and start). Each row is `{ kind, on, age, who, state, key }`; `key` is the session's identity.
 */
export function flightRows(data) {
  const sessions = data.sessions || {};
  const groups = data.programmes?.programmes || [];
  const seen = new Set();
  const take = (list) => list.filter((row) => (seen.has(row.key) ? false : seen.add(row.key)));
  const who = (session) => [session.tool, session.model].filter(Boolean).join(' · ');

  const deskMap = sessions.desk_sessions
    || Object.fromEntries(Object.entries(sessions.desks || {}).filter(([, session]) => session).map(([kind, session]) => [kind, [session]]));
  const kinds = [...DESKS.filter((kind) => deskMap[kind]), ...Object.keys(deskMap).filter((kind) => !DESKS.includes(kind)).sort()];
  const desk = take(kinds.flatMap((kind) => (deskMap[kind] || []).map((session) => ({
    kind, on: 'the desk', age: session.age_seconds, who: who(session), state: null, key: identity({ ...session, verb: kind }),
  }))));

  const interactive = [];
  const add = (session, kind) => interactive.push({
    kind, on: session.programme || session.area || 'no programme', age: session.age_seconds, who: who(session), state: null,
    key: identity({ ...session, verb: session.verb || kind }),
  });
  for (const list of Object.values(sessions.planning_sessions || {})) for (const session of list || []) add(session, 'plan');
  for (const list of Object.values(sessions.programme_sessions || {})) for (const session of list || []) add(session, session.verb || 'programme');
  for (const group of groups) {
    for (const session of group.planning_sessions || []) add({ ...session, programme: session.programme || group.programme }, 'plan');
    for (const session of group.sessions || []) add({ ...session, programme: session.programme || group.programme }, session.kind || session.verb || 'programme');
  }

  const rank = (kind) => { const at = RUNNER_KINDS.indexOf(kind); return at < 0 ? RUNNER_KINDS.length : at; };
  const runner = [...(data.runner?.sessions || [])]
    .sort((a, b) => rank(a.kind) - rank(b.kind) || String(a.kind).localeCompare(String(b.kind)) || String(a.started).localeCompare(String(b.started)))
    .map((session) => ({
      kind: session.kind || 'build',
      on: sessionGoal(session) || session.repo || 'unknown',
      age: session.elapsed_seconds,
      who: who(session),
      state: session.state && session.state !== 'running' ? [session.state, session.progress].filter(Boolean).join(' · ') : null,
      stateName: session.state,
      key: identity({ ...session, verb: session.kind }),
    }));
  return { desk, interactive: take(interactive), runner: take(runner) };
}

/* -------------------------------------------------------------- Maintenance */

const openFor = (seconds) => (seconds == null ? 'open' : `open ${ageWords(seconds)}`);

/** The words for whose a pull request is, on a MAINTENANCE row. */
export function ownerWords(owner) {
  if (owner.kind === 'plan') return owner.name ? `plan ${owner.name}` : 'a plan branch';
  if (owner.kind === 'workarea') return `workarea ${owner.name}`;
  if (owner.kind === 'worktree') return `checked out in ${String(owner.path).replace(/^\/Users\/[^/]+/u, '~')}`;
  return 'nobody\'s';
}

/**
 * The open pull requests no programme, goal, session or the merger draws: a plan session's, one opened from a terminal,
 * and one nobody holds any more. `sessionPrs` are the pull requests the runner's sessions carry.
 */
export function outsidePrs(prs, sessionPrs = []) {
  if (!prs) return [];
  const assigned = new Set(sessionPrs.map((pr) => `${pr.repo}#${pr.number}`));
  return (prs.items || []).filter((pr) => !pr.programme && !pr.merging && !pr.merge_red && !assigned.has(`${pr.repo}#${pr.number}`));
}

/**
 * What belongs to no programme, as items `{ key, label, text, tone }` in the order of the page: a failed merge no goal's
 * pull request carries, a main-red or deploy repair that waits on Martin, a failed deploy preparation or attempt, a stray
 * directory or session no verb explains, a runner or plan session with no goal or programme, and a pull request outside
 * goals. What belongs to a programme is in its frame: a held, blocked, malformed or stopped goal, a finished goal not
 * archived, and a goal's failed merge.
 */
export function maintenanceItems(data) {
  const items = [];
  const groups = data.programmes?.programmes || [];
  // `fact` is what the live page key reads when the text carries an age (pageKey): the item without how old it is.
  const add = (key, label, text, tone = ['red'], children = [], fact) => items.push({ key, label, text: one(text), tone, children, ...(fact != null ? { fact: one(fact) } : {}) });

  const mine = new Set();
  for (const group of groups) for (const goal of group.goals || []) for (const pr of goal.prs || []) if (pr.merge_red) mine.add(`${pr.repo || 'unknown'}#${pr.number}`);
  for (const item of data.merges?.red?.items || []) {
    const prs = item.prs?.length ? item.prs : [{ number: item.pr }];
    if (prs.every((pr) => mine.has(`${item.repo || 'unknown'}#${pr.number}`))) continue;
    const refs = prs.map((pr) => `${item.repo || 'unknown'}#${pr.number}`).join(', ');
    add(`merge:${item.repo || 'unknown'}#${prs[0].number}`, item.repo || 'merge', `merge failed — ${refs} · ${mergeFailureSummary(item.said || item.reason)}`);
  }

  for (const repo of data.checks?.main_mend || []) {
    if (repo.error) add(`main:${repo.repo}:error`, repo.repo, `main-red repair unreadable — ${repo.error}`);
    for (const entry of (repo.entries || []).filter((item) => item.state === 'Martin')) {
      add(`main:${repo.repo}:${entry.file}`, `${repo.repo} · ${entry.file}`, `main red waits on Martin${entry.pr ? ` · #${entry.pr}` : ''} — ${entry.reason || 'mc martin get'} · mc martin get`);
    }
  }
  const repair = data.checks?.deploy_mend;
  if (repair?.error) add('deploy:repair:error', 'deploy', `repair unreadable — ${repair.error}`);
  if (repair?.state === 'Martin') add('deploy:repair', 'deploy', `repair waits on Martin — ${[repair.line, repair.reason].filter(Boolean).join(' — ')} · mc martin get`);
  const production = data.runner?.production || {};
  const prep = production.preparation;
  if (prep?.state === 'failed') add('deploy:preparation', 'deploy', `preparation failed ${prep.short || ''}${prep.error ? ` — ${prep.error}` : ''}`.replace(/ {2,}/gu, ' '));
  if (production.failed) {
    add('deploy:attempt', 'deploy', `attempt failed ${production.failed.short || ''}${production.failed.stopped_at || production.progress?.step ? ` — ${production.failed.stopped_at || production.progress.step}` : ''}`.replace(/ {2,}/gu, ' '));
  }
  for (const stray of data.programmes?.strays || []) {
    if (stray.kind === 'directory' || !stray.kind) {
      add(`stray:${stray.name}`, stray.name, `not an area mc knows · checkout ${stray.checkout ? `yes · ${stray.uncommitted} uncommitted` : 'no'}`, ['yellow']);
      continue;
    }
    const what = stray.kind === 'tmux' ? 'not an area mc knows · tmux session'
      : `not an area mc knows · ${stray.verb ? `mc ${stray.verb}` : 'a session'} with no programme`;
    const pid = stray.kind !== 'tmux' && stray.pid ? ` · pid ${stray.pid}` : '';
    add(`stray:${stray.name}`, stray.name, `${what} · ${openFor(stray.age_seconds)}${pid}`, ['yellow'], [], `${what}${pid}`);
  }

  // Sessions no programme explains: a runner session on no goal of any programme, and a plan or programme session
  // whose programme is not listed. Match identities rather than object references: cached JSON copies sessions.
  const names = new Set(groups.map((group) => group.programme));
  const known = new Set(groups.flatMap((group) => (group.goals || []).map((goal) => `${group.programme}/${goal.name}`)));
  const plans = new Set(groups.flatMap((group) => group.planning_sessions || []).map((session) => JSON.stringify([session.name, session.pid, session.started])));
  const sessionRow = (kind, on, age, who) => [kind, openFor(age), who].filter(Boolean).join(' · ');
  const who = (session) => [session.tool, session.model].filter(Boolean).join(' · ');
  for (const session of data.runner?.sessions || []) {
    if (known.has(sessionGoal(session)) || plans.has(JSON.stringify([session.name, session.pid, session.started]))) continue;
    // The pull requests the session carries are its child rows, as they are under a goal.
    const prs = (session.prs || []).map((pr) => `${pr.repo || 'unknown'}#${pr.number}`);
    add(`session:${identity({ ...session, verb: session.kind })}`, sessionGoal(session) || session.repo || 'unknown', `${sessionRow(session.kind || 'build', null, session.elapsed_seconds, who(session))} · on no goal of a programme`, ['yellow'], prs);
  }
  for (const row of flightRows(data).interactive) {
    if (names.has(row.on.replace(/^programs\//u, ''))) continue;
    add(`session:${row.key}`, row.on, `${row.kind} session with no programme · ${openFor(row.age)}${row.who ? ` · ${row.who}` : ''}`, ['yellow']);
  }

  for (const pr of outsidePrs(data.prs, (data.runner?.sessions || []).flatMap((session) => session.prs || []))) {
    const nobody = pr.owner?.kind === 'none' || !pr.owner;
    add(`pr:${pr.repo}#${pr.number}`, `${pr.repo || 'unknown'}#${pr.number}`, `pull request outside goals · ${ownerWords(pr.owner || { kind: 'none' })}${pr.draft ? ' · draft' : ''} — ${pr.title || pr.branch || ''}`, nobody ? ['yellow'] : ['grey']);
  }
  return items;
}

/** The column the sources' summaries start in: a label, and room for the longest ("Dependencies"). */
const SOURCE_LABEL = 16;
const padTo = (text, size) => `${text}${' '.repeat(Math.max(0, size - width(text)))}`;

/**
 * MAINTENANCE's rows: the collector's sources in their order, the strays always read from the page's own data, so the
 * rows beneath them are what `maintenanceItems` says now. With no collected sources and nothing outside the programmes
 * there is no frame.
 */
export function maintenanceRows(data) {
  const given = data.maintenance?.sources;
  const items = maintenanceItems(data);
  if (!given && !items.length) return [];
  const strays = { id: 'strays', label: 'Strays', verb: '', state: 'ok', error: null, ...straysReading({ items }) };
  return [...(given || []).filter((source) => source.id !== 'strays'), strays];
}

/** One source's row: its label, what waits, and the verb that handles it at the right. A failed read is red, the whole row. */
function sourceRow(c, wide, source) {
  const red = source.state === 'error';
  const verb = source.verb ? width(source.verb) + 2 : 0;
  const room = Math.max(8, wide - 4 - SOURCE_LABEL - verb - 2);
  const summary = clipCell(source.summary || '', room);
  const label = padTo(clipCell(source.label, SOURCE_LABEL - 1), SOURCE_LABEL);
  const tone = red ? ['red'] : source.tone?.length ? source.tone : ['grey'];
  const right = source.verb ? `${' '.repeat(Math.max(0, room - width(summary)))}  ${c(source.verb, 'grey')}` : '';
  return `    ${c(label, ...(red ? ['red', 'bold'] : ['bold']))}${c(summary, ...tone)}${right}`;
}

/** What a source holds, drawn below its row at the summary column: strays' items, then the rows the view adds. */
function itemLines(lines, c, wide, items, indent) {
  for (const item of items) {
    const label = clipCell(item.label, Math.max(12, Math.floor(wide / 3)));
    const room = wide - indent - width(label) - 4;
    lines.push(`${' '.repeat(indent)}${c(label, 'bold')}  ${c(clipCell(item.text, Math.max(8, room)), ...item.tone)}`);
    for (const ref of item.children || []) lines.push(`${' '.repeat(indent + 2)}↳ ${c(clipCell(ref, Math.max(8, wide - indent - 6)), ...item.tone)}`);
  }
}

function maintenanceLines(lines, c, wide, rows) {
  if (!rows.length) return;
  lines.push(frameTop(c, wide, 'MAINTENANCE', `${rows.length} ${rows.length === 1 ? 'source' : 'sources'}`));
  for (const source of rows) {
    lines.push(sourceRow(c, wide, source));
    // What is outside the programmes is the facts of its row: each item is drawn beneath it.
    if (source.id === 'strays') itemLines(lines, c, wide, source.items || [], 6);
  }
  panelEnd(lines, c, wide);
}

/** A group's cells as the view says them: how many, and how long the oldest has waited. */
function groupWords(source, group) {
  if (source.id === 'errors') {
    return [group.count == null ? 'no baseline' : `${group.count} new`, `${group.critical ?? '?'} critical`, `${group.high ?? '?'} high`,
      group.age_seconds == null ? 'age unknown' : `collected ${ageWords(group.age_seconds)} ago`].join(' · ');
  }
  if (source.id === 'tests') {
    return group.never ? 'never run' : `${group.red == null ? 'unknown' : group.red ? `${group.red} red` : 'green'} · ${group.short || '?'} · ${ageWords(group.age_seconds)} ago`;
  }
  if (source.id === 'deps') {
    return group.never ? 'never read' : `${group.critical} critical · ${group.high} high · ${group.short || '?'} · read ${ageWords(group.age_seconds)} ago`;
  }
  return `${group.count}${group.oldest_seconds != null ? ` · oldest ${howLong(group.oldest_seconds)}` : ''}`;
}

/** The areas below their row, as the programme's design draws them: name, repository, when it last changed, aims. */
function areaLines(lines, c, wide, areas) {
  const indent = 4 + SOURCE_LABEL;
  const name = Math.min(28, Math.max(...areas.map((area) => width(area.name)), 4) + 2);
  const repo = Math.max(...areas.map((area) => width(area.repo)), 4) + 2;
  const when = 12;
  for (const area of areas) {
    const aims = area.aims ? `${area.aims} aim${area.aims === 1 ? '' : 's'}` : 'no aim';
    const changed = area.age_days == null ? 'unknown' : dayWords(area.age_days);
    lines.push(`${' '.repeat(indent)}${padTo(clipCell(area.name, name - 1), name)}${c(padTo(area.repo, repo), 'grey')}${c(padTo(changed, when), area.age_days === 0 ? 'bold' : 'grey')}${c(aims, area.aims ? 'grey' : 'yellow')}`);
  }
}

/** The maintenance view (`m`): every source's row with its detail below it. */
export function maintenanceView(lines, c, wide, data) {
  const rows = maintenanceRows(data);
  lines.push(frameTop(c, wide, 'MAINTENANCE', `${rows.length} ${rows.length === 1 ? 'source' : 'sources'}`, 'h  home'));
  const indent = 4 + SOURCE_LABEL;
  for (const source of rows) {
    lines.push(sourceRow(c, wide, source));
    if (source.state === 'error') detail(lines, c, wide, indent, source.error || 'unreadable', ['red']);
    for (const group of source.groups || []) {
      lines.push(`${' '.repeat(indent)}${c(padTo(clipCell(String(group.label), 24), 26), 'bold')}${c(clipCell(groupWords(source, group), Math.max(8, wide - indent - 28)), 'grey')}`);
      for (const name of group.items || []) lines.push(`${' '.repeat(indent + 2)}${c(clipCell(name, Math.max(8, wide - indent - 4)), 'grey')}`);
    }
    if (source.areas?.length) areaLines(lines, c, wide, source.areas);
    if (source.id === 'strays') itemLines(lines, c, wide, source.items || [], indent);
  }
  panelEnd(lines, c, wide);
  return lines;
}

/* ------------------------------------------------------- Merge and deploy */

/** The merge and deploy rows: one per repository with a landing or a queue, one for a deploy or its preparation running. */
export function mergeDeployRows(data) {
  const rows = [];
  for (const repo of data.merges?.repos || []) {
    const landings = repo.landings?.length ? repo.landings : repo.landing ? [repo.landing] : [];
    const queued = (repo.waiting || []).length;
    if (!landings.length && !queued) continue;
    const refs = landings.flatMap((item) => (item.prs || []).map((pr) => `#${pr.number}`));
    const parts = [repo.repo, landings.length ? `landing ${refs.length ? refs.join(', ') : 'a pull request'}` : null, queued ? `${queued} queued` : null].filter(Boolean);
    rows.push({ key: `merge:${repo.repo}`, label: 'MERGE', text: parts.join(' · '), tone: ['orange'] });
  }
  const production = data.runner?.production || {};
  const prep = production.preparation;
  const parts = [];
  const facts = [];
  if (production.running) {
    const what = `${production.running.short || production.short || 'a commit'} · ${production.running.late ? 'no end recorded' : 'running'}`;
    facts.push(what);
    parts.push(`${what}${production.running.age_seconds != null ? ` ${ageWords(production.running.age_seconds)}` : ''}`);
  }
  if (prep?.state === 'running') {
    const what = `preparing ${prep.short || ''}`.trim();
    facts.push(what);
    parts.push(`${what}${prep.stage_words ? ` · ${prep.stage_words}` : ''}`);
  }
  // `fact` is the row without its clock: what the page's key compares between frames.
  if (parts.length) rows.push({ key: 'deploy', label: 'DEPLOY', text: parts.join(' · '), fact: facts.join(' · '), tone: ['orange'] });
  return rows;
}

function mergeDeployLines(lines, c, wide, rows) {
  for (const row of rows) {
    // A frame with nothing beyond its title and facts: its top rule alone.
    lines.push(frameTop(c, wide, row.label, [{ text: row.text, styles: ['bold'] }]));
  }
}


/* ----------------------------------------------------------------- overview */

/**
 * The overview, as lines. `drawProgramme(group, width)` returns each
 * programme's heading and details without the group's inset.
 */
export function overviewLines(c, wide, data, { version = '', drawProgramme }) {
  const sessions = data.runner?.sessions || [];
  const flight = flightRows(data);
  const lines = headerRows(c, wide, data, version);
  const gap = () => { if (lines.at(-1) !== '') lines.push(''); };
  gap();
  deskLines(lines, c, wide, data.desk, { deskSessions: flight.desk.length });
  gap();
  warningLines(lines, c, wide, data);
  gap();
  if (data.horizons) { horizonsLines(lines, c, wide, data, { sessions }); gap(); }

  const groups = [...(data.programmes?.programmes || [])].sort((a, b) => String(a.programme).localeCompare(String(b.programme)));
  const assigned = new Set();
  const programmeIndent = '      ';
  const drawGroup = (members) => {
    let previousHasDetails = false;
    for (const [index, group] of members.entries()) {
      const { heading, body } = drawProgramme(group, wide - programmeIndent.length);
      if (index && (previousHasDetails || body.length)) gap();
      for (const row of [...heading, ...body]) lines.push(row ? programmeIndent + row : '');
      previousHasDetails = body.length > 0;
    }
    gap();
  };
  for (const figure of horizonFigures(data, sessions)) {
    const members = groups.filter((group) => !assigned.has(group.programme) && (figure.horizon.programmes || []).includes(group.programme));
    for (const group of members) assigned.add(group.programme);
    horizonHeading(lines, c, wide, figure);
    drawGroup(members);
  }
  const other = groups.filter((group) => !assigned.has(group.programme));
  if (other.length) {
    lines.push(`  ${c('OTHER PROGRAMMES', 'bold')}`);
    drawGroup(other);
  }

  const rows = maintenanceRows(data);
  if (rows.length) { maintenanceLines(lines, c, wide, rows); gap(); }
  const merges = mergeDeployRows(data);
  if (merges.length) { mergeDeployLines(lines, c, wide, merges); gap(); }
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
