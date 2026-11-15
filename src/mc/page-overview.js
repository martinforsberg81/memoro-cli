/**
 * The page's overview: what a person reads first, within a budget of rows (docs/technical/mc-ui.md, The overview).
 *
 * In order: the compact header (at most two rows), DESK, the warnings, HORIZONS, IN FLIGHT (one row per session),
 * NEEDS ATTENTION (one row per item that waits on a person's eye), and one row for each merge and deploy that is queued or
 * running. The operational panels, the hero frame and the pipeline are the operations view (`o`), drawn by page-render.js.
 *
 * `overviewLines` draws from `data` alone — what `mc --json` prints — and folds rows until the page is at most
 * `OVERVIEW_ROWS` lines. The order of the folds, and what is never folded, is `FOLDS` below; every fold row says how many
 * rows it holds and that `a` shows them, so a row never disappears without a count. `a` (`expand`) draws no budget.
 *
 * Like page-horizons.js, this module imports nothing from page-render.js, which imports it.
 */
import { DESKS } from './session-owner.js';
import { mergeFailureSummary } from './merge-red.js';
import { ageWords } from './page-cache.js';
import { deskLines } from './page-desk.js';
import { clipCell, kindTone, stateTone } from './page-grid.js';
import { horizonsFoldable, horizonsLines } from './page-horizons.js';
import { detail } from './page-operations.js';
import { attentionGoals, notArchived } from './page-programmes.js';
import { sessionGoal } from './page-activity.js';
import { clip, width } from './status-render.js';

/** The overview is at most this many lines at every width the page draws; the menu's key block and prompt are not counted. */
export const OVERVIEW_ROWS = 50;

/** Needs attention keeps this many rows before it folds the rest. */
export const ATTENTION_KEPT = 5;

/**
 * The folds, in the order they are made while the page is over the budget: In flight's runner-session rows from the
 * last, the programme rows under `Serving no horizon` from the last, Needs attention's rows beyond `ATTENTION_KEPT`, and
 * the programme rows of the horizons from the last horizon up. Never folded: the header, DESK, the warnings, the merge
 * and deploy rows, the section headings, the horizon titles, `▸ n with nothing under way`, the desk sessions and the
 * interactive sessions.
 */
export const FOLDS = Object.freeze(['sessions', 'none', 'attention', 'horizons']);

const one = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();
const money = (n) => (n == null ? null : `≈$${n < 10 ? n.toFixed(2) : Math.round(n)}`);
const finished = (goal) => ['done', 'dropped'].includes(goal.stage);

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
  return rows.slice(0, 2).map((row, index) => {
    const parts = row.flatMap((part, i) => (i ? [{ text: ' · ', styles: ['grey'] }, part] : [part]));
    const left = painted(c, parts);
    if (index) return `  ${left}`;
    return `  ${left}${' '.repeat(Math.max(2, wide - 2 - width(painted(c, parts).replace(/\u001b\[[0-9;]*m/gu, '')) - action.length))}${c(action, 'cyan')}`;
  });
}

/* ---------------------------------------------------------------- In flight */

/** A session's identity, so the same one seen twice is drawn once: the desk's and a programme's copies of a plan session. */
const identity = (session) => JSON.stringify([session.verb || session.kind || '', session.name || '', session.pid ?? '', session.started ?? '']);

const RUNNER_KINDS = ['plan', 'build', 'review', 'mend'];

/**
 * Every session at work, as rows: `desk` (the sessions of every desk kind, by name: martin, manager, helper, and a kind
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

/** `IN FLIGHT`'s rows, laid out in columns of the width the rows themselves need. */
function flightRow(c, wide, row, columns) {
  const mark = { text: '●', styles: kindTone(row.kind) };
  const head = [
    mark, { text: ' ' },
    { text: row.kind.padEnd(columns.kind), styles: kindTone(row.kind) }, { text: '  ' },
    { text: clipCell(row.on, columns.on).padEnd(columns.on), styles: ['bold'] },
  ];
  const tail = [
    { text: ageWords(row.age).padEnd(columns.age), styles: ['grey'] },
    row.who ? { text: row.who, styles: ['grey'] } : null,
    row.state ? { text: row.state, styles: stateTone(row.stateName) } : null,
  ].filter(Boolean);
  const out = [...head];
  let used = 4 + out.reduce((n, part) => n + width(part.text), 0);
  for (const part of tail) {
    if (used + 2 + width(part.text.trimEnd()) > wide) break;
    out.push({ text: '  ' }, part);
    used += 2 + width(part.text);
  }
  return `    ${painted(c, out).replace(/ +$/u, '')}`;
}

function flightLines(lines, c, wide, rows, folded) {
  const all = [...rows.desk, ...rows.interactive, ...rows.runner];
  const count = all.length;
  lines.push(`  ${c('IN FLIGHT', 'bold', 'cyan')}  ${c(count ? `${count} session${count === 1 ? '' : 's'}` : 'nothing running', 'grey')}`);
  if (!count) return;
  const columns = {
    kind: Math.max(...all.map((row) => row.kind.length)),
    on: Math.min(Math.max(...all.map((row) => row.on.length)), Math.max(12, Math.floor(wide / 3))),
    age: Math.max(...all.map((row) => ageWords(row.age).length)),
  };
  const drawn = [...rows.desk, ...rows.interactive, ...rows.runner.slice(0, rows.runner.length - folded)];
  for (const row of drawn) lines.push(flightRow(c, wide, row, columns));
  if (folded) lines.push(`    ${c(`▸ ${folded} more session${folded === 1 ? '' : 's'} — a shows ${folded === 1 ? 'it' : 'them'}`, 'grey')}`);
}

/* --------------------------------------------------------- Needs attention */

/**
 * What needs a person's eye, as items `{ key, label, text, tone }` in the order of the page: a malformed goal, a held
 * goal, a blocked goal, a goal stopped for no progress, a failed merge, a finished goal not archived, a Martin-waiting
 * main-red file or deploy repair, a failed deploy preparation, a failed deploy attempt and a stray area. A goal waiting
 * on Martin with a question is on DESK through its desk item and is not repeated here. Each goal is one item.
 */
export function attentionItems(data, sessions = data.runner?.sessions || []) {
  const items = [];
  const groups = data.programmes?.programmes || [];
  const add = (key, label, text, tone = ['red']) => items.push({ key, label, text: one(text), tone });
  const merges = new Map();

  // A failed merge is one item however it is told: by the goal's pull request or by the merger's own red list.
  const mergeKey = (repo, number) => `merge:${repo || 'unknown'}#${number}`;
  for (const group of groups) {
    for (const goal of group.goals || []) {
      for (const pr of goal.prs || []) {
        if (pr.merge_red) merges.set(mergeKey(pr.repo, pr.number), { label: `${group.programme}/${goal.name}`, text: `merge failed — ${pr.repo || 'unknown'}#${pr.number} · ${mergeFailureSummary(pr.merge_red)}` });
      }
    }
  }
  for (const item of data.merges?.red?.items || []) {
    const prs = item.prs?.length ? item.prs : [{ number: item.pr }];
    const keys = prs.map((pr) => mergeKey(item.repo, pr.number));
    if (keys.every((key) => merges.has(key))) continue;
    const refs = prs.map((pr) => `${item.repo || 'unknown'}#${pr.number}`).join(', ');
    merges.set(keys[0], { label: item.repo || 'merge', text: `merge failed — ${refs} · ${mergeFailureSummary(item.said || item.reason)}` });
  }

  const goalKeys = new Set();
  const goalItem = (group, goal, text) => {
    const key = `goal:${group.programme}/${goal.name}`;
    if (goalKeys.has(key)) return;
    goalKeys.add(key);
    add(key, `${group.programme}/${goal.name}`, text);
  };
  const malformed = new Set(groups.flatMap((group) => attentionGoals(group, sessions).filter((goal) => goal.problems?.length).map((goal) => `${group.programme}/${goal.name}`)));
  for (const group of groups) {
    for (const goal of group.goals || []) {
      if (malformed.has(`${group.programme}/${goal.name}`)) goalItem(group, goal, `GOAL.json: ${goal.problems[0]}`);
    }
  }
  for (const group of groups) {
    for (const goal of group.goals || []) {
      if (finished(goal) || !goal.hold) continue;
      goalItem(group, goal, `held by ${goal.hold.by ?? '—'} since ${goal.hold.at ?? '—'} — ${goal.hold.reason ?? '—'}`);
    }
  }
  for (const group of groups) {
    for (const goal of group.goals || []) {
      if (finished(goal) || goal.status !== 'blocked') continue;
      // A blocked merge is the failed merge's own item, which names the goal.
      if (goal.stage === 'merge' && (goal.prs || []).some((pr) => pr.merge_red)) continue;
      const reason = goal.question || goal.last?.comment || 'a mend session resolves the obstacle';
      goalItem(group, goal, `blocked — ${goal.stage === 'merge' ? mergeFailureSummary(reason) : reason}`);
    }
  }
  for (const group of groups) {
    for (const goal of group.goals || []) {
      if (finished(goal) || goal.status !== 'Martin' || !/^no progress:/u.test(goal.last?.comment || '')) continue;
      goalItem(group, goal, `stopped — ${goal.last.comment}`);
    }
  }
  for (const [key, merge] of merges) add(key, merge.label, merge.text);
  for (const group of groups) {
    for (const goal of attentionGoals(group, sessions)) {
      if (goal.problems?.length) continue;
      const reason = notArchived(goal);
      if (reason) goalItem(group, goal, reason);
    }
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
    const facts = stray.kind === 'directory' || !stray.kind
      ? `not an area mc knows · checkout ${stray.checkout ? `yes · ${stray.uncommitted} uncommitted` : 'no'}`
      : stray.kind === 'tmux' ? 'not an area mc knows · tmux session'
        : `not an area mc knows · ${stray.verb ? `mc ${stray.verb}` : 'a session'} with no programme${stray.pid ? ` · pid ${stray.pid}` : ''}`;
    add(`stray:${stray.name}`, stray.name, facts, ['yellow']);
  }
  return items;
}

function attentionLines(lines, c, wide, items, folded) {
  if (!items.length) return;
  lines.push(`  ${c('NEEDS ATTENTION', 'bold', 'cyan')}  ${c(String(items.length), 'grey')}`);
  for (const item of items.slice(0, items.length - folded)) {
    const label = clipCell(item.label, Math.max(12, Math.floor(wide / 3)));
    const room = wide - 4 - width(label) - 2;
    lines.push(`    ${c(label, 'bold')}  ${c(clipCell(item.text, Math.max(8, room)), ...item.tone)}`);
  }
  if (folded) lines.push(`    ${c(`▸ ${folded} more need${folded === 1 ? 's' : ''} attention — a shows ${folded === 1 ? 'it' : 'them'}`, 'grey')}`);
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
    lines.push(`  ${c(row.label, 'bold', ...row.tone)}  ${c(clipCell(row.text, Math.max(8, wide - 4 - row.label.length)), 'bold')}`);
  }
}

/* ----------------------------------------------------------------- overview */

/**
 * The overview, as lines. `expand` (`a`) draws every row and folds nothing; otherwise rows are folded, in the order of
 * `FOLDS`, then the blank rows between sections, until the page is at most `OVERVIEW_ROWS` lines or nothing is left. `version` is mc's.
 * `programmes(lines)` draws PROGRAMMES where HORIZONS would be, for a page from before HORIZONS.
 */
export function overviewLines(c, wide, data, { version = '', expand = false, programmes = null } = {}) {
  const sessions = data.runner?.sessions || [];
  const flight = flightRows(data);
  const attention = attentionItems(data, sessions);
  const merges = mergeDeployRows(data);
  const foldable = {
    sessions: flight.runner.length,
    none: horizonsFoldable(data, { sessions }).none,
    attention: Math.max(0, attention.length - ATTENTION_KEPT),
    horizons: horizonsFoldable(data, { sessions }).horizons,
  };

  const draw = (fold, tight = false) => {
    const lines = headerRows(c, wide, data, version);
    lines.push('');
    const before = lines.length;
    deskLines(lines, c, wide, data.desk);
    if (lines.length > before) lines.push('');
    warningLines(lines, c, wide, data);
    const gap = lines.length;
    if (data.horizons) horizonsLines(lines, c, wide, data, { expand, sessions, fold });
    else if (programmes) programmes(lines);
    if (lines.length === gap || lines.at(-1) !== '') lines.push('');
    flightLines(lines, c, wide, flight, fold.sessions);
    lines.push('');
    if (attention.length) { attentionLines(lines, c, wide, attention, fold.attention); lines.push(''); }
    if (merges.length) { mergeDeployLines(lines, c, wide, merges); lines.push(''); }
    if (lines.at(-1) === '') lines.pop();
    // Packed: the blank rows between sections go, the one under the header stays.
    const first = lines.indexOf('');
    return tight ? lines.filter((row, at) => row !== '' || at === first) : lines;
  };

  const fold = { sessions: 0, none: 0, attention: 0, horizons: 0 };
  let lines = draw(fold);
  if (expand) return lines;
  for (const name of FOLDS) {
    // A fold of one row is a fold row in its place: no shorter. It is made only on the way to a longer one.
    while (lines.length > OVERVIEW_ROWS && fold[name] < foldable[name]) {
      fold[name] += 1;
      lines = draw(fold);
    }
    if (fold[name] === 1) { fold[name] = 0; lines = draw(fold); }
  }
  // Everything foldable is folded and the page is still long: the blank rows between its sections give way last.
  return lines.length > OVERVIEW_ROWS ? draw(fold, true) : lines;
}
