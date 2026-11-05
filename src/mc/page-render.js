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
 * stands, both in page-grid.js beside the grid every PROGRAMMES, SESSIONS and
 * MERGES row is drawn in. Everything else is structure — cyan headings, grey for the
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
import { ageWords } from './page-cache.js';
import { drainLine, stopLine } from './run-control.js';
import {
  KIND_TONE, PR_QUIET_S, PR_TONE, STATE_TONE, clipCell, duration, gridColumns, gridRow, kindTone, prCellOf, stateTone,
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

/** A state's colour, by its one palette (page-grid.js `STATE_TONE`). */
const statusTone = stateTone;

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

/**
 * A heading: the section's name, its counts, and the verb that expands it
 * pushed to the right margin. The verb goes first when the width runs out —
 * it is a reminder, and the counts are the answer.
 */
function heading(lines, c, wide, title, counts, verb) {
  // The width is measured on the plain text and the colour applied after:
  // clipping a string that already carries escape sequences cuts them in half.
  const parts = counts == null ? [] : (Array.isArray(counts) ? counts : [{ text: counts, styles: ['grey'] }]);
  const room = wide - 2 - title.length - (verb ? verb.length + 2 : 0);
  const shown = parts.length ? paint(c, parts, Math.max(12, room - 2)) : '';
  const left = `  ${c(title, 'bold', 'cyan')}${shown ? `  ${shown}` : ''}`;
  if (!verb) { lines.push(left); return; }
  const gap = wide - width(left) - verb.length;
  lines.push(gap > 2 ? `${left}${' '.repeat(gap)}${c(verb, 'grey')}` : left);
}

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

/**
 * SESSIONS — the headless sessions `mc run` is running, and nothing else.
 *
 * The runner runs three kinds of session on a goal: `plan`, `build` and
 * `review` (Martin, 2026-11-02). RUNNER names the machine rather than what it
 * holds — `mc run` on the right of the heading already does that. So the
 * heading names what the rows are, and carries the answer: `n of N lanes`, how
 * many sessions are running out of the total `mc run lanes` set.
 *
 * One row per lane, session or no session: a lane is a lane between sessions
 * as much as during one, and with a row only where there was a session, a
 * lane waiting for its next work and a lane whose process had died looked
 * exactly alike. A runner that is not running has no lanes, and says so in
 * one line.
 *
 * How long the process has been up, and what is in production, were here.
 * The first is a fact about mc and is on the MC line; the second has DEPLOY.
 */
function runnerLines(lines, c, wide, runner) {
  const now = runner;
  const lanes = now.lanes || [];
  const alive = Boolean(now.process?.alive);
  const sessions = now.sessions || [];
  const flight = sessions.length;
  // The answer first and in the state's colour: green while something runs,
  // grey when the runner is idle, yellow when it is not there at all — that is
  // the one of the three a person has to do something about.
  const counts = [
    alive || flight
      ? { text: `${flight} of ${lanes.length || flight} lane${(lanes.length || flight) === 1 ? '' : 's'}`, styles: flight ? ['green', 'bold'] : ['grey'] }
      : { text: 'not running', styles: ['yellow', 'bold'] },
  ];
  heading(lines, c, wide, 'SESSIONS', between(counts, ' · '), 'mc run');
  if (lanes.length && (alive || flight)) {
    for (const lane of lanes) lines.push(laneLine(c, wide, lane));
  } else {
    lines.push(`  ${c(MARK.quiet, 'grey')} ${c('the runner is not running — mc run starts it', 'grey')}`);
  }
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
        lanes: lanes.length || null,
      })
      : null;
    lines.push(`  ${paint(c, [
      { text: `${MARK.stopped} ${stopping ? 'stopping' : 'STOP left behind'}`, styles: ['red', 'bold'] },
      { text: stopping ? reading.slice('stopping'.length) : ' — the next start removes it', styles: ['grey'] },
    ], wide - 2)}`);
    if (stopping) say(lines, c, wide, 4, 'start takes over now — a new runner on every lane, this one only finishes its sessions', 'grey');
  }
  for (const line of now.stale) say(lines, c, wide, 2, `${MARK.quiet} stale: ${line}`, 'red');
  for (const failure of now.github || []) say(lines, c, wide, 2, githubLine(failure), 'yellow');
  // Yellow while the runner holds new starts back for want of disk or memory;
  // a file left by a runner that is gone says nothing about now.
  if (now.disk?.line && alive) say(lines, c, wide, 2, now.disk.line, 'yellow');
  if (now.memory?.line && alive) say(lines, c, wide, 2, now.memory.line, 'yellow');
  dayLine(lines, c, wide, now.day);
  if (now.quota.count) {
    // Yellow while a refusal is recent enough to still be the reason the
    // runner is idle; older than that it is history, and history is grey.
    const at = Date.parse(now.quota.last);
    const recent = Number.isFinite(at) && now.at_ms - at < QUOTA_FRESH_MS;
    say(lines, c, wide, 2, `quota: ${now.quota.count} answer(s) in the last 24 h, last ${when(now.quota.last)}`,
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
  for (const kind of ['build', 'review', 'plan']) {
    const counted = kinds[kind];
    if (!counted || (kind === 'plan' && !counted.sessions)) continue;
    parts.push(dot, { text: `${kind} ${counted.sessions}`, styles: kindTone(kind) });
    const outcomes = DAY_OUTCOMES.filter(([key]) => counted[key]);
    outcomes.forEach(([key, label, styles], index) => {
      parts.push({ text: `${index ? ', ' : ' ('}${counted[key]} ${label}${index === outcomes.length - 1 ? ')' : ''}`, styles });
    });
  }
  // What is not a session, and the cost, give way on a narrow terminal — the
  // cost's basis first, then the cost, then `other` — so the counts keep their
  // colours rather than being clipped grey.
  const room = wide - 2;
  const used = () => parts.reduce((n, part) => n + part.text.length, 0);
  const other = kinds.other ? `other ${kinds.other}` : null;
  const priced = [cost && `${cost} list (${day.model}, ${day.prices_dated})`, cost && `${cost} list`].filter(Boolean);
  const tail = [
    ...priced.map((text) => [other, text]),
    [other],
  ].map((group) => group.filter(Boolean)).find((group) => used() + group.reduce((n, text) => n + 3 + text.length, 0) <= room) || [];
  for (const text of tail) parts.push(dot, { text, styles: ['grey'] });
  lines.push(`  ${paint(c, parts, room)}`);
}

/** A painted cell, padded to its column with spaces that carry no colour. */
function cell(c, text, columns, styles) {
  return `${styles?.length ? c(text, ...styles) : text}${' '.repeat(Math.max(0, columns - text.length))}`;
}

/** `#13265` and one space: the column a PULL REQUESTS row's number is drawn in. */
const PR_NUMBER = 7;
/** The repository's cell on a PULL REQUESTS row. */
const LANE_REPO = 11;

/** What a session works on, as the row says it, in `room` characters: `mc/<goal>`, or its name. */
export function sessionWork(session, room = Infinity) {
  return clipCell(session.goal || session.name || '?', room);
}

/**
 * One lane, in the page's grid (page-grid.js). Its number is the lane's. Idle,
 * the row is its number and `idle`. With a session in it, the row is read for
 * what is running, in that order: its kind as the first word — `PLAN`,
 * `BUILD`, `REVIEW`, in the kind's colour — what it works on (a goal,
 * `mc/<goal>`), the repository, `running`, the clock, and the goal's open pull
 * request, in the PR column every section has. The grey tail is the bookkeeping: the
 * model, credits when the session runs on the API credit, the advisor when it
 * has one, and the check-ins. Nothing on the row is bold (Martin,
 * 2026-09-19); the clock turns yellow past a check-in. There is no end on it:
 * nothing is killed on elapsed time (ruling 18).
 *
 * The model was a column of its own beside the repository. It is bookkeeping,
 * grey, and in the tail now: the state column says the same kind of thing in
 * every section, and for a session that is `running`.
 */
function laneLine(c, wide, lane) {
  const s = lane.session;
  if (!s) {
    return gridRow(c, wide, {
      nr: lane.number ?? null, mark: { text: MARK.quiet, styles: ['grey'] },
      state: { text: lane.state || 'idle', styles: stateTone(lane.state || 'idle') },
    });
  }
  const kind = String(s.kind || 'build');
  const checkIns = s.check_ins == null ? null : `${s.check_ins} check-in${s.check_ins === 1 ? '' : 's'}`;
  return gridRow(c, wide, {
    nr: lane.number ?? null,
    mark: { text: MARK.running, styles: ['green'] },
    kind: { text: kind.toUpperCase(), styles: kindTone(kind) },
    name: { text: sessionWork(s, gridColumns(wide).name.width - 1) },
    repo: { text: s.repo || lane.repo || 'unplaced', styles: ['grey'] },
    state: { text: s.state || 'running', styles: stateTone(s.state || 'running') },
    // The clock carries its own colour: `elapsedTone` says when it has turned.
    progress: { text: s.progress ?? duration(s.elapsed_seconds), styles: elapsedTone(s) },
    pr: prCellOf(s.prs),
    tail: [
      s.model || s.tool ? { text: s.model || s.tool, styles: ['grey'] } : null,
      // `credits` when the session runs on the API credit (step-credits); the
      // plan is the ordinary case and says nothing.
      s.billing === 'credits' ? { text: 'credits', styles: ['grey'] } : null,
      s.advisor ? { text: `${s.advisor} advisor`, styles: ['grey'] } : null,
      checkIns ? { text: checkIns, styles: s.check_ins ? ['yellow'] : ['grey'] } : null,
    ],
  });
}

/**
 * DEPLOY — what is in production, on the section's own heading, and what is
 * wrong with it first. It was a line under RUNNER's day; a deploy is not the
 * runner's, and the last section of the page is where it is looked for.
 *
 * The mismatch is the reason the line is worth its row. What mc shipped and
 * what `/api/version` answers should be the same sha; when they are not,
 * something happened outside the record — a deploy made another way, a deploy
 * that did not take — and no machine here can say which of the two to believe.
 * That is the page's yellow exactly: it waits on a person.
 *
 * So what is wrong leads, and the settled fact follows it. The width is spent
 * left to right, and it was being spent on the holder's hostname first: on
 * 2026-09-06 a failed deploy's own `stopped_at` — `Deploy source preflight`,
 * the one word on the row that says what to go and look at — was clipped off
 * the end while `by martin@laptop` sat in the middle of the line. The holder is
 * bookkeeping; it is in `mc --json` and in `mc status`, and it is not here.
 *
 * Absent when neither source knows anything, which is the state before the
 * first `mc deploy` and before the helper has ever collected.
 */
function deployLines(lines, c, wide, production) {
  const verb = 'mc deploy';
  if (!production) {
    heading(lines, c, wide, 'DEPLOY', 'nothing deployed yet', verb);
    return;
  }
  const live = production.live;
  const liveAge = live ? ` (${ageWords(live.age_seconds)} old)` : '';
  const room = Math.max(12, wide - 2 - 'DEPLOY'.length - 2 - verb.length - 4);
  const parts = [];
  // Each part carries its own leading separator, so `fitting` can drop the tail
  // without leaving one dangling.
  const sep = () => (parts.length ? ' · ' : '');
  // An attempt first of all: a deploy that failed is an event with a place to
  // go and look, and `stopped_at` is that place. A mismatch is a state, and
  // survives being read a line later.
  const running = production.running;
  if (running) {
    parts.push({
      text: `${sep()}deploying ${running.short} since ${ageWords(running.age_seconds)}${running.late ? ' — no end recorded' : ''}`,
      styles: running.late ? ['yellow', 'bold'] : ['green'],
    });
  } else if (production.failed) {
    parts.push({
      text: `${sep()}a deploy failed ${ageWords(production.failed.age_seconds)} ago`
        + `${production.failed.stopped_at ? ` at ${production.failed.stopped_at}` : ''}`,
      styles: ['yellow'],
    });
  }
  if (production.differs) {
    // Both readings, in one statement: the page cannot say which to believe, so
    // it says what each of them is. How old the reading is comes after them —
    // it weighs the answer, and a narrow terminal can lose it and still have
    // been told.
    parts.push({
      text: `${sep()}production answers ${live.short}, mc deployed ${production.short}`,
      styles: ['yellow', 'bold'],
    });
    parts.push({ text: ` · /api/version ${ageWords(live.age_seconds)} old`, styles: ['grey'] });
  }
  if (production.sha && !production.differs) {
    parts.push({ text: `${sep()}production ${production.short}` });
  } else if (!production.sha && live) {
    // Nothing mc deployed, but production answers something: say what it
    // answers and where that came from, rather than nothing at all.
    parts.push({ text: `${sep()}production ${live.short}` });
    parts.push({ text: ` · /api/version${liveAge} — mc has deployed nothing`, styles: ['grey'] });
  }
  if (production.sha) {
    parts.push({ text: `${sep()}deployed ${ageWords(production.age_seconds)} ago`, styles: ['grey'] });
    if (production.build) parts.push({ text: ` · build ${production.build}`, styles: ['grey'] });
  }
  // The lead is clipped rather than dropped: `fitting` keeps whole parts, and a
  // part too long for a 60-column terminal would take the whole line with it.
  if (parts[0]) parts[0] = { ...parts[0], text: clip(one(parts[0].text), room) };
  heading(lines, c, wide, 'DEPLOY', fitting(parts, room), verb);
}

/** A language reading older than this is one worth taking again. */
export const LANGUAGE_STALE_S = 7 * 24 * 60 * 60;

/** A language run's outcome, one colour each: what stopped waits on a person. */
const RUN_TONE = { running: ['green'], stopped: ['yellow'], refused: ['yellow'], failed: ['red'], done: ['grey'] };

/**
 * LANGUAGE — what `mc language` last read and last ran, right after DEPLOY
 * because it is the other door to production. Only the languages with
 * something to say are drawn — unresolved selectors, rows waiting, a reading a
 * week old — and the last run rides on the heading. With neither the section
 * is not drawn at all: the empty page gains no line.
 */
function languageLines(lines, c, wide, language, at) {
  const ageOf = (iso) => {
    const ms = at - Date.parse(iso);
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
  };
  const rows = (language?.languages || []).map((entry) => {
    const age = entry.read_at ? ageOf(entry.read_at) : null;
    const stale = age === null || age >= LANGUAGE_STALE_S;
    const parts = [];
    if (entry.unresolved) parts.push({ text: `${entry.unresolved} unresolved selector${entry.unresolved === 1 ? '' : 's'}`, styles: ['yellow'] });
    if (entry.waiting_rows) parts.push({ text: `${entry.waiting_rows} rows waiting · mc language promote`, styles: ['yellow'] });
    if (!parts.length && !stale) return null;
    parts.push({ text: entry.read_at ? `read ${ageWords(age)} ago` : 'never read', styles: stale ? ['yellow'] : ['grey'] });
    return { lang: entry.lang, parts };
  }).filter(Boolean);
  const last = language?.last_run;
  if (!rows.length && !last) return false;
  const counts = last
    ? [
      { text: `last run ${last.manifest}${last.dry_run ? ' (dry run)' : ''} · ` },
      { text: last.outcome, styles: RUN_TONE[last.outcome] || ['grey'] },
      { text: ` · ${ageWords(ageOf(last.ended || last.started))} ago`, styles: ['grey'] },
    ]
    : 'no run recorded';
  heading(lines, c, wide, 'LANGUAGE', counts, 'mc language');
  for (const { lang, parts } of rows) {
    const left = `    ${c(pad(lang, 4), 'bold')}`;
    lines.push(`${left}${paint(c, between(parts, ' · '), wide - width(left))}`);
  }
  return true;
}

/** The red line above every section while a run is stopped inside a gap. */
function openGapLine(lines, c, wide, gap) {
  if (!gap) return;
  say(lines, c, wide, 2, `language: ${gap.manifest} stopped after ${gap.act} — ${gap.says} · mc language resume`, ['red', 'bold']);
  lines.push('');
}

/** A daily reading older than this missed a day: its age is drawn yellow. */
const CHECK_STALE_S = 36 * 60 * 60;

/**
 * CHECKS — per repository, the nightly's last full test and the last daily
 * `mc deps`, each with its age and the commit it read. Drawn whether or not
 * either has run: *"when did the suite last run whole?"* is a question the
 * row answers either way.
 */
function checksLines(lines, c, wide, checks) {
  heading(lines, c, wide, 'CHECKS', 'full test and deps, once a day', 'mc test nightly status');
  for (const repo of checks?.repos || []) {
    const ageTone = (seconds) => (seconds != null && seconds >= CHECK_STALE_S ? ['yellow'] : ['grey']);
    const ago = (seconds) => (seconds == null ? '?' : ageWords(seconds));
    const test = repo.test
      ? between([
        { text: `full test ${ago(repo.test.age_seconds)}`, styles: ageTone(repo.test.age_seconds) },
        { text: repo.test.short || '', styles: ['grey'] },
        repo.test.red == null ? null : { text: repo.test.red ? `${repo.test.red} red` : 'green', styles: repo.test.red ? ['red'] : ['green'] },
      ], ' · ')
      : [{ text: 'full test never run', styles: ['yellow'] }];
    const counts = repo.deps ? `${repo.deps.critical} critical, ${repo.deps.high} high` : '';
    const deps = repo.deps
      ? between([
        { text: `deps ${ago(repo.deps.age_seconds)}`, styles: ageTone(repo.deps.age_seconds) },
        { text: repo.deps.short || '', styles: ['grey'] },
        { text: counts, styles: repo.deps.critical ? ['red'] : (repo.deps.high ? ['yellow'] : ['green']) },
      ], ' · ')
      : [{ text: 'deps never read', styles: ['yellow'] }];
    const left = `       ${pad(clip(repo.repo, DIGEST_REPO - 1), DIGEST_REPO)} `;
    lines.push(`${left}${paint(c, [...test, { text: '   ' }, ...deps], wide - width(left))}`);
  }
}

/** Past this, the age is the thing on the row worth looking at. */
const STALE_SESSION_S = 24 * 60 * 60;
const ageTone = (seconds) => (seconds != null && seconds >= STALE_SESSION_S ? ['yellow'] : ['grey']);
const openFor = (seconds) => (seconds == null ? 'open' : `open ${ageWords(seconds)}`);

/** The repository column shared by maintenance and checks. */
const DIGEST_REPO = 11;

/** Repository readings side by side; missing measurements stay unknown. */
function maintenanceLines(lines, c, wide, sessions, intake, checks) {
  heading(lines, c, wide, 'MAINTENANCE', '', 'mc helper · mc brief');
  const compact = wide < 100;
  const columns = [
    ['REPO', 11], ['ERRORS', 7], ['NEW', 5], ['LOUD', 5],
    [compact ? 'C' : 'DEP CRIT', compact ? 3 : 9],
    [compact ? 'H' : 'HIGH', compact ? 3 : 6],
    ...(!compact ? [['MOD', 5], ['LOW', 5]] : []),
    [compact ? 'PROP' : 'PROPOSALS', compact ? 5 : 10],
  ];
  const cells = (values) => columns.map(([, size], i) => pad(clip(String(values[i]), size - 1), size)).join('');
  lines.push(`    ${c(`${cells(columns.map(([label]) => label))}STATUS`, 'grey')}`);
  const repos = [...new Set(['memoro', 'memoro-cli', ...(intake?.repos || []).map((r) => r.repo), ...(checks?.repos || []).map((r) => r.repo)])];
  for (const name of repos) {
    const digest = intake?.repos?.find((r) => r.repo === name);
    const deps = checks?.repos?.find((r) => r.repo === name)?.deps;
    const proposals = intake?.by_system?.[name === 'memoro-cli' ? 'mc' : name] ?? 0;
    const status = !digest ? 'no digest' : digest.first ? 'no baseline'
      : digest.age_seconds == null ? (digest.date || 'age unknown') : `${ageWords(digest.age_seconds)} old`;
    const values = [name, digest?.errors_total ?? '?', digest && !digest.first ? digest.new_errors : '?',
      digest && !digest.first ? digest.loud : '?', deps?.critical ?? '?', deps?.high ?? '?',
      ...(!compact ? [deps?.moderate ?? '?', deps?.low ?? '?'] : []), proposals];
    const tone = digest?.loud || deps?.critical ? 'red'
      : !digest || !deps || digest.first || digest.age_seconds == null || digest.age_seconds >= STALE_SESSION_S || deps.high ? 'yellow' : 'green';
    lines.push(`  ${c('●', tone)} ${cells(values)}${c(clip(status, wide - 4 - width(cells(values))), 'grey')}`);
  }
  if (compact) say(lines, c, wide, 2, 'C/H: dependency critical/high · errors: fingerprints', ['grey']);
  else say(lines, c, wide, 2, 'errors: fingerprints · DEP: dependency vulnerabilities', ['grey']);
  const untagged = intake?.by_system?.untagged || 0;
  if (untagged) say(lines, c, wide, 7, `${untagged} proposal${untagged === 1 ? '' : 's'} · untagged ${untagged}`, ['yellow']);
  for (const verb of ['helper', 'brief']) {
    const session = sessions?.desks?.[verb];
    if (!session) continue;
    say(lines, c, wide, 7, `${verb} ${MARK.running} ${openFor(session.age_seconds)} · ${[session.tool, session.model].filter(Boolean).join(' ')}${session.pid ? ` · pid ${session.pid}` : ''}`, ['cyan']);
  }
}


/**
 * What no kind explains (`programmes.strays`): a directory under `~/mc` that
 * is no area (`listStrays`), with whether it holds a checkout and how much is
 * uncommitted there — the two facts that say whether somebody's work is in it —
 * and a session with no owner: a register entry no verb explains, or a tmux
 * session `mc-<name>` mc did not start for anyone, with how long it has been
 * open. One line each. Nothing removes one, so nothing here offers to.
 */
function strayLines(lines, c, wide, strays) {
  if (!strays?.length) return;
  const room = wide - 7;
  lines.push(`       ${c('not an area mc knows', 'yellow')}`);
  for (const stray of strays) {
    const facts = stray.kind === 'directory' || !stray.kind
      ? [stray.checkout ? 'checkout yes' : 'checkout no', ...(stray.checkout ? [`${stray.uncommitted} uncommitted`] : [])]
      : [stray.kind === 'tmux' ? 'tmux session' : `${stray.verb ? `mc ${stray.verb}` : 'a session'} with no programme`,
        openFor(stray.age_seconds), ...(stray.pid ? [`pid ${stray.pid}`] : [])];
    lines.push(`       ${paint(c, fitting([
      { text: pad(clip(stray.name, 21), 22), styles: ['bold'] },
      { text: facts.join(' · '), styles: ['grey'] },
    ], room), room)}`);
  }
}

/**
 * How the clock reads: plain, then yellow once the session is past its first
 * check-in — the sessions that are already unusual. Never red: a long session
 * is not a failed one, and nothing kills it on the clock (ruling 18).
 */
function elapsedTone(step) {
  const spent = step.elapsed_seconds;
  if (step.check_ins > 0 || (step.check_in_seconds && spent != null && spent >= step.check_in_seconds)) return ['yellow'];
  // No bold anywhere on a lane row (Martin, 2026-09-19): before its first
  // check-in the clock is the terminal's own text, like the name beside it.
  return [];
}

/** How many queued pull requests a repository row names before counting the rest. */
export const QUEUED_DRAWN = 6;

/**
 * A worktree as the tail has room for it: `~/…` under the home directory, and
 * a programme's goal worktree from the programme on (`mc/goals/no-work/memoro`).
 */
function worktreeWords(path) {
  return String(path || '')
    .replace(/^\/(?:Users|home)\/[^/]+/u, '~')
    .replace(/^~\/mc\/programs\//u, '');
}

/**
 * One dev server, in the page's grid: `MAIN` for the shared checkout's
 * standing server, `SLOT` for one lent to a worktree; the session that holds
 * it in the name column (`BUILD mc/no-work`, `plan mc`, `shot`); the
 * repository; `leased`, `idle` or `starting`; how long since mc used it; the
 * port where a pull request stands elsewhere; and the worktree and branch in
 * the tail. A session that has ended says so first in the tail, in yellow.
 */
function devServerLine(c, wide, server) {
  return gridRow(c, wide, {
    mark: { text: MARK.running, styles: server.holder_gone || server.state === 'starting' ? ['yellow'] : stateTone(server.state) },
    kind: { text: String(server.kind || 'slot').toUpperCase(), styles: ['grey'] },
    name: { text: server.name || '—', styles: server.name && !server.holder_gone ? [] : ['grey'] },
    repo: { text: server.repo || '', styles: ['grey'] },
    state: { text: server.state, styles: stateTone(server.state) },
    progress: { text: server.progress || '', styles: ['grey'] },
    pr: { text: server.port ? `:${server.port}` : '', styles: ['grey'] },
    tail: [
      server.holder_gone ? { text: 'holder gone', styles: ['yellow'] } : null,
      // The branch before the worktree: it is the shorter, and the worktree gives way first.
      server.branch ? { text: server.branch, styles: ['grey'] } : null,
      server.worktree ? { text: worktreeWords(server.worktree), styles: ['grey'] } : null,
    ],
  });
}

/**
 * DEV — the dev servers, and who holds each (goal mc/dev-section). The heading
 * counts the servers that answer, the leased ones, and the waiters when there
 * are any; one row per server; and one yellow row for the queue, naming who is
 * first. Drawn from `mc --json`'s `dev` and nothing else.
 */
function devLines(lines, c, wide, dev) {
  const servers = dev?.servers || [];
  if (!servers.length && !dev?.queued) {
    heading(lines, c, wide, 'DEV', [{ text: 'none running', styles: ['grey'] }], 'mc dev list');
    return;
  }
  const counts = [
    { text: `${dev.running} running`, styles: dev.running ? ['green', 'bold'] : ['grey'] },
    { text: `${dev.leased} leased`, styles: ['grey'] },
    dev.starting ? { text: `${dev.starting} starting`, styles: ['grey'] } : null,
    dev.queued ? { text: `${dev.queued} queued`, styles: ['yellow'] } : null,
  ].filter(Boolean);
  heading(lines, c, wide, 'DEV', between(counts, ' · '), 'mc dev list');
  for (const server of servers) lines.push(devServerLine(c, wide, server));
  if (dev.queued) {
    const first = dev.queue?.[0]?.name;
    const x = gridColumns(wide).kind.x;
    lines.push(`  ${c('●', 'yellow')}${' '.repeat(x - 3)}${c(clipCell(`${dev.queued} queued${first ? ` · ${first} first` : ''}`, wide - x), 'yellow')}`);
  }
}

/** Queue labels never contain PR numbers: those belong on their repository row. */
function mergeQueueLabel(repo, compact = false, stopped = false) {
  const counts = [
    repo.landings.length ? `${repo.landings.length} landing` : '',
    repo.waiting.length ? `${repo.waiting.length} waiting` : '',
    repo.reds.length ? `${repo.reds.length} red` : '',
  ].filter(Boolean);
  const count = compact && counts.length
    ? `${repo.landings.length + repo.waiting.length + repo.reds.length}`
    : counts.join(', ') || 'idle';
  return [
    { text: `${repo.repo} ${count}`, styles: ['grey'] },
    repo.pause ? { text: ` paused ${compact ? repo.pause.kind : repo.pause.reason}`, styles: ['red'] }
      : repo.merger_stopped && !stopped ? { text: ' merger stopped', styles: ['red'] } : null,
  ].filter(Boolean);
}

/**
 * What a merge row's tail says, after its cells: the round it is batched
 * with, how long it has been queued, or why it is red, and the pull
 * request's title — the title gives way first.
 */
function mergeTail(item) {
  const why = item.kind === 'wait'
    ? [item.batch_of ? { text: `with #${item.batch_of}`, styles: ['grey'] } : null]
    : item.kind === 'gate'
      ? [item.batch_of ? { text: `with #${item.batch_of}`, styles: ['grey'] } : null,
        item.queue_age_seconds != null ? { text: `queued ${ageWords(item.queue_age_seconds)}`, styles: ['grey'] } : null]
      : [one(item.said || item.reason) ? { text: one(item.said || item.reason), styles: ['grey'] } : null];
  return [...why, item.title ? { text: one(item.title), styles: ['grey'] } : null];
}

/** One queue item of MERGES, in the page's grid. */
function mergeItemLine(c, wide, repo, item, first) {
  return gridRow(c, wide, {
    mark: { text: MARK.running, styles: stateTone(item.state) },
    kind: { text: String(item.kind).toUpperCase(), styles: kindTone(item.kind) },
    name: { text: item.name || '—' },
    repo: { text: repo.repo, styles: ['grey'] },
    state: { text: item.state, styles: stateTone(item.state) },
    progress: { text: item.progress || '', styles: ['grey'] },
    pr: prCellOf(item.prs),
    tail: [
      ...mergeTail(item),
      first ? { text: `${repo.day_count} merges in 24 h`, styles: repo.day_count ? ['green'] : ['grey'] } : null,
    ],
  });
}

/**
 * One repository of MERGES, in the page's grid: a row per pull request in its
 * queue — the round landing, the reds, then what waits — at most `QUEUED_DRAWN` of them and a count of the rest. An
 * empty queue is one row of its own: `idle`, how long ago it last landed, and
 * that pull request, in grey.
 */
function mergeRepoLines(c, wide, repo) {
  const items = [...(repo.landings || []), ...(repo.reds || []), ...(repo.waiting || [])];
  if (!items.length) {
    return [gridRow(c, wide, {
      mark: { text: MARK.running, styles: stateTone(repo.state) },
      kind: { text: 'IDLE', styles: kindTone('idle') },
      name: { text: repo.name ?? repo.repo, styles: ['grey'] },
      repo: { text: repo.repo, styles: ['grey'] },
      state: { text: repo.state, styles: stateTone(repo.state) },
      progress: { text: repo.progress ? `${repo.progress} ago` : '', styles: ['grey'] },
      pr: prCellOf(repo.prs),
      // A pause is the heading's, once for the repository, and not repeated here.
      tail: [{ text: repo.last ? `${repo.day_count} merges in 24 h` : 'no landing yet', styles: repo.day_count ? ['green'] : ['grey'] }],
    })];
  }
  const shown = items.slice(0, QUEUED_DRAWN);
  const lines = shown.map((item, index) => mergeItemLine(c, wide, repo, item, index === 0));
  const rest = items.length - shown.length;
  if (rest) lines.push(gridRow(c, wide, { name: { text: `… ${rest} more`, styles: ['grey'] }, repo: { text: repo.repo, styles: ['grey'] } }));
  return lines;
}

/** MERGES is a repository's queue, row by row, drawn only from the JSON's repos[]. */
function mergesLines(lines, c, wide, merges) {
  const repos = merges.repos || [];
  // Liveness and barriers are independent facts. If both hold, name the
  // stopped process once so neither repository loses its pause at 80 columns.
  const stopped = repos.some((repo) => repo.merger_stopped && repo.pause);
  const labels = (compact) => [
    ...repos.flatMap((repo, index) => [
      ...(index ? [{ text: ' · ', styles: ['grey'] }] : []), ...mergeQueueLabel(repo, compact, stopped),
    ]),
    ...(stopped ? [{ text: ' · ', styles: ['grey'] }, { text: 'merger stopped', styles: ['red'] }] : []),
  ];
  let counts = labels(false);
  const countWidth = () => counts.reduce((n, part) => n + part.text.length, 0);
  if (countWidth() > wide - 10) counts = labels(true);
  const verb = countWidth() + 10 + 2 + 'mc merge <repo> <pr>'.length <= wide ? 'mc merge <repo> <pr>' : null;
  heading(lines, c, wide, 'MERGES', counts, verb);
  for (const repo of repos) lines.push(...mergeRepoLines(c, wide, repo));
}

/** The words for whose a pull request is, on a PULL REQUESTS row. */
function ownerWords(owner) {
  if (owner.kind === 'plan') return owner.name ? `plan ${owner.name}` : 'a plan branch';
  if (owner.kind === 'workarea') return `workarea ${owner.name}`;
  if (owner.kind === 'worktree') return `checked out in ${String(owner.path).replace(/^\/Users\/[^/]+/u, '~')}`;
  return 'nobody\'s';
}

/**
 * PULL REQUESTS — every open pull request no goal row already draws.
 *
 * A goal's pull requests are on its row in PROGRAMMES, and the merger's are in
 * MERGES. What is left is what the page could not
 * see at all before: a plan session's, one opened from a terminal, and one
 * nobody holds any more — the last with the waiting mark in yellow, because it
 * is a person's and nobody knows it (Martin, 2026-10-09). The heading counts
 * them all, so the answer to *how many are open* is one place.
 */
function prsLines(lines, c, wide, prs) {
  if (!prs) return;
  // Attached PRs are accounted for by their programme, even when no local
  // worktree holds the branch. Only the remainder can be nobody's here.
  const attached = (prs.items || []).filter((pr) => pr.programme).length;
  const counts = attached ? {} : (prs.counts || {});
  if (attached) for (const pr of prs.items || []) {
    if (!pr.programme) counts[pr.owner.kind] = (counts[pr.owner.kind] || 0) + 1;
  }
  const words = [
    attached ? `${attached} in programmes` : '',
    counts.plan ? `${counts.plan} plan` : '',
    counts.workarea ? `${counts.workarea} in a workarea` : '',
    counts.worktree ? `${counts.worktree} checked out elsewhere` : '',
  ].filter(Boolean);
  const parts = [
    { text: `${prs.count} open`, styles: ['grey'] },
    ...words.map((text) => ({ text, styles: ['grey'] })),
    counts.none ? { text: `${counts.none} nobody's`, styles: ['yellow', 'bold'] } : null,
    prs.age_seconds != null && prs.age_seconds >= 15 * 60
      ? { text: `as of ${ageWords(prs.age_seconds)} ago`, styles: ['yellow'] }
      : null,
  ].filter(Boolean);
  heading(lines, c, wide, 'PULL REQUESTS', prs.fetched ? between(parts, ' · ') : 'not asked yet — mc prs asks GitHub', 'mc prs');
  for (const pr of prs.items || []) {
    if (pr.programme || pr.merging || pr.merge_red) continue;
    lines.push(prRow(c, wide, pr, ownerWords(pr.owner)));
  }
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
  const c = painter(colour);
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
  heading(lines, c, wide, 'PULL REQUESTS', prs?.fetched
    ? `${items.length} open${age != null && age >= 15 * 60 ? ` · as of ${ageWords(age)} ago` : ''}`
    : 'not asked yet', null);
  for (const [title, mine, whose] of groups) {
    const own = items.filter(mine);
    if (!own.length) continue;
    lines.push('');
    heading(lines, c, wide, title, `${own.length}`, null);
    // Whose it is leads here — it is what the list is sorted by — and the
    // title is what gives way; the page's own rows put the title first.
    const width = Math.min(40, Math.max(...own.map((pr) => whose(pr).length)));
    for (const pr of own) {
      const nobody = pr.owner.kind === 'none';
      const mark = pr.merging ? c(MARK.running, 'green')
        : pr.merge_red ? c(MARK.red, 'red', 'bold') : c(nobody ? MARK.waiting : MARK.quiet, nobody ? 'yellow' : 'grey');
      const where = pad(clip(pr.repo || '—', LANE_REPO - 1), LANE_REPO);
      const left = `  ${mark} ${c(where, 'grey')} ${cell(c, `#${pr.number}`, PR_NUMBER, PR_TONE)} `
        + `${cell(c, clip(whose(pr), width), width, nobody ? ['yellow'] : [])}  `;
      const right = pr.merging
        ? paint(c, [{ text: pr.merging === 'landing' ? 'landing now' : 'queued for merge', styles: ['green'] }])
        : pr.merge_red ? paint(c, [{ text: 'red from the merger', styles: ['red', 'bold'] }])
        : paint(c, [{ text: pr.quiet_seconds == null ? '' : `quiet ${ageWords(pr.quiet_seconds)}`, styles: pr.quiet_seconds >= PR_QUIET_S ? ['yellow'] : ['grey'] }]);
      lines.push(row(c, wide, left, `${pr.draft ? 'draft: ' : ''}${pr.title || pr.branch || ''}`, right || null));
    }
  }
  lines.push('');
  return lines;
}

/**
 * A goal in the shared grid. Names and repositories use the terminal foreground;
 * finished rows keep their state and last words quiet without hiding identity.
 * Criteria remain available in the goal detail and JSON.
 */
function goalLine(c, wide, goal) {
  const word = goal.stage ?? goal.state ?? '—';
  const tone = goal.status === 'blocked' ? stateTone('blocked')
    : goal.running ? ['green']
    : word === 'plan' ? ['cyan'] : stateTone(word);
  const finished = goal.stage === 'done' || goal.stage === 'dropped';
  const said = finished ? (goal.last?.done ?? goal.last?.comment ?? null) : (goal.question ?? goal.last?.next ?? goal.last?.comment ?? null);
  const waits = goal.held ? `phase ${goal.phase} — after phase ${goal.phase - 1}` : null;
  let tail = said ? [{ text: said, styles: finished ? ['grey'] : [] }] : [];
  if (goal.problems?.length) tail = [{ text: `GOAL.json: ${goal.problems[0]}`, styles: ['red'] }];
  else if (waits) {
    tail = [{ text: waits, styles: stateTone('waiting') }, said && one(said) !== waits ? { text: said } : null];
  } else if (goal.person) {
    const head = 'waits on a person';
    tail = [{ text: 'blocked', styles: stateTone('blocked') }, { text: head, styles: stateTone('blocked') },
      said && one(said) !== head ? { text: said } : null];
  }
  return gridRow(c, wide, {
    mark: { text: MARK.running, styles: goal.problems?.length ? ['red'] : goal.held ? stateTone('waiting') : tone },
    kind: { text: '' },
    name: { text: goal.name, styles: goal.running ? ['bold'] : [] },
    repo: { text: goal.repo ?? goal.repos?.[0] ?? '—' },
    state: { text: word, styles: tone },
    progress: { text: goal.progress ?? '', styles: ['grey'] },
    pr: prCellOf(goal.prs),
    tail,
  });
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
    const provider = item.tool === 'claude-code' ? 'claude' : item.tool || 'unknown';
    providers[provider] = (providers[provider] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(providers).sort(([a], [b]) => a.localeCompare(b)));
}

/** `done 13 · blocked 5` — states by count, biggest first, as the PROGRAMMES heading draws them. */
export function statusRollup(statuses = {}) {
  return Object.entries(statuses).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function programmeLine(c, wide, group) {
  const meta = planSessionWords(group);
  const opened = (group.sessions || []).length;
  const goals = (group.goals || []).length;
  const parts = [
    { text: group.programme, styles: ['bold', 'cyan'] },
    { text: goals ? `${goals} goal${goals === 1 ? '' : 's'}` : 'no goal yet' },
    (group.prs || []).length ? { text: `${group.prs.length} pr`, styles: ['grey'] } : null,
    { text: meta ? `● plan ${meta}` : 'no plan session', styles: meta ? ['cyan'] : ['grey'] },
    opened ? { text: `${opened} open`, styles: ['cyan'] } : null,
    group.proposals ? { text: `${group.proposals} proposal${group.proposals === 1 ? '' : 's'}`, styles: ['grey'] } : null,
  ].filter(Boolean);
  const visible = [];
  let used = 0;
  for (const part of parts) {
    const size = part.text.length + (visible.length ? 3 : 0);
    if (used + size > wide - 2) break;
    visible.push(part);
    used += size;
  }
  const label = `  ${paint(c, between(visible, ' · '), wide - 2)}`;
  const room = wide - width(label) - 2;
  return room >= 3 ? `${label}  ${c('─'.repeat(room), 'cyan')}` : label;
}

function programmePrLine(c, wide, pr) {
  const state = pr.merge_red ? 'red' : pr.merging || (pr.draft ? 'draft' : 'open');
  return gridRow(c, wide, {
    mark: { styles: pr.merge_red ? ['red'] : pr.merging ? ['green'] : ['grey'] },
    kind: { text: 'pr', styles: PR_TONE },
    name: { text: pr.title || pr.branch || '—' },
    repo: { text: pr.repo, styles: ['grey'] },
    state: { text: state, styles: stateTone(state) },
    pr: prCellOf([pr]),
    tail: [{ text: pr.merge_red || pr.branch || '', styles: ['grey'] }],
  });
}

function programmeColumnHead(c, wide) {
  const col = gridColumns(wide);
  let line = '';
  for (const [key, title] of [['name', 'NAME'], ['repo', 'REPOSITORY'], ['state', 'STAGE'], ['progress', 'SESS'], ['pr', 'PR'], ['tail', 'LATEST']]) {
    if (!col[key].width) continue;
    line = line.padEnd(col[key].x) + clip(title, col[key].width - 1);
  }
  return c(line, 'bold');
}

function programmesLines(lines, c, wide, programmes, expand) {
  const statuses = statusRollup(programmes.statuses)
    .map(([status, n]) => ({ text: `${status} ${n}`, styles: statusTone(status) }));
  const groups = programmes.programmes || [];
  // A page from before the flag has every programme active, as it was drawn.
  const asleep = groups.filter((group) => group.dormant);
  const dormant = programmes.dormant ?? asleep.length;
  const active = programmes.active ?? groups.length - dormant;
  heading(lines, c, wide, 'PROGRAMMES', [
    { text: `${active} active · ${dormant} dormant · ${programmes.count} goal${programmes.count === 1 ? '' : 's'}  `, styles: ['grey'] },
    ...between(statuses, ' · '),
  ], 'p  plan a programme');

  // The dormant programmes — no goal — are this one line and not a
  // heading each: on 2026-11-02 they were 27 of 41 headings, every one saying
  // that it had nothing yet. Directly under the heading, where the counts it explains
  // are, rather than after the last active group's rows, where it reads as part
  // of that programme. A live plan session is the one thing on a dormant
  // programme somebody may come looking for, so the line counts those.
  // Expanded (`a`), every programme is drawn and the line is not needed.
  if (!expand && asleep.length) {
    const planned = asleep.filter((group) => planSessionWords(group)).length;
    const withProposals = asleep.filter((group) => group.proposals > 0).length;
    say(lines, c, wide, 2, [
      `${asleep.length} dormant`,
      planned ? `${planned} with a plan session` : '',
      withProposals ? `${withProposals} with proposals` : '',
      'mc programs list',
    ].filter(Boolean).join(' · '));
  }

  lines.push(programmeColumnHead(c, wide));
  for (const group of groups) {
    if (group.dormant && !expand) continue;
    lines.push(programmeLine(c, wide, group));
    for (const goal of group.goals || []) lines.push(goalLine(c, wide, goal));
    for (const pr of group.prs || []) lines.push(programmePrLine(c, wide, pr));
  }
  strayLines(lines, c, wide, programmes.strays);

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
  const room = Math.max(12, wide - 2 - 'MC'.length - 2);
  // The state before the bookkeeping, and in a short form when the long one
  // does not fit: it is the only part of the line that can ask for anything.
  const short = asked ? 'draining' :(info.behind ? 'update available' : state.text);
  const lead = [{ text: version || '', styles: ['grey'] }];
  const rest = [
    { text: info.up_seconds == null ? 'runner not running' : `runner up ${duration(info.up_seconds)}`, styles: ['grey'] },
    { text: info.commit ? `${info.predecessor && info.pid ? `pid ${info.pid} ` : ''}on ${info.commit}` : '', styles: ['grey'] },
    {
      text: info.predecessor
        ? `pid ${info.predecessor.pid} finishing ${info.predecessor.steps.length} session${info.predecessor.steps.length === 1 ? '' : 's'}${info.predecessor.steps.length ? ` (${info.predecessor.steps.join(', ')})` : ''}`
        : '',
      styles: ['grey'],
    },
    ...(info.behind_checkout || []).map((p) => ({ text: `${p.name} pid ${p.pid} on ${p.commit} · checkout ${info.head}`, styles: ['yellow'] })),
    { text: caches?.offline ? 'offline — plans as last fetched' : '', styles: ['grey'] },
  ];
  const long = trailing([...lead, state]);
  const fits = long.reduce((n, part) => n + part.text.length, 0) <= room;
  heading(lines, c, wide, 'MC', fitting(trailing([
    ...lead,
    fits ? state : { ...state, text: short },
    { text: info.hooks ? `hooks: ${info.hooks} · mc hook install` : '', styles: ['yellow'] },
    ...rest,
  ]), room), null);
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
  say(lines, c, wide, 2, parts.join(' · '));
}

/* ------------------------------------------------------------------- page */

/**
 * The whole page, as lines. `data` is exactly what `--json` prints: one key
 * per section, so the two can never say different things.
 */
export function renderPageLines(data, {
  columns = 100, colour = false, version = '', now = new Date(), expand = false,
} = {}) {
  const c = painter(colour);
  const wide = Math.max(60, Math.min(columns, 160));
  const at = now instanceof Date ? now.getTime() : Number(now);
  const lines = [];

  const cost = money(data.runner?.day?.cost);
  const brand = `${c('MEMORO·CLI', 'bold')}${version ? c(`  ${version}`, 'grey') : ''}`;
  // What is true of the work, in three numbers that are all on the page below:
  // the sessions the runner has in flight (SESSIONS), and the goals that are
  // ready and blocked (PROGRAMMES). The three ride in one part so that a
  // narrow terminal drops the cost rather than half of the answer.
  const statuses = data.programmes?.statuses || {};
  const flight = (data.runner?.sessions || []).length;
  // Counted on the plain text, and the narrowest terminal keeps the count it
  const parts = [
    { text: `${flight} in flight · ${statuses.ready || 0} ready · ${statuses.blocked || 0} blocked` },
    cost ? { text: `${cost} today`, styles: ['grey'] } : null,
  ].filter(Boolean);
  const plain = () => parts.map((part) => part.text).join('  ·  ');
  while (parts.length > 1 && width(brand) + plain().length + 6 > wide) parts.pop();
  const counts = paint(c, between(parts, '  ·  '));
  // A narrow terminal gives up the version first, then the rule: the counts are
  // the answer, and the MC line below says the version again.
  const head = width(brand) + width(counts) + 6 <= wide ? brand : c('MEMORO·CLI', 'bold');
  const rule = wide - width(head) - width(counts) - 4;
  lines.push('');
  lines.push(rule >= 2
    ? `  ${head} ${c('─'.repeat(rule), 'grey')} ${counts}`
    : `  ${head}  ${counts}`);
  lines.push('');
  // A language run stopped inside a gap is production half-way between two
  // states: above every section, until `mc language resume` closes it.
  openGapLine(lines, c, wide, data.language?.open_gap);

  const sessions = data.sessions || { desks: {} };
  // The order is Martin's (2026-09-19), and it still keeps the rule the page
  // had: **what does not move sits above what does.** The live loop rewrites
  // rows where they stand (page-live.js), and a row near the prompt is one it
  // can always reach. PROGRAMMES is the page as a listing; MAINTENANCE
  // changes with its readings; SESSIONS and DEV every frame;
  // MERGES, DEPLOY, LANGUAGE, CHECKS and the MC line are the
  // short end of the page.
  programmesLines(lines, c, wide, data.programmes, expand);
  lines.push('');
  maintenanceLines(lines, c, wide, sessions, data.intake, data.checks);
  lines.push('');
  runnerLines(lines, c, wide, { ...data.runner, at_ms: at });
  lines.push('');
  // DEV changes as often as the sessions do, so it stands right under them.
  if (data.dev) {
    devLines(lines, c, wide, data.dev);
    lines.push('');
  }
  mergesLines(lines, c, wide, data.merges);
  lines.push('');
  if (data.prs) {
    prsLines(lines, c, wide, data.prs);
    lines.push('');
  }
  deployLines(lines, c, wide, data.runner?.production);
  lines.push('');
  if (languageLines(lines, c, wide, data.language, at)) lines.push('');
  checksLines(lines, c, wide, data.checks);
  lines.push('');
  dockerLine(lines, c, wide, data.docker);
  mcLine(lines, c, wide, data.mc, data.caches, version);
  if (data.billing) lines.push(`  ${c('BILLING', 'cyan')}  ${c(clip(data.billing, wide - 11), 'grey')}`);
  for (const note of data.notes || []) {
    // How old the PR cache is was the page's last line, every time, and it was
    // never what anybody came for; `mc --json` has it under `caches`.
    if (/^PRs from cache|^no PR cache yet/u.test(note)) continue;
    say(lines, c, wide, 2, `note: ${note}`);
  }
  return lines;
}

export function renderPage(data, options = {}) {
  return `${renderPageLines(data, options).join('\n')}\n`;
}
