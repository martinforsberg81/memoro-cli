/**
 * How the page looks: the sections `page-collect.js` gathers, drawn as
 * lines.
 *
 * The rules the drawing keeps:
 *
 *   - **A number where a number is the answer**, a line only where the
 *     identity matters — and every count names the verb that expands it, on
 *     the right of its own heading.
 *   - **Width-aware.** `stdout.columns` clamped to 60–160 through `width`,
 *     `pad` and `clip` from status-render.js, which are escape-aware. Nothing
 *     here is padded to a number somebody typed once.
 *   - **Colour carries state, never decoration**: green is work that moves by
 *     itself (ready, running, landing), yellow waits — on a time, a deploy,
 *     another phase or a measurement (waiting, unmet), red waits on a person
 *     (blocked, failed, invalid), grey is quiet. Only on a TTY, and
 *     only when `NO_COLOR` is unset or empty — the convention is that any
 *     non-empty value turns colour off.
 *
 * The palette is a table rather than a habit, so a kind and a status look the
 * same wherever they are printed: `KIND_TONE` for what a row is (plan, build,
 * review, a merge round, a goal) and `STATE_TONE` for where it
 * stands, both in page-grid.js, shared by the programme and operational views.
 * Everything else is structure — cyan headings, grey for the
 * bookkeeping, and the terminal's own foreground for the text a person is
 * reading, with `bold` on the name a row is about.
 *
 * Two colours this file does not use, and will not: `dim` and `white`. `dim
 * grey` is `ESC[2m` over `ESC[90m`, two steps away from the foreground, and it
 * drew the repository of all 41 rows at or below the background of
 * Martin's terminal — a cell nobody could read is not a quiet cell. `white` is
 * `ESC[37m`, one fixed colour a theme never chose: on a light theme it is the
 * wrong end of the scale, on a dark one it is dimmer than the text beside it.
 * A part with no styles at all is returned untouched by `paint` and `painter`,
 * and that — whatever the person set their terminal to — is what primary text
 * is here. Where something must recede it does so by position, by the `·`
 * glyph, or by plain `grey`, which is one step and not two.
 *
 * Every escape is added **after** `clip` and `pad` have decided the width:
 * `paint` measures the plain text, and only paints when it fits, so a
 * coloured row is exactly as wide as its plain twin and no clip ever cuts an
 * escape sequence in half.
 *
 * Lines rather than one string, so a test can look
 * at a row without splitting a page apart again.
 */
import { toolShortName } from '../adapters/index.js';
import { activityLines, sessionGoal } from './page-activity.js';
import { deployLines, devLines, detail, frameEnd, frameTop, mergesLines, panelHeading, panelEnd } from './page-operations.js';
import { programmeTreeLines } from './page-programmes.js';
import { programmeFacts, programmeHeading } from './page-horizons.js';
import { flightRows, headerRows, maintenanceView, outsidePrs, overviewLines, ownerWords, warningLines } from './page-overview.js';
import { deskLines } from './page-desk.js';
import { ageWords } from './page-cache.js';
import { drainLine, stopLine } from './run-control.js';
import {
  KIND_TONE, PR_QUIET_S, PR_TONE, STAGE_TONE, STATE_TONE, duration, kindTone,
} from './page-grid.js';
import { clip, pad, painter, width } from './status-render.js';

export { KIND_TONE, PR_QUIET_S, STATE_TONE, duration };

/** Same glyphs as the old board, so nothing new has to be learnt. */
const MARK = { running: '●', waiting: '◆', stopped: '■', quiet: '·', red: '✗' };

/** How long a quota answer stays worth looking at. */
const QUOTA_FRESH_MS = 6 * 60 * 60 * 1000;

/** Colour is a terminal's, and `NO_COLOR` with any value at all turns it off. */
export function colourFor(stream = process.stdout, env = process.env) {
  if (!stream || !stream.isTTY) return false;
  const flag = env.NO_COLOR;
  return flag === undefined || flag === '';
}

export function columnsFor(stream = process.stdout) {
  return Math.max(60, Math.min(Number(stream?.columns) || 100, 160));
}

/** `08-29 12:39Z` — an ISO instant with the year and the seconds taken off. */
export function when(ts) {
  return String(ts || '').replace(/^\d{4}-/u, '').replace(/:\d{2}Z$/u, 'Z').replace('T', ' ');
}

const money = (n) => (n == null ? null : `≈$${n < 10 ? n.toFixed(2) : Math.round(n)}`);
const one = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();

/* ----------------------------------------------------------------- palette */

/**
 * A run of parts, each with its own colour, painted only once the plain text
 * is known to fit. Measuring first is the whole discipline: `clip` counts
 * columns but slices bytes, so a string that already carries escapes cannot
 * be cut safely. When the run is too long for the room it has, the plain text
 * is clipped and the whole thing goes grey — a truncated line is bookkeeping.
 */
function paint(c, parts, space = Infinity) {
  const items = parts.filter((part) => part && part.text !== '' && part.text != null);
  const plain = items.map((part) => part.text).join('');
  if (plain.length > space) return c(clip(plain, space), 'grey');
  return items.map((part) => (part.styles?.length ? c(part.text, ...part.styles) : part.text)).join('');
}

/**
 * The parts that fit, dropping the tail rather than greying the whole run.
 *
 * `paint` clips and greys when a run is too long, which is right for a line
 * whose whole text is one statement. It is wrong for a line built as *the
 * answer, then what is behind it*: there the tail is droppable and the head is
 * not, so a narrow terminal should lose the last part rather than the colour of
 * the first. Each droppable part carries its own leading separator, so nothing
 * is ever left dangling at the end of a line.
 */
function fitting(parts, space) {
  const out = [];
  let used = 0;
  for (const part of parts) {
    const text = String(part?.text ?? '');
    if (!text) continue;
    if (used + text.length > space) break;
    out.push(part);
    used += text.length;
  }
  return out;
}

/** The same parts with a separator of its own between them. */
function between(parts, separator, styles = ['grey']) {
  const items = parts.filter((part) => part && part.text);
  return items.flatMap((part, index) => (index ? [{ text: separator, styles }, part] : [part]));
}

/**
 * The same parts with the separator riding on the front of each but the first,
 * which is the shape `fitting` wants: it drops whole parts from the end, and a
 * separator that is a part of its own is what would be left dangling there.
 */
function trailing(parts, separator = ' · ') {
  const items = parts.filter((part) => part && part.text);
  return items.map((part, index) => (index ? { ...part, text: `${separator}${part.text}` } : part));
}

/* ------------------------------------------------------------------ pieces */

/** One line of prose, indented and cut to the terminal. */
function say(lines, c, wide, indent, text, tone = ['grey']) {
  const styles = [].concat(tone);
  lines.push(`${' '.repeat(indent)}${c(clip(one(text), wide - indent), ...styles)}`);
}

/**
 * A row: a left part that keeps its width, a middle that gives way, and a
 * right that is dropped altogether when the terminal is too narrow to hold
 * both it and something readable in the middle.
 *
 * `left` and `right` arrive painted — they are made of pieces with colours of
 * their own — and only the middle is coloured here, after it is clipped.
 */
function row(c, wide, left, middle, right, tone = null) {
  const tail = right ? `  ${right}` : '';
  const room = wide - width(left) - width(tail);
  if (room < 12 && tail) return row(c, wide, left, middle, null, tone);
  const space = Math.max(8, room);
  const text = clip(one(middle), space);
  const body = pad(tone ? c(text, ...[].concat(tone)) : text, space);
  return `${left}${body}${tail}`.replace(/[ ]+$/u, '');
}

/* --------------------------------------------------------------- sections */

/** Shared runner diagnostics live below MC, without a second session listing. */
function runnerLines(lines, c, wide, runner, expand) {
  const now = runner;
  const alive = Boolean(now.process?.alive);
  const sessions = now.sessions || [];
  const flight = sessions.length;
  const total = now.setting?.lanes ?? now.lanes?.length ?? flight;
  say(lines, c, wide, 4, `runner ${alive ? 'running' : 'not running'} · ${flight}/${total} lanes${!alive ? ' · mc run starts it' : ''}`,
    alive ? ['grey'] : ['yellow']);
  // Stopping, in the words `mc run stop` prints (run-control.js `stopLine`):
  // since when, the sessions it still waits on, how many lanes have left — and
  // the one thing to type to have a runner running again without waiting.
  // A STOP with no runner alive is a leftover the next start removes.
  if (now.stop) {
    const stopping = alive || flight;
    const reading = stopping
      ? stopLine({
        stopping: true,
        stop_requested: now.stop_requested?.at ?? null,
        stop_since_seconds: now.stop_requested?.age_seconds ?? null,
        inFlight: sessions.map((session) => ({
          name: session.goal ?? session.name, lane: `${session.repo}#${(session.lane || 0) + 1}`, elapsed_seconds: session.elapsed_seconds,
        })),
        lanes: total || null,
      })
      : null;
    detail(lines, c, wide, 4, `${MARK.stopped} ${stopping ? reading : 'STOP left behind — the next start removes it'}`, ['red']);
    if (stopping) say(lines, c, wide, 4, 'start takes over now — a new runner on every lane, this one only finishes its sessions', 'grey');
  }
  for (const line of now.stale || []) detail(lines, c, wide, 4, `${MARK.quiet} stale: ${line}`, ['red']);
  for (const failure of now.github || []) detail(lines, c, wide, 4, githubLine(failure), ['yellow']);
  // disk.json is historical. diskSummary is the only current disk reading.
  pressureLines(lines, c, wide, now.pressure);
  if (now.memory?.line && alive) detail(lines, c, wide, 4, now.memory.line, ['yellow']);
  if (expand && now.day) dayLine(lines, c, wide, now.day);
  else if (now.day) say(lines, c, wide, 4, `24 h · build ${now.day.by_kind?.build?.sessions || 0} · review ${now.day.by_kind?.review?.sessions || 0} · plan ${now.day.by_kind?.plan?.sessions || 0}`);
  if (now.quota?.count) {
    // Yellow while a refusal is recent enough to still be the reason the
    // runner is idle; older than that it is history, and history is grey.
    const at = Date.parse(now.quota.last);
    const recent = Number.isFinite(at) && now.at_ms - at < QUOTA_FRESH_MS;
    say(lines, c, wide, 4, `quota: ${now.quota.count} answer(s) in the last 24 h, last ${when(now.quota.last)}`,
      recent ? 'yellow' : 'grey');
  }
}

/**
 * One repository the round cannot ask GitHub about: since when, why, and the
 * command that fixes it — `security unlock-keychain` for a locked keychain,
 * `gh auth login` for a bad token (github-backoff.js). Yellow, because a
 * person has to act: until then nothing starts in that repository. The
 * clock alone inside a day, the date with it past one.
 */
/** The disk policy's lines, from `diskSummary`: one grey line while healthy. */
function pressureLines(lines, c, wide, pressure) {
  if (!pressure?.lines?.length) return;
  if (pressure.status === 'healthy') { for (const line of pressure.lines) say(lines, c, wide, 4, line); return; }
  for (const line of pressure.lines) detail(lines, c, wide, 4, line, [pressure.status === 'unknown' ? 'red' : 'yellow']);
}

export function githubLine(failure) {
  const since = failure.since_seconds != null && failure.since_seconds < 86_400
    ? when(failure.since).replace(/^\d{2}-\d{2} /u, '')
    : when(failure.since);
  const why = failure.label || failure.error || 'gh pr list failed';
  return `GitHub unreachable for ${failure.repo} since ${since} (${why})${failure.fix ? ` — run: ${failure.fix}` : ''}`;
}

/**
 * The day behind the lanes, one line: per session kind, how many and where
 * they left their work — `build 53 (40 built, 8 queued, 2 blocked) · review
 * 15 (15 queued)` (`outcomeOf`, page-collect.js) — then what else the runner
 * logged, and what it all cost at list price.
 *
 * Grey is the bookkeeping and the colour is the outcome that needs a look:
 * red for what waits on somebody — back red from the merger, blocked, failed
 * — and yellow for a session that timed out. An outcome with no
 * sessions is not drawn at all, and `plan` only once there has been one: a
 * `failed 0` is the quietest thing on the row, and painting it red would make
 * the row cry wolf every day.
 */
const DAY_OUTCOMES = [
  ['merged', 'merged', ['grey']],
  ['queued', 'queued', ['grey']],
  ['built', 'built', ['grey']],
  ['open', 'open', ['grey']],
  // Back from the merger, blocked on a person, failed: each waits on somebody.
  ['red', 'red', ['red']],
  ['blocked', 'blocked', ['red']],
  ['failed', 'failed', ['red']],
  ['timeout', 'timed out', ['yellow']],
];

function dayLine(lines, c, wide, day) {
  const cost = money(day.cost);
  const kinds = day.by_kind || {};
  const dot = { text: ' · ', styles: ['grey'] };
  const parts = [{ text: '24 h', styles: ['grey'] }];
  // `plan` includes historical sessions and the focused next-draft assignment.
  // A kind that is not always running (repair, finish, mend, plan) prints only when the day has one.
  for (const kind of ['build', 'review', 'repair', 'finish', 'mend', 'plan']) {
    const counted = kinds[kind];
    if (!counted || (['repair', 'finish', 'mend', 'plan'].includes(kind) && !counted.sessions)) continue;
    parts.push(dot, { text: `${kind} ${counted.sessions}`, styles: kindTone(kind) });
    const outcomes = DAY_OUTCOMES.filter(([key]) => counted[key]);
    outcomes.forEach(([key, label, styles], index) => {
      parts.push({ text: `${index ? ', ' : ' ('}${counted[key]} ${label}${index === outcomes.length - 1 ? ')' : ''}`, styles });
    });
  }
  // What is not a session, and the cost, give way on a narrow terminal — the
  // cost's basis first, then the cost, then `other` — so the counts keep their
  // colours rather than being clipped grey.
  const room = wide - 4;
  const used = () => parts.reduce((n, part) => n + part.text.length, 0);
  const other = kinds.other ? `other ${kinds.other}` : null;
  const priced = [cost && `${cost} list (${day.model}, ${day.prices_dated})`, cost && `${cost} list`].filter(Boolean);
  const tail = [
    ...priced.map((text) => [other, text]),
    [other],
  ].map((group) => group.filter(Boolean)).find((group) => used() + group.reduce((n, text) => n + 3 + text.length, 0) <= room) || [];
  for (const text of tail) parts.push(dot, { text, styles: ['grey'] });
  lines.push(`    ${paint(c, parts, room)}`);
}

/** A painted cell, padded to its column with spaces that carry no colour. */
function cell(c, text, columns, styles) {
  return `${styles?.length ? c(text, ...styles) : text}${' '.repeat(Math.max(0, columns - text.length))}`;
}

/** `#13265` and one space: the column a PULL REQUESTS row's number is drawn in. */
const PR_NUMBER = 7;
/** The repository's cell on a PULL REQUESTS row. */
const LANE_REPO = 11;


/** Past this, the age is the thing on the row worth looking at. */
const STALE_SESSION_S = 24 * 60 * 60;
const ageTone = (seconds) => (seconds != null && seconds >= STALE_SESSION_S ? ['yellow'] : ['grey']);

/**
 * MERGE's loose PR group — open pull requests no programme or session draws.
 *
 * A goal's pull requests are on its row in PROGRAMMES, and the merger's are in
 * MERGES. What is left is what the page could not
 * see at all before: a plan session's, one opened from a terminal, and one
 * nobody holds any more — the last with the waiting mark in yellow, because it
 * is a person's and nobody knows it (Martin, 2026-10-09). The summary counts
 * only this group; the standalone `mc prs` still lists every open PR.
 */
function prsLines(lines, c, wide, prs, sessionPrs = []) {
  if (!prs) return;
  const items = outsidePrs(prs, sessionPrs);
  if (!items.length) return;
  const counts = {};
  for (const pr of items) counts[pr.owner?.kind || 'none'] = (counts[pr.owner?.kind || 'none'] || 0) + 1;
  const words = [
    `${items.length} open`,
    counts.plan ? `${counts.plan} plan` : '',
    counts.workarea ? `${counts.workarea} in a workarea` : '',
    counts.worktree ? `${counts.worktree} checked out elsewhere` : '',
    counts.none ? `${counts.none} nobody's` : '',
    prs.age_seconds >= 15 * 60 ? `as of ${ageWords(prs.age_seconds)} ago` : '',
  ].filter(Boolean);
  detail(lines, c, wide, 4, 'PRs outside goals', ['bold']);
  detail(lines, c, wide, 6, `${words.join(' · ')} · mc prs`);
  for (const pr of items) lines.push(`  ${prRow(c, wide - 2, pr, ownerWords(pr.owner || { kind: 'none' }))}`);
}

/**
 * A pull request as a row of its own: the mark, the repository, the number,
 * the title, and on the right whose it is and how long nothing has happened.
 * The waiting mark and yellow are for the one that is nobody's.
 */
function prRow(c, wide, pr, whose) {
  const nobody = pr.owner?.kind === 'none';
  const mark = pr.merging ? c(MARK.running, 'green') : c(nobody ? MARK.waiting : MARK.quiet, nobody ? 'yellow' : 'grey');
  const where = pad(clip(pr.repo || '—', LANE_REPO - 1), LANE_REPO);
  const left = `  ${mark} ${c(where, 'grey')} ${cell(c, `#${pr.number}`, PR_NUMBER, PR_TONE)} `;
  const quiet = pr.merging
    ? { text: ` · ${pr.merging === 'landing' ? 'landing now' : 'queued for merge'}`, styles: ['green'] }
    : { text: pr.quiet_seconds == null ? '' : ` · quiet ${ageWords(pr.quiet_seconds)}`, styles: pr.quiet_seconds >= PR_QUIET_S ? ['yellow'] : ['grey'] };
  const right = paint(c, [{ text: whose, styles: nobody ? ['yellow'] : ['grey'] }, quiet]);
  return row(c, wide, left, `${pr.draft ? 'draft: ' : ''}${pr.title || pr.branch || ''}`, right);
}

/**
 * `mc prs` — every open pull request, grouped by whose it is: a plan
 * session's, a workarea's, a folder elsewhere, or nobody's. The page draws
 * only what PROGRAMMES and MERGES do not; this draws all of them.
 */
export function renderPrsLines(prs, { columns = 100, colour = false } = {}) {
  const paintText = painter(colour);
  // Secondary information must remain readable on dark terminal palettes.
  const c = (text, ...styles) => paintText(text, ...styles.map((style) => style === 'grey' ? 'white' : style));
  const wide = Math.max(60, Math.min(columns, 160));
  const lines = [''];
  const items = prs?.items || [];
  const groups = [
    ['PLAN SESSIONS', (pr) => pr.owner.kind === 'plan', (pr) => ownerWords(pr.owner)],
    ['WORKAREAS', (pr) => pr.owner.kind === 'workarea', (pr) => ownerWords(pr.owner)],
    ['ELSEWHERE', (pr) => pr.owner.kind === 'worktree', (pr) => ownerWords(pr.owner)],
    ['NOBODY\'S', (pr) => pr.owner.kind === 'none', () => 'no worktree holds it'],
  ];
  const age = prs?.age_seconds;
  // The list's own frame, its top rule alone; each group is a frame under it.
  lines.push(frameTop(c, wide, 'PULL REQUESTS', prs?.fetched
    ? `${items.length} open${age != null && age >= 15 * 60 ? ` · as of ${ageWords(age)} ago` : ''}`
    : 'not asked yet'));
  for (const [title, mine, whose] of groups) {
    const own = items.filter(mine);
    if (!own.length) continue;
    lines.push('');
    lines.push(frameTop(c, wide, title, `${own.length}`));
    // Whose it is leads here — it is what the list is sorted by — and the
    // title is what gives way; the page's own rows put the title first.
    const width = Math.min(40, Math.max(...own.map((pr) => whose(pr).length)));
    for (const pr of own) {
      const nobody = pr.owner.kind === 'none';
      const mark = pr.merging ? c(MARK.running, 'green')
        : pr.merge_red ? c(MARK.red, 'red', 'bold') : c(nobody ? MARK.waiting : MARK.quiet, nobody ? 'yellow' : 'grey');
      const where = pad(clip(pr.repo || '—', LANE_REPO - 1), LANE_REPO);
      const left = `    ${mark} ${c(where, 'grey')} ${cell(c, `#${pr.number}`, PR_NUMBER, PR_TONE)} `
        + `${cell(c, clip(whose(pr), width), width, nobody ? ['yellow'] : [])}  `;
      const right = pr.merging
        ? paint(c, [{ text: pr.merging === 'landing' ? 'landing now' : 'queued for merge', styles: ['green'] }])
        : pr.merge_red ? paint(c, [{ text: 'red from the merger', styles: ['red', 'bold'] }])
        : paint(c, [{ text: pr.quiet_seconds == null ? '' : `quiet ${ageWords(pr.quiet_seconds)}`, styles: pr.quiet_seconds >= PR_QUIET_S ? ['yellow'] : ['grey'] }]);
      lines.push(row(c, wide, left, `${pr.draft ? 'draft: ' : ''}${pr.title || pr.branch || ''}`, right || null));
    }
    panelEnd(lines, c, wide);
  }
  lines.push('');
  return lines;
}

/**
 * A programme's open plan sessions by provider, `claude 1 · codex 2`, or ''
 * when it has none. The heading draws it after `plan`; `mc programs list`
 * says it in the same words.
 */
export function planSessionWords(group) {
  return Object.entries(planProviders(group)).map(([provider, n]) => `${provider} ${n}`).join(' · ');
}

/** The same as data: `{ claude: 1, codex: 2 }`, providers by name. */
export function planProviders(group) {
  const providers = {};
  for (const item of group.planning_sessions || (group.planning ? [group.planning] : [])) {
    const provider = toolShortName(item.tool) || item.tool || 'unknown';
    providers[provider] = (providers[provider] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(providers).sort(([a], [b]) => a.localeCompare(b)));
}

/** `done 13 · blocked 5` — states by count, biggest first, as the PROGRAMMES heading draws them. */
export function statusRollup(statuses = {}) {
  return Object.entries(statuses).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function programmeLine(c, wide, group, expand, numbered = false) {
  const metadata = expand ? ` · ${group.goals?.length || 0} goal${group.goals?.length === 1 ? '' : 's'}${group.proposals ? ` · ${group.proposals} proposal${group.proposals === 1 ? '' : 's'}` : ''}` : '';
  // The goals done or dropped and still under `goals/`: the count `a` shows.
  const done = group.finished ?? (group.goals || []).filter((goal) => ['done', 'dropped'].includes(goal.stage)).length;
  const facts = `${group.priority ? `priority ${group.priority}` : ''}${done ? `${group.priority ? ' · ' : ''}${done} done` : ''}${group.record_invalid ? `${group.priority || done ? ' · ' : ''}record invalid` : ''}${metadata}`.replace(/^ · /u, '');
  return frameTop(c, wide, `${numbered && group.number != null ? `${group.number} ` : ''}${group.programme}`, facts);
}

/**
 * One programme's frame in the overview: its heading (number, horizon, phase), then its plan and programme sessions and
 * its goals by phase, then the border. A programme with nothing to draw is its heading row alone.
 */
function programmeFrame(lines, c, wide, data, group, expand, runnerSessions) {
  const body = programmeBody(c, wide, group, expand, runnerSessions);
  lines.push(programmeHeading(c, wide, data, group, programmeFacts(group, runnerSessions)));
  if (!body.length) return;
  lines.push(...body);
  panelEnd(lines, c, wide);
}

/** What a programme's block holds under its heading: its plan and programme sessions, then its goals by phase. */
function programmeBody(c, wide, group, expand, runnerSessions) {
  return [
    ...(group.planning_sessions || []).flatMap((session) => activityLines(c, wide, { ...session, kind: 'plan' }, { indent: 4, expand })),
    ...(group.sessions || []).flatMap((session) => activityLines(c, wide, session, { indent: 4, expand })),
    ...programmeTreeLines(c, wide, group, { expand, sessions: runnerSessions }),
  ];
}

/**
 * One programme's block alone — the programme view: its heading with its number, then the body and the border.
 * A programme with nothing to draw is its heading row and a blank line.
 */
function programmeViewLines(lines, c, wide, group, expand, runnerSessions) {
  const body = programmeBody(c, wide, group, expand, runnerSessions);
  lines.push(programmeLine(c, wide, group, expand, true));
  if (!body.length) { lines.push(''); return; }
  lines.push(...body);
  panelEnd(lines, c, wide);
}

/**
 * MC — mc itself, in one line: how long the runner has been up and on which
 * commit, and whether there is newer code than it is running.
 *
 * Three states, and only one of them asks for anything. *Update available* is
 * yellow and names the verb, because `origin/main` has moved past the commit
 * the runner started on and nothing will change that but `mc run --update`.
 * *Draining* is green: somebody has asked, the runner hands over when its last
 * step in flight is done, and the line is `mc run --update`'s own drain line
 * (run-control.js `drainLine`) — since when, and which lanes it waits on and
 * for how long — so a handover that is not happening can be seen not
 * happening, and why. Otherwise it is up to date, and grey.
 *
 * For the step's length after an update two runners are alive: the new one,
 * and the one it replaced finishing what it held. The line names both —
 * `pid N on <commit> · pid M finishing 2 steps (a, b)`.
 *
 * A merger or repo watcher whose commit is not the checkout's is named in
 * yellow — `merger pid N on <commit> · checkout <head>` — until it has left
 * for the new code.
 *
 * It replaced the line about how old the PR cache is, which was the last thing
 * on the page every time and never the thing anybody came for.
 */
/**
 * What the runner a handover replaced is finishing: its sessions, and the full
 * runs it measures (repository, short commit, since when). A runner that holds
 * only a run does not say it finishes 0 sessions.
 */
function predecessorText(predecessor) {
  const steps = predecessor.steps || [];
  const runs = predecessor.runs || [];
  const sessions = `${steps.length} session${steps.length === 1 ? '' : 's'}${steps.length ? ` (${steps.join(', ')})` : ''}`;
  // Minutes are enough on a line that has to fit: `2026-11-16 10:00`.
  const full = runs.map((run) => `a full run of ${run.repo} at ${run.sha ? String(run.sha).slice(0, 7) : 'main'}${run.since ? ` since ${String(run.since).slice(0, 16).replace('T', ' ')}` : ''}`);
  const parts = [...(steps.length || !runs.length ? [sessions] : []), ...full];
  return `pid ${predecessor.pid} finishing ${parts.join(' and ')}`;
}

function mcLine(lines, c, wide, mc, caches, version) {
  const info = mc || {};
  const asked = info.update_requested;
  const state = asked
    ? {
      text: drainLine({
        draining: true, requested: asked.at, since_seconds: asked.age_seconds, inFlight: asked.in_flight || [], lanes: asked.lanes ?? null,
      }),
      styles: ['green'],
    }
    : info.behind
      ? {
        text: `update available — origin/main${info.main ? ` ${info.main}` : ''} is ${info.behind} commit${info.behind === 1 ? '' : 's'} ahead · mc run --update`,
        styles: ['yellow', 'bold'],
      }
      : { text: info.behind === 0 ? 'up to date' : '', styles: ['grey'] };
  const room = Math.max(12, wide - 4 - 'MC'.length - 2);
  // The state before the bookkeeping, and in a short form when the long one
  // does not fit: it is the only part of the line that can ask for anything.
  const short = asked ? 'draining' :(info.behind ? 'update available' : state.text);
  const lead = [{ text: version || '', styles: ['grey'] },
    { text: info.pid ? `pid ${info.pid}` : '', styles: ['grey'] }];
  const rest = [
    { text: info.up_seconds == null ? 'runner not running' : `runner up ${duration(info.up_seconds)}`, styles: ['grey'] },
    { text: info.commit ? `on ${info.commit}` : '', styles: ['grey'] },
    {
      text: info.predecessor ? predecessorText(info.predecessor) : '',
      styles: ['grey'],
    },
    ...(info.behind_checkout || []).map((p) => ({ text: `${p.name} pid ${p.pid} on ${p.commit} · checkout ${info.head}`, styles: ['yellow'] })),
    { text: caches?.offline ? 'offline — plans as last fetched' : '', styles: ['grey'] },
  ];
  const long = trailing([...lead, state]);
  const fits = long.reduce((n, part) => n + part.text.length, 0) <= room;
  const shown = paint(c, fitting(trailing([
    ...lead,
    fits ? state : { ...state, text: short },
    { text: info.hooks ? `hooks: ${info.hooks} · mc hook install` : '', styles: ['yellow'] },
    ...rest,
  ]), room - 2), Math.max(12, room - 2));
  lines.push(`    ${c('MC', 'bold')}${shown ? `  ${shown}` : ''}`);
}

/**
 * The container runtime, one line above the MC line, from the state file alone
 * (`dockerSection`): up or stopped, the live leases, the images, and when the
 * idle stop comes. A file more than an hour old says how old it is, since
 * nothing has written it since. Nothing is drawn when there is no file.
 */
function dockerLine(lines, c, wide, docker) {
  if (!docker) return;
  const leases = docker.leases || [];
  const n = leases.length;
  const kind = docker.kind === 'desktop' ? 'docker desktop' : docker.kind === 'none' ? 'not installed' : docker.kind;
  const parts = ['docker', `${kind} ${docker.up ? 'up' : 'stopped'}`];
  if (docker.up) {
    parts.push(`${n} lease${n === 1 ? '' : 's'}${n ? ` (${leases[0].run || `pid ${leases[0].pid}`}${n > 1 ? ', …' : ''})` : ''}`);
  }
  if (docker.images != null) parts.push(`${docker.images} images`);
  if (docker.idle_stop_seconds > 0) parts.push(`idle stop in ${Math.ceil(docker.idle_stop_seconds / 60)} min`);
  else if (docker.idle_stop_seconds === 0) parts.push('idle stop due');
  if (docker.as_of_seconds > 3600) parts.push(`as of ${ageWords(docker.as_of_seconds)}`);
  say(lines, c, wide, 4, parts.join(' · '));
}

/** The stages drawn as frames, in the order work moves through them. */
export const PIPELINE = Object.freeze(['proposals', 'draft', 'build', 'review', 'finish', 'merge']);

/** The histogram's bars, lowest to highest. */
const BARS = '▁▂▃▄▅▆▇█';

/** Counts as one bar each, scaled to the largest; an empty bucket is a space. */
export function sparkline(counts = []) {
  const top = Math.max(0, ...counts);
  return counts.map((n) => (!n || !top ? ' ' : BARS[Math.min(BARS.length - 1, Math.ceil((n / top) * BARS.length) - 1)])).join('');
}

/**
 * Hero frame: what mc is, and what came out of it in the last 24 hours
 * (`data.landed`, landed.js). Where work stands now is the pipeline below it.
 */
function headerLines(lines, c, raw, wide, data, version, { header = false } = {}) {
  const room = wide - 4;
  const frame = (text) => lines.push(`    ${text}`);
  // The surfaces that open on the figures (`o`, a programme's view) are headed by the overview's own header rows.
  if (header) lines.push(...headerRows(c, wide, data, version), '');
  else lines.push('');
  panelHeading(lines, c, wide, 'FIGURES 24 h');
  // Wrap complete fields so every count survives a narrow terminal.
  const summary = (parts) => {
    let row = [];
    for (const part of parts.filter(part => part.text)) {
      if (row.length && width(paint(c, between([...row, part], ' · '))) > room) {
        frame(paint(c, between(row, ' · ')));
        row = [];
      }
      row.push(part);
    }
    if (row.length) frame(paint(c, between(row, ' · ')));
  };
  const groups = data.programmes?.programmes || [];
  const dormant = data.programmes?.dormant ?? groups.filter(group => group.dormant).length;
  const lanes = data.runner?.setting?.lanes;
  summary([
    { text: `Programs: ${data.programmes?.active ?? groups.length - dormant} active` },
    { text: `${dormant} dormant`, styles: ['grey'] },
    { text: data.runner?.day?.cost == null ? '' : `runner ${money(data.runner.day.cost)} today`, styles: ['grey'] },
    { text: lanes ? `${(data.runner?.sessions || []).length}/${lanes} lanes` : '', styles: ['grey'] },
    { text: `deploy ${data.runner?.production?.at?.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z$/u, ' UTC') || 'none recorded'}`, styles: ['grey'] },
  ]);
  const landed = data.landed;
  if (landed) {
    const share = landed.measured ? Math.round((landed.first_pass / landed.measured) * 100) : null;
    summary([
      { text: `Landed 24 h: ${landed.goals} goals`, styles: landed.goals ? ['green'] : ['grey'] },
      { text: `${landed.without_goal} without goal` },
      { text: `${landed.prs} PRs of ${landed.attempts} merge attempts`, styles: ['grey'] },
      { text: share == null ? '' : `first pass ${share} %` },
    ]);
    if (landed.measured) {
      const cost = landed.cost || {};
      summary([
        { text: `Per goal: ${landed.sessions_per_goal} sessions` },
        { text: cost.median == null ? '' : `cost ${money(cost.median)} median, ${money(cost.total)} total` },
        { text: cost.unpriced_sessions ? `${cost.unpriced_sessions} sessions unpriced` : '', styles: ['grey'] },
      ]);
      const time = landed.time;
      summary([
        { text: `Session time per goal: <${time.buckets_min[0]}m ${sparkline(time.histogram)} ${time.buckets_min.at(-2) / 60}h+`, styles: ['cyan'] },
        { text: `median ${time.median_min} min` },
        { text: `p25–p75 ${time.p25_min}–${time.p75_min}`, styles: ['grey'] },
        { text: `p90 ${time.p90_min}`, styles: ['grey'] },
        { text: `max ${time.max_min}`, styles: ['grey'] },
      ]);
    }
  }
  const desk = data.desk_cost;
  const landedPlan = data.landed || {};
  summary([
    { text: desk ? `Planning & desks 24 h: ${money(desk.cost) || '$0'}${desk.partial ? ' so far' : ''}` : '' },
    { text: desk ? `${desk.sessions} interactive sessions${deskNote(desk)}` : '', styles: ['grey'] },
    { text: landedPlan.plan_sessions ? `headless plan ${money(landedPlan.plan_cost) || '$0'} (${landedPlan.plan_sessions})` : '', styles: ['grey'] },
  ]);
  panelEnd(lines, c, wide);
  panelHeading(lines, c, wide, 'PIPELINE');
  pipelineLines(lines, c, raw, wide, data);
  panelEnd(lines, c, wide);
  lines.push('');
}

/** What the desk cost line could not count: conversations mc did not start, and tools whose cost could not be read. */
function deskNote(desk) {
  const left = Object.entries(desk.left_out || {}).map(([tool, count]) => `${count} ${tool} not started by mc left out`);
  return [...left, ...(desk.failed || [])].map((text) => `; ${text}`).join('');
}

/**
 * Where work stands now, one entry per stage: its count, the goals waiting on
 * Martin (`martin`) and blocked (`blocked`) in it, and its marks — one per
 * session working there. Every plan session, interactive or headless, is a mark
 * on draft; proposals carries none.
 */
export function pipelineStages(data) {
  const groups = data.programmes?.programmes || [];
  const goals = groups.flatMap(group => group.goals || []);
  const sessions = data.runner?.sessions || [];
  const proposals = (data.intake?.proposals || 0) + groups.reduce((n, group) => n + (group.proposals || 0), 0);
  const interactive = Object.values(data.sessions?.planning_sessions || {}).reduce((n, list) => n + (list?.length || 0), 0);
  const ofKind = (kind) => sessions.filter(session => session.kind === kind).length;
  const rounds = (data.merges?.repos || []).reduce((n, repo) => n + (repo.landings?.length || 0), 0);
  return PIPELINE.map((stage) => {
    const here = goals.filter(goal => (goal.stage || 'unknown') === stage);
    // Every plan session, interactive or headless, is a mark on draft; proposals has none.
    // A build and a repair (a build after a rejection) are both marks on build, the repair in its own blue.
    // A session's mark takes its stage's colour; a mend, which has no box, is yellow.
    const tone = STAGE_TONE[stage];
    const marks = stage === 'proposals' ? []
      : stage === 'draft' ? [{ mark: '●', count: interactive + ofKind('plan'), styles: tone }]
        : stage === 'merge' ? [{ mark: '◎', count: rounds, styles: tone }, { mark: '↺', count: ofKind('mend'), styles: kindTone('mend') }]
          : stage === 'build' ? [{ mark: '●', count: ofKind('build'), styles: tone }, { mark: '●', count: ofKind('repair'), styles: kindTone('repair') }]
            : [{ mark: '●', count: ofKind(stage), styles: tone }];
    return {
      stage,
      count: stage === 'proposals' ? proposals : here.length,
      martin: here.filter(goal => goal.status === 'Martin').length,
      blocked: here.filter(goal => goal.status === 'blocked').length,
      marks,
    };
  });
}

/** At most this many marks of one kind in a box; more are drawn `●×n`. */
const MARK_CAP = 8;

/** The arrows between boxes: ` ──▶ ` where the row has the room, else ` ▶ `. */
const ARROW = Object.freeze({ wide: ' ──▶ ', narrow: ' ▶ ' });

const textWidth = (parts) => parts.reduce((n, part) => n + width(part.text), 0);

/**
 * One stage as a box of four rows, all of one width: the name set into the top
 * border (`┌─ build ──┐`), the count with its flags, the marks, and the bottom
 * border. The box is as wide as its widest content — the name with its `─ `
 * and ` ─`, the count, the marks — plus one space each side, and never wider.
 * Its border is the stage's colour (`STAGE_TONE`), or the real grey when the
 * stage is empty: no count and no session. The grey is drawn raw, which the
 * page's text mapping does not touch. The name is bold in the terminal's own
 * foreground.
 */
function stageBox(c, raw, item) {
  const count = [
    { text: String(item.count), styles: item.count ? ['bold'] : ['grey'] },
    item.martin ? { text: ` ⚑${item.martin}`, styles: ['yellow'] } : null,
    item.blocked ? { text: ` ⊘${item.blocked}`, styles: ['red'] } : null,
  ].filter(Boolean);
  const marks = [];
  for (const { mark, count: n, styles } of item.marks) {
    if (!n) continue;
    // The space between two kinds is plain, not painted with either.
    if (marks.length) marks.push({ text: ' ' });
    marks.push({ text: n <= MARK_CAP ? mark.repeat(n) : `${mark}×${n}`, styles });
  }
  const inner = Math.max(item.stage.length + 4, textWidth(count) + 2, textWidth(marks) + 2);
  const tone = marks.length || item.count ? STAGE_TONE[item.stage] : ['grey'];
  const edge = (text) => raw(text, ...tone);
  // Centred: the spare column, if any, goes on the right.
  const row = (parts) => {
    const free = inner - textWidth(parts);
    const left = Math.floor(free / 2);
    return `${edge('│')}${' '.repeat(left)}${paint(c, parts)}${' '.repeat(free - left)}${edge('│')}`;
  };
  return {
    width: inner + 2,
    top: `${edge('┌─ ')}${c(item.stage, 'bold')}${edge(` ${'─'.repeat(inner - item.stage.length - 3)}┐`)}`,
    counts: row(count),
    marks: row(marks),
    bottom: edge(`└${'─'.repeat(inner)}┘`),
  };
}

/**
 * Where work stands now: a small box per stage, joined by arrows under the
 * hero frame at its indent. All six on one row when they fit the page (`wide`
 * less the indent), else with the narrower arrow, else three and three on two
 * rows, each keeping its arrows. A row is never clipped mid-box.
 */
function pipelineLines(lines, c, raw, wide, data) {
  const boxes = pipelineStages(data).map((item) => stageBox(c, raw, item));
  const room = wide - 4;
  const fits = (rows, arrow) => rows.every((group) => group.reduce((n, box) => n + box.width, 0)
    + arrow.length * (group.length - 1) <= room);
  let rows = [boxes];
  let arrow = ARROW.wide;
  if (!fits(rows, arrow)) {
    arrow = ARROW.narrow;
    if (!fits(rows, arrow)) {
      const half = Math.ceil(boxes.length / 2);
      rows = [boxes.slice(0, half), boxes.slice(half)];
      arrow = fits(rows, ARROW.wide) ? ARROW.wide : ARROW.narrow;
    }
  }
  const blank = ' '.repeat(arrow.length);
  const along = (group, pick, sep) => group.map((box, index) => (index ? sep : '') + pick(box)).join('');
  for (const group of rows) {
    // Only the count row carries the arrows; the other rows keep their place.
    lines.push(`    ${along(group, (box) => box.top, blank)}`);
    lines.push(`    ${along(group, (box) => box.counts, raw(arrow, 'grey'))}`);
    lines.push(`    ${along(group, (box) => box.marks, blank)}`);
    lines.push(`    ${along(group, (box) => box.bottom, blank)}`);
  }
}

/* ------------------------------------------------------------------- page */

/**
 * The operations view's panels, and what `a` draws after the overview: merges, pull requests, deploy, DEV and SYSTEM.
 * MAINTENANCE and DESK (the Martin queue) are the overview's. No budget applies to them.
 */
function operationsBody(lines, c, wide, data, { expand, version, at }) {
  const runner = data.runner || {};
  if (lines.length && lines.at(-1) !== '') lines.push('');
  for (const repo of data.checks?.main_mend || []) if (repo.error) detail(lines, c, wide, 2, `${repo.repo}: ${repo.error}`, ['red']);
  const deployMend = data.checks?.deploy_mend;
  if (deployMend?.error) detail(lines, c, wide, 2, `deploy repair: ${deployMend.error}`, ['red']);
  if (deployMend?.state !== 'Martin' && deployMend?.line) detail(lines, c, wide, 2, deployMend.line.replace(/^mc: /u, ''), ['yellow']);
  mergesLines(lines, c, wide, data.merges, expand);
  prsLines(lines, c, wide, data.prs, (runner.sessions || []).flatMap(session => session.prs || []));
  lines.push('');
  deployLines(lines, c, wide, runner.production, expand);
  panelEnd(lines, c, wide);
  lines.push('');
  const devTop = lines.length;
  devLines(lines, c, wide, data.dev, expand);
  frameEnd(lines, c, wide, devTop);
  lines.push('');
  panelHeading(lines, c, wide, 'SYSTEM');
  mcLine(lines, c, wide, data.mc, data.caches, version);
  runnerLines(lines, c, wide, { ...runner, at_ms: at }, expand);
  dockerLine(lines, c, wide, data.docker);
  if (data.billing) detail(lines, c, wide, 4, `BILLING  ${data.billing}`);
  detail(lines, c, wide, 4, `PROVIDER PRIORITY  ${data.providerPriority || 'auto'}`);
  for (const note of data.notes || []) {
    // How old the PR cache is was the page's last line, every time, and it was
    // never what anybody came for; `mc --json` has it under `caches`.
    if (/^PRs from cache|^no PR cache yet/u.test(note)) continue;
    say(lines, c, wide, 4, `note: ${note}`);
  }
  panelEnd(lines, c, wide);
}

/**
 * The whole page, as lines. `data` is exactly what `--json` prints: one key
 * per section, so the two can never say different things.
 *
 * Four pages are drawn from it: the overview (the default, as long as the work; page-overview.js), the maintenance view (`maintenance`),
 * the operations view (`operations`: the hero frame and the panels), and a programme's own view (`view`).
 */
export function renderPageLines(data, {
  columns = 100, colour = false, version = '', now = new Date(), expand = false, view = null, operations = false, maintenance = false,
} = {}) {
  const paintText = painter(colour);
  // Secondary information must remain readable on dark terminal palettes.
  const c = (text, ...styles) => paintText(text, ...styles.map((style) => style === 'grey' ? 'white' : style));
  const wide = Math.max(60, Math.min(columns, 160)) - 2;
  const at = now instanceof Date ? now.getTime() : Number(now);
  const lines = [];
  const runnerSessions = data.runner?.sessions || [];
  const body = { expand, version, at };

  if (maintenance) {
    // The overview's header rows and the warnings, then the frame: FIGURES 24 h and PIPELINE are the operations view's.
    lines.push(...headerRows(c, wide, data, version), '');
    warningLines(lines, c, wide, data);
    maintenanceView(lines, c, wide, data);
    return lines;
  }
  if (operations) {
    // FIGURES 24 h and PIPELINE are its first frames: the header rows are the overview's.
    headerLines(lines, c, paintText, wide, data, version);
    warningLines(lines, c, wide, data);
    operationsBody(lines, c, wide, data, body);
    return lines;
  }
  // `view` is a programme's name: that programme's block alone, nothing below it. A name that is no longer listed is the overview.
  const open = view == null ? null : (data.programmes?.programmes || []).find((group) => group.programme === view);
  if (open) {
    headerLines(lines, c, paintText, wide, data, version, { header: true });
    deskLines(lines, c, wide, data.desk, { deskSessions: flightRows(data).desk.length });
    managerFrames(lines, c, wide, data, expand);
    warningLines(lines, c, wide, data);
    programmeViewLines(lines, c, wide, open, expand, runnerSessions);
    return lines;
  }
  lines.push(...overviewLines(c, wide, data, {
    version,
    expand,
    drawProgramme: (into, group) => programmeFrame(into, c, wide, data, group, expand, runnerSessions),
  }));
  if (expand) {
    // `a` holds what the single page held (D10): the operations view's sections expanded, beginning with its hero
    // frame (the 24-hour figures and the pipeline), and each desk session's own frame with its trigger and pid (D6).
    if (lines.at(-1) === '') lines.pop();
    headerLines(lines, c, paintText, wide, data, version);
    managerFrames(lines, c, wide, data, expand);
    operationsBody(lines, c, wide, data, body);
  }
  return lines;
}

/** Each Manager's frame, with its trigger and pid: under the hero frame in a programme's view and under `a`. */
function managerFrames(lines, c, wide, data, expand) {
  const managers = data.sessions?.desk_sessions?.manager
    || (data.sessions?.desks?.manager ? [data.sessions.desks.manager] : []);
  for (const session of managers) lines.push(...activityLines(c, wide, { ...session, kind: 'manager' }, { indent: 2, expand }));
  if (managers.length) lines.push('');
}

export function renderPage(data, options = {}) {
  return `${renderPageLines(data, options).join('\n')}\n`;
}
