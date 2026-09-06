/**
 * How the page looks: the five sections `page-collect.js` gathers, drawn as
 * lines.
 *
 * The rules the drawing keeps:
 *
 *   - **A number where a number is the answer**, a line only where the
 *     identity matters — and every count names the verb that expands it, on
 *     the right of its own heading.
 *   - **What is not actionable is collapsed, never dropped.** A programme's
 *     blocked projects are one row that keeps their numbers, so the page gets
 *     shorter without any project leaving it, and `expand` — `a` at the menu —
 *     draws every one of them again.
 *   - **Width-aware.** `stdout.columns` clamped to 60–160 through `width`,
 *     `pad` and `clip` from status-render.js, which are escape-aware. Nothing
 *     here is padded to a number somebody typed once.
 *   - **Colour carries state, never decoration**: green is running, yellow
 *     waits on a person, red has failed, grey is quiet. Only on a TTY, and
 *     only when `NO_COLOR` is unset or empty — the convention is that any
 *     non-empty value turns colour off.
 *
 * The palette is a table rather than a habit, so a kind and a status look the
 * same wherever they are printed: `KIND_TONE` for what the runner is doing
 * (step, triage, the foreground verbs) and `STATUS_TONE` for where
 * a plan stands. Everything else is structure — cyan headings, grey for the
 * bookkeeping, and the terminal's own foreground for the text a person is
 * reading, with `bold` on the name a row is about.
 *
 * Two colours this file does not use, and will not: `dim` and `white`. `dim
 * grey` is `ESC[2m` over `ESC[90m`, two steps away from the foreground, and it
 * drew the repository of all 41 project rows at or below the background of
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
import { clip, pad, painter, width } from './status-render.js';

/** Same glyphs as the old board, so nothing new has to be learnt. */
const MARK = { running: '●', waiting: '◆', stopped: '■', quiet: '·' };

/** Where a plan stands, one colour each, wherever a status is printed. */
const STATUS_TONE = {
  ready: ['green'],
  blocked: ['red'],
  done: ['grey'],
  // A plan that does not parse is not a quiet state: the runner will refuse it
  // at the door, and nobody will be told unless the page says so.
  invalid: ['red', 'bold'],
};

/** What is being done, one colour each, wherever a kind is printed. */
const KIND_TONE = {
  step: ['green'],
  // A repair is the runner's next move on a held pull request, not new work —
  // yellow, the same as the held rows further down the section.
  repair: ['yellow'],
  triage: ['blue'],
  brief: ['cyan'],
  plan: ['cyan'],
};

/** A step kind's colour; anything the runner would skip is bookkeeping. */
function kindTone(kind) {
  return KIND_TONE[String(kind || '').replace(/^mc /u, '')] || ['grey'];
}

/** A plan status's colour; no plan at all is bookkeeping, and grey says so. */
function statusTone(status) {
  return STATUS_TONE[status] || ['grey'];
}

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

/** `4 min`, `2.5 h` — a span as a person says it. */
export function duration(seconds) {
  if (seconds == null) return '?';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 180 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
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
 * RUNNER — what `mc run` is doing, and nothing else.
 *
 * It was NOW, and NOW drew the runner's steps and the sessions a person had
 * open as one list of dots. The two are stopped by different things and read
 * for different reasons; together they meant a `mc plan` left open since
 * Sunday sat in the same column as a step four minutes into its budget. The
 * sessions have a section of their own now.
 */
function runnerLines(lines, c, wide, runner) {
  const now = runner;
  heading(lines, c, wide, 'RUNNER', null, 'mc run');
  // One row per lane, step or no step. `mc run` drives one lane per repository
  // at the same time, and a lane is a lane between steps as much as during one:
  // with a row only where there was a step, a lane waiting for its next project
  // and a lane whose process had died looked exactly alike, which is nothing at
  // all. A runner that is not running has no lanes, and says so in one line.
  const lanes = now.lanes || [];
  if (lanes.length && (now.process?.alive || lanes.some((lane) => lane.step))) {
    for (const lane of lanes) lines.push(laneLine(c, wide, lane));
  } else {
    lines.push(`  ${c(MARK.quiet, 'grey')} ${c('the runner is not running — mc run starts it', 'grey')}`);
  }
  if (now.stop) {
    lines.push(`  ${paint(c, [
      { text: `${MARK.stopped} STOP requested`, styles: ['red', 'bold'] },
      { text: ' — the runner exits after the steps it is in', styles: ['grey'] },
    ], wide - 2)}`);
  }
  for (const line of now.stale) say(lines, c, wide, 2, `${MARK.quiet} stale: ${line}`, 'red');
  const day = now.day;
  const up = now.process?.alive ? `runner up ${duration(now.process.up_seconds)} · ` : '';
  const cost = money(day.cost);
  say(lines, c, wide, 2, `${up}${day.steps} steps in 24 h — merged ${day.merged}, open ${day.open}, `
    + `failed ${day.failed}, timed out ${day.timeout}`
    + `${cost ? ` · ${cost} list (${day.model}, ${day.prices_dated})` : ''}`);
  productionLine(lines, c, wide, now.production);
  if (now.quota.count) {
    // Yellow while a refusal is recent enough to still be the reason the
    // runner is idle; older than that it is history, and history is grey.
    const at = Date.parse(now.quota.last);
    const recent = Number.isFinite(at) && now.at_ms - at < QUOTA_FRESH_MS;
    say(lines, c, wide, 2, `quota: ${now.quota.count} answer(s) in the last 24 h, last ${when(now.quota.last)}`,
      recent ? 'yellow' : 'grey');
  }
}

/** The two columns of a lane: the repository it is, and the project it has. */
const LANE_REPO = 11;
const LANE_NAME = 22;

/**
 * One lane: the repository, then the project the runner has in flight there.
 *
 * The repository leads because it is what the lane *is* — there is one per
 * repository and no other way to tell two of them apart. The pid used to sit at
 * the end of the row and was the runner's own: `current-memoro.json` and
 * `current-memoro-cli.json` both carry `"pid": 11480` because both lanes are
 * that one process, so the same number was drawn on every row and killed
 * nothing. It stays in `mc --json` and in `mc status`, where a number is a
 * thing to use rather than a thing to read.
 */
function laneLine(c, wide, lane) {
  const repo = c(pad(clip(lane.repo || 'unplaced', LANE_REPO - 1), LANE_REPO), 'grey');
  const s = lane.step;
  if (!s) return `  ${c(MARK.quiet, 'grey')} ${repo} ${c('nothing in flight', 'grey')}`;
  const budget = s.budget_seconds == null ? '' : ` of ${duration(s.budget_seconds)}`;
  const meta = paint(c, between([
    { text: s.kind, styles: kindTone(s.kind) },
    { text: [s.tool, s.model].filter(Boolean).join(' '), styles: ['grey'] },
    {
      text: `${duration(s.elapsed_seconds)}${budget}${s.over_budget ? ' — over budget' : ''}`,
      styles: elapsedTone(s),
    },
  ], ' · '), wide - 6 - LANE_REPO - LANE_NAME);
  return `  ${c(MARK.running, 'green')} ${repo} ${c(pad(clip(s.name, LANE_NAME - 1), LANE_NAME), 'bold')} ${meta}`
    .replace(/[ ]+$/u, '');
}

/**
 * What is in production, in one line under the runner's day — and what is wrong
 * with it first.
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
function productionLine(lines, c, wide, production) {
  if (!production) return;
  const live = production.live;
  const liveAge = live ? ` (${ageWords(live.age_seconds)} old)` : '';
  const room = wide - 2;
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
  } else if (!production.sha) {
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
  lines.push(`  ${paint(c, fitting(parts, room), room)}`);
}

/** Past this, the age is the thing on the row worth looking at. */
const STALE_SESSION_S = 24 * 60 * 60;
const ageTone = (seconds) => (seconds != null && seconds >= STALE_SESSION_S ? ['yellow'] : ['grey']);
const openFor = (seconds) => (seconds == null ? 'open' : `open ${ageWords(seconds)}`);

/**
 * One desk — HELPER or BRIEF — as a heading with its state beside it.
 *
 * Drawn whether or not anybody is at it. There is exactly one of each, so
 * *"is the helper running?"* is a question a row answers either way, and a
 * section that vanishes when nothing is open answers nothing at all.
 */
function deskLine(lines, c, wide, title, session, verb) {
  if (!session) {
    heading(lines, c, wide, title, [{ text: `${MARK.quiet}  not open`, styles: ['grey'] }], verb);
    return;
  }
  heading(lines, c, wide, title, [
    { text: `${MARK.running} `, styles: ['cyan'] },
    ...between([
      { text: openFor(session.age_seconds), styles: ageTone(session.age_seconds) },
      { text: [session.tool, session.model].filter(Boolean).join(' '), styles: ['grey'] },
      { text: session.pid ? `pid ${session.pid}` : '', styles: ['grey'] },
    ], ' · '),
  ], verb);
}

/**
 * WORK — everything running that the runner did not start, oldest first.
 *
 * The age is the point of the section. All of these were on the page before;
 * what was missing was how long each had been there, so on 2026-09-02 seven
 * live sessions — the oldest three days old — read as a busy afternoon. Past
 * a day the age turns yellow, because by then it is the thing on the row.
 */
function workLines(lines, c, wide, sessions, unplanned) {
  const others = sessions.others || [];
  const folders = unplanned || { count: 0, shown: [], more: 0 };
  const counts = [
    others.length ? `${others.length} session${others.length === 1 ? '' : 's'}` : '',
    folders.count ? `${folders.count} workarea${folders.count === 1 ? '' : 's'} with no project` : '',
  ].filter(Boolean).join(' · ');
  heading(lines, c, wide, 'WORK', counts || 'nothing open', 'mc work <name>');
  for (const item of others) {
    const meta = paint(c, between([
      { text: item.verb ? `mc ${item.verb}` : 'tmux', styles: ['cyan'] },
      { text: openFor(item.age_seconds), styles: ageTone(item.age_seconds) },
      { text: [item.tool, item.model].filter(Boolean).join(' '), styles: ['grey'] },
      { text: item.pid ? `pid ${item.pid}` : (item.tmux || ''), styles: ['grey'] },
    ], ' · '), wide - 28);
    // Cyan for a verb somebody typed, yellow for a tmux window nobody is
    // necessarily in — the same two meanings those colours carried before.
    const mark = item.verb ? c(MARK.running, 'cyan') : c(MARK.waiting, 'yellow');
    lines.push(`  ${mark} ${c(pad(clip(item.area || '?', 21), 22), 'bold')} ${meta}`);
  }

  // The folders no project explains, under the same heading as the sessions.
  // They were the tail of PROJECTS, which made that section answer two
  // questions — where the work stands, and which directories are left over —
  // and the second is this one's: a workarea with nothing to explain it is
  // work in exactly the sense WORK means, and often the same folder somebody
  // has a session open in.
  //
  // One line, not one row each. Twelve of them were drawn every time, and the
  // twelve rows never changed: nothing removes such a folder (close-workarea.js)
  // and no page can decide whether one should go. The count is on the heading
  // above, the numbers still open them, and `mc run` writes the whole list —
  // with the one fact the page could not have, whether the branch has landed —
  // to `~/mc/runner/unplanned-workareas.md` once a round. It is raised at every
  // brief besides.
  if (!folders.count) return;
  const room = wide - 7;
  const numbers = numberRanges((folders.shown || []).map((area) => area.number));
  lines.push(`       ${paint(c, fitting([
    { text: numbers, styles: ['grey'] },
    { text: `${numbers ? '  ·  ' : ''}~/mc/runner/unplanned-workareas.md`, styles: ['grey'] },
    { text: '  has them all', styles: ['grey'] },
  ], room), room)}`);
}

/** How the clock reads: plain, then yellow near the budget, then red past it. */
function elapsedTone(step) {
  if (step.over_budget) return ['red', 'bold'];
  const spent = step.elapsed_seconds;
  if (step.budget_seconds && spent != null && spent >= step.budget_seconds * 0.75) return ['yellow'];
  // Not white: a clock inside its budget is text to read, and reads in the
  // colour the rest of the row does.
  return [];
}

/** The widths of a NEXT row: the project, then what the runner would start. */
const NEXT_NAME = 26;
const NEXT_KIND = 12;

/**
 * NEXT — the order `mc run` would take, one block per lane.
 *
 * It was QUEUE and it drew `~/mc/queue.md` alone, so an empty file said *empty*
 * while the runner walked 41 projects. The list is `assembleQueue`'s now
 * (page-collect.js), and the heading says how much of it `queue.md` chose: with
 * the file empty that reads *the order is alphabetical*, which is what the
 * runner is actually doing, rather than a queue that is not there.
 *
 * One block per lane, because the lanes run at the same time: the head of each
 * one starts now, and a flat list would put one of them second. Three deep,
 * with the rest of the lane a count on its own heading — past the third, what
 * is coming has usually changed by the time it arrives.
 */
function nextLines(lines, c, wide, next) {
  const counts = next.depth
    ? `${next.runnable} runnable of ${next.depth}`
    : 'nothing on main to run';
  // Where the order came from, said on the heading: `queue.md` is Martin's
  // *these first* and it empties itself, so its own count is the difference
  // between an order somebody chose and one that fell out alphabetically.
  const order = next.depth
    ? [{ text: ' · ', styles: ['grey'] }, {
      text: next.from_queue
        ? `${next.from_queue} from queue.md, then alphabetical`
        : 'the order is alphabetical',
      styles: ['grey'],
    }]
    : [];
  // A pull request the runner would not land is not a lane's depth, but it is
  // the reason a project is not in the order at all — so it rides on the
  // heading's own count line, where the section's answer already is.
  const held = next.held?.count
    ? [{ text: ' · ', styles: ['grey'] }, { text: `held before merge ${next.held.count}`, styles: ['yellow', 'bold'] }]
    : [];
  // Beside it, and green rather than yellow: a queued merge is the runner's
  // own next move — nobody has to type anything for it to land.
  const queued = next.queued?.count
    ? [{ text: ' · ', styles: ['grey'] }, { text: `queued for merge ${next.queued.count}`, styles: ['green', 'bold'] }]
    : [];
  heading(lines, c, wide, 'NEXT', [{ text: counts, styles: ['grey'] }, ...order, ...held, ...queued], 'mc status <name>');

  for (const lane of next.lanes || []) {
    lines.push(`     ${paint(c, between([
      { text: lane.repo || 'no repository', styles: ['bold'] },
      { text: `${lane.count} runnable`, styles: ['grey'] },
      { text: lane.more ? `… ${lane.more} more` : '', styles: ['grey'] },
    ], ' · '), wide - 5)}`);
    for (const [index, item] of lane.items.entries()) {
      // The head of the lane is bold — it is the one starting now; the rest are
      // the terminal's own text, and painting them made the first harder to
      // find. `step 2/5` is where in its plan the project is, which a name and
      // a kind never said.
      const label = pad(clip(item.name, NEXT_NAME - 1), NEXT_NAME);
      const name = index === 0 ? c(label, 'bold') : label;
      const at = item.step && item.steps ? ` ${item.step}/${item.steps}` : '';
      const kind = paint(c, [{ text: pad(`${item.kind}${at}`, NEXT_KIND), styles: kindTone(item.kind) }]);
      lines.push(row(c, wide, `       ${name}${kind}`, item.title || '', null));
    }
  }

  if (next.skipped.count) {
    // What was passed over is the quietest thing in the section: it is the
    // reason a name is *not* above. Grey is how the page says so — it recedes
    // by sitting under the rows and by being the one grey line among them,
    // which is a step a person can still read.
    const reasons = Object.entries(next.skipped.reasons).map(([why, n]) => `${why} ${n}`).join(', ');
    lines.push(`       ${paint(c, [
      { text: `skipped ${next.skipped.count} (${reasons})`, styles: ['grey'] },
    ], wide - 7)}`);
  }
  heldLines(lines, c, wide, next.held);
  queuedLines(lines, c, wide, next.queued);
  staleLine(lines, c, wide, next.stale);
}

/** How many held pull requests the page names before it only counts them. */
export const HELD_DRAWN = 6;

/**
 * One row per pull request the runner left open: the project, the number, and
 * the reason it was not landed.
 *
 * Yellow, like `blocker finished` under it: nothing in the runner is going to
 * move this on its own — it waits on a repair session or on a person. Drawn
 * under the skips because that is what it is: the skips now count a held
 * project too (`held-after-repair`, `in-flight` — nextSection reads the
 * machine as well as the plans), and these rows say which pull request and
 * why, which a count of two never could.
 *
 * The reason is clipped rather than the row: the project and the number are
 * what a person acts on, and `mc --json` carries every entry whole.
 */
function heldLines(lines, c, wide, held) {
  if (!held?.count) return;
  for (const item of held.items.slice(0, HELD_DRAWN)) {
    const left = `· ${item.project || 'unknown'}  #${item.pr}  `;
    const reason = clip(one(item.reason), Math.max(8, wide - 7 - left.length));
    lines.push(`       ${paint(c, [
      { text: left, styles: ['yellow', 'bold'] },
      { text: reason, styles: ['yellow'] },
    ], wide - 7)}`);
  }
  const more = held.count - Math.min(held.count, HELD_DRAWN);
  if (more) lines.push(`       ${paint(c, [{ text: `· … ${more} more`, styles: ['yellow'] }], wide - 7)}`);
}

/** How many queued pull requests the page names before it only counts them. */
export const QUEUED_DRAWN = 6;

/**
 * One row per pull request a hand `mc merge` left for the runner's merge lane:
 * the repository, the number, why the round it was given did not land, and how
 * long it has been waiting.
 *
 * Under the held rows, and green where those are yellow, because the two say
 * opposite things to the person reading them: a held pull request waits for
 * them, a queued one does not. The repository is drawn rather than a project —
 * a queued pull request need not belong to one, and the number is only a
 * number until the repository is beside it.
 */
function queuedLines(lines, c, wide, queued) {
  if (!queued?.count) return;
  for (const item of queued.items.slice(0, QUEUED_DRAWN)) {
    const left = `· ${item.repo || 'unknown'}  #${item.pr}  `;
    const since = item.since ? `  (since ${when(item.since)})` : '';
    const reason = clip(one(item.reason), Math.max(8, wide - 7 - left.length - since.length));
    lines.push(`       ${paint(c, [
      { text: left, styles: ['green', 'bold'] },
      { text: reason, styles: ['green'] },
      { text: since, styles: ['grey'] },
    ], wide - 7)}`);
  }
  const more = queued.count - Math.min(queued.count, QUEUED_DRAWN);
  if (more) lines.push(`       ${paint(c, [{ text: `· … ${more} more`, styles: ['green'] }], wide - 7)}`);
}

/**
 * The one line for a plan that has been waiting for nothing: a step blocked
 * on a project that is finished or gone from main (stale-blockers.js).
 * Yellow, because the palette's yellow is what waits on a person and this is
 * the page asking for one — nothing flips a blocker but a human with a plan
 * edit.
 *
 * It says **blocker finished** and not *stale*, though the mechanism is named
 * for staleness, because RUNNER two sections up already spends that word on a
 * lane file whose process is gone. One word, one meaning, on one page.
 *
 * It says *done or no longer on main* and not *not coming*, because those are
 * the only two things the check can know — `stale-blockers.js` computes `why`
 * as `is done` or `is not on main` and its docstring is careful about the
 * difference, since a project also leaves main when it is abandoned. The
 * header said *not coming*, which is a prediction neither the module nor
 * anything else on this page is entitled to make.
 *
 * It is drawn under `skipped` rather than beside it on purpose. `skipped` is
 * the runner declining work correctly; this is the runner declining work it
 * should have been given, and reading as one number would hide it inside the
 * other. Absent when there are none, which is the state to expect.
 */
function staleLine(lines, c, wide, stale) {
  if (!stale?.count) return;
  // One line each, not one line for all of them: at 120 columns a second name
  // was already being clipped away, and a fault a person has to widen the
  // terminal to see is one the page has not really reported.
  lines.push(`       ${paint(c, [
    { text: `blocker finished ${stale.count}`, styles: ['yellow', 'bold'] },
    { text: ' — a blocked step names a project that is done or no longer on main', styles: ['yellow'] },
  ], wide - 7)}`);
  for (const item of stale.items) {
    lines.push(`       ${paint(c, [
      { text: `· ${item.project} step ${item.step} on ${item.blocker}, which ${item.why}`, styles: ['yellow'] },
    ], wide - 7)}`);
  }
  if (stale.more) lines.push(`       ${paint(c, [{ text: `· … ${stale.more} more`, styles: ['yellow'] }], wide - 7)}`);
}

/** How much of a `!` line the message must keep for the fingerprint to stay. */
const MESSAGE_SHARE = 0.6;

/**
 * INTAKE — the helper's block: one row per repository that has a digest, and
 * how many proposals nobody has queued or dropped.
 *
 * One row each rather than the newest of the two. There are two digests a day
 * since the collect was split per repository, and showing the newer silently
 * hid whichever was collected first — which in practice was memoro-cli's, the
 * digest about this machine. The section is one row longer and says both.
 *
 * The `!` lines come under their own repository's row and whole. The digest
 * marks a new fingerprint `!` when it crossed the threshold, or a condition
 * `!` when it has just started failing; a count of those is a number somebody
 * has to go and look up, and the line is what makes them look.
 */
function intakeLines(lines, c, wide, intake) {
  const repos = intake.repos || [];
  if (!repos.length) {
    heading(lines, c, wide, 'INTAKE', 'no digest yet — mc helper --intake has not run', null);
    if (intake.proposals) say(lines, c, wide, 7, `${intake.proposals} proposal(s) waiting`, 'yellow');
    return;
  }
  heading(lines, c, wide, 'INTAKE', between([
    { text: `${repos.length} digest${repos.length === 1 ? '' : 's'}`, styles: ['grey'] },
    { text: `${intake.proposals} proposal${intake.proposals === 1 ? '' : 's'}`, styles: intake.proposals ? ['yellow'] : ['grey'] },
  ], ' · '), 'mc helper --intake');
  for (const repo of repos) {
    const age = repo.age_seconds == null ? '' : ` (${ageWords(repo.age_seconds)} old)`;
    const errors = repo.first
      ? 'first digest — no baseline'
      : `${repo.new_errors} new error${repo.new_errors === 1 ? '' : 's'}${repo.loud ? ` (${repo.loud} loud)` : ''}`;
    // A digest under a day old is green because somebody has looked; older,
    // and the age itself is the thing to see.
    const fresh = repo.age_seconds != null && repo.age_seconds < 24 * 60 * 60;
    lines.push(`       ${paint(c, between([
      { text: repo.repo, styles: ['bold'] },
      { text: `${repo.date}${age}`, styles: repo.age_seconds == null ? ['grey'] : (fresh ? ['green'] : ['yellow']) },
      { text: errors, styles: !repo.first && repo.new_errors ? ['red'] : ['grey'] },
    ], ' · '), wide - 7)}`);
    // The message first. The digest writes the fingerprint first — `` `abc` — 41×
    // 500 — <message>` `` — and a `!` line drawn in that order spends the row on
    // a hash nobody reads and a count that means nothing until the message has
    // been read; at 100 columns the clip was taking exactly the half that makes
    // somebody look. The fingerprint is what you grep the digest for once you
    // have decided to, so it comes after, and gives way to the width first.
    for (const line of repo.loud_lines || []) {
      const room = wide - 7;
      const tail = [line.count, line.fingerprint && `\`${line.fingerprint}\``].filter(Boolean).join(' ');
      const behind = tail ? ` — ${tail}` : '';
      // The fingerprint is how a person looks the error up once they have
      // decided to, so it stays while the message still has most of the row. On
      // a narrow terminal it goes altogether rather than take half the line.
      const keep = Boolean(behind) && room - behind.length >= Math.round(room * MESSAGE_SHARE);
      const message = { text: clip(one(line.message), keep ? room - behind.length : room), styles: ['bold'] };
      lines.push(`  ${c('  !', 'red')}  ${paint(c, keep ? [message, { text: behind, styles: ['grey'] }] : [message], room)}`);
    }
    if (repo.more_loud) say(lines, c, wide, 7, `… ${repo.more_loud} more above the threshold`);
  }
}


/**
 * The fixed columns of a project row, sized to the terminal rather than to a
 * number somebody typed once — which is the rule this file keeps everywhere
 * else, and the one a first draft of this section broke: 41 columns of name
 * plus 17 of status is wider than the 60-column floor all by itself.
 *
 * `blocked` and `invalid` are the longest statuses there are — seven columns.
 * The cell was seventeen, sized when `waiting-decision` existed, and ten of
 * those columns had been empty ever since; they go to `next`, which is the one
 * cell on the row whose whole value is how much of the sentence survives.
 *
 * The repository has a column of its own now: the section groups by programme,
 * so which of the two a project lives in is a fact about the row rather than
 * the shape of the page. `memoro-cli` is the longer of the two names.
 *
 * The name is the project's alone — the programme is the heading above it — so
 * it needs `language-voice-transcript-hygiene` and nothing wider.
 */
function projectColumns(wide) {
  const roomy = wide >= 90;
  const status = roomy ? 9 : 8;
  const steps = roomy ? 8 : 6;
  const repo = roomy ? 12 : 0;
  return { status, steps, repo, name: Math.max(16, Math.min(34, wide - 10 - status - steps - repo - 8)) };
}

/**
 * One project row: the number the menu opens it by, which repository it lives
 * in, where the plan stands, how far through its steps it is, and what happens
 * next.
 *
 * The name is the project's alone — the programme is the heading above it now,
 * and repeating it on every row said the same word four times in a column
 * eight rows tall. The steps cell is what a list of names could never say:
 * `3/7` is where the work stands.
 *
 * The `●` means the runner has a step in flight on this project. It used to
 * mean a live tmux area — somebody sitting in the folder — which made one mark
 * answer two questions. Sessions are WORK's.
 */
function projectLine(c, wide, project) {
  const mark = project.running ? c(MARK.running, 'green') : c(MARK.quiet, 'grey');
  // A plan still on the old markdown file has no steps to count and is said to
  // be what it is, rather than drawn as a fraction of nothing.
  const steps = project.steps
    ? `${project.steps.done}/${project.steps.total}`
    : (project.legacy ? 'PLAN.md' : '—');
  const column = projectColumns(wide);
  // The repository is bookkeeping and grey; it was `dim grey`, which on this
  // terminal put the same cell on 41 rows at the background's own brightness.
  const repo = column.repo
    ? `${c(pad(clip(project.repo || '—', column.repo), column.repo), 'grey')} `
    : '';
  // The name is what the row is about: bold while the runner is on it, and
  // otherwise the terminal's own foreground rather than a colour of ours.
  const name = pad(clip(project.name, column.name), column.name);
  const left = `  ${c(String(project.number).padStart(3), 'grey')} ${mark} `
    + `${project.running ? c(name, 'bold') : name} `
    + repo
    + `${c(pad(clip(project.status || '—', column.status), column.status), ...statusTone(project.status))} `
    + `${c(pad(steps, column.steps), 'grey')}`;
  // The open PR is the actionable half and wins the right-hand column; with
  // none, the last runner step is what says whether anything has happened.
  const right = project.pr
    ? paint(c, [{ text: `#${project.pr}`, styles: ['cyan'] }])
    : paint(c, [
      { text: project.last ? `${when(project.last.ts)} ` : '', styles: ['grey'] },
      { text: project.last ? project.last.kind : '', styles: kindTone(project.last?.kind) },
    ]);
  return row(c, wide, left, project.next || '', right);
}

/**
 * The three columns of a programme heading. The name shortens on a narrow
 * terminal and the counts do not: the counts are the answer, and a programme
 * name is still recognisable at twenty-two columns.
 */
function programmeColumns(wide) {
  return { name: wide >= 90 ? 31 : 22, counts: 22 };
}

/**
 * How many of a programme's projects are ready and how many are stopped, or
 * that it has no project yet.
 *
 * A zero keeps no colour. Green on `0 ready` would give a state's colour to the
 * absence of it, and the page's rule is that colour carries state — so a count
 * of nothing reads as the bookkeeping it is.
 */
function programmeCounts(c, group, columns) {
  const statuses = group.statuses || {};
  const total = Object.values(statuses).reduce((sum, n) => sum + n, 0);
  if (!total) return pad(c(clip('no project yet', columns), 'grey'), columns);
  const ready = statuses.ready || 0;
  const blocked = statuses.blocked || 0;
  return pad(paint(c, [
    { text: `${ready} ready`, styles: ready ? statusTone('ready') : ['grey'] },
    { text: ' · ', styles: ['grey'] },
    { text: `${blocked} blocked`, styles: blocked ? statusTone('blocked') : ['grey'] },
  ], columns), columns);
}

/**
 * Three ways of saying that nobody is planning this programme, longest first.
 *
 * The counts took the room the sentence used to have, and a clipped `no plan
 * sessio` says less than the glyph on its own does — so the widest one that
 * fits is drawn rather than the only one there was.
 */
const NO_PLAN = [`${MARK.quiet}  no plan session`, `${MARK.quiet}  no plan`, MARK.quiet];

/**
 * One programme heading: its name, its own counts, and the room for its
 * planning session — filled or empty.
 *
 * Empty is the point. `mc plan <programme>` is how new work enters, and a
 * programme with no session open is one nobody is thinking about right now,
 * which is a thing worth being able to see at a glance rather than to work out
 * from an absence (Martin, 2026-09-02).
 *
 * The counts sit between the two because that is where the eye already is: the
 * page's own numbers were all on one heading forty rows above, so a programme's
 * share of them had to be counted off its rows by hand.
 */
function programmeLine(c, wide, group) {
  const column = programmeColumns(wide);
  const session = group.planning;
  const left = `  ${c(pad(clip(group.programme, column.name - 1), column.name), 'bold', 'cyan')}`;
  const counts = programmeCounts(c, group, column.counts);
  const space = Math.max(0, wide - 4 - column.name - column.counts);
  const meta = session
    ? paint(c, [
      { text: `${MARK.running} `, styles: ['cyan'] },
      ...between([
        { text: `plan ${openFor(session.age_seconds).replace(/^open /u, '')}`, styles: ageTone(session.age_seconds) },
        { text: [session.tool, session.model].filter(Boolean).join(' '), styles: ['grey'] },
        { text: session.pid ? `pid ${session.pid}` : '', styles: ['grey'] },
      ], ' · '),
    ], space)
    : c(NO_PLAN.find((text) => text.length <= space) ?? '', 'grey');
  return `${left} ${counts} ${meta}`.replace(/[ ]+$/u, '');
}

/** How many blockers a collapsed row and the rollup line name before they stop. */
export const BLOCKERS_DRAWN = 3;

/** `1–3, 7` — a run of row numbers as the shortest thing that still opens them. */
export function numberRanges(numbers) {
  const sorted = [...numbers].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  let start = null;
  let last = null;
  const flush = () => { if (start !== null) out.push(start === last ? `${start}` : `${start}–${last}`); };
  for (const n of sorted) {
    if (start === null) { start = n; last = n; continue; }
    if (n === last + 1) { last = n; continue; }
    flush();
    start = n;
    last = n;
  }
  flush();
  return out.join(', ');
}

/** `plan-review 12, home-on-msr 7` — the blockers, biggest first. */
function blockerWords(blockers, drawn = BLOCKERS_DRAWN) {
  const named = blockers.slice(0, drawn);
  const rest = blockers.length - named.length;
  return `${named.map((item) => `${item.name} ${item.count}`).join(', ')}${rest ? `, … ${rest} more` : ''}`;
}

/**
 * As many blockers as the room holds, biggest first — the widest of `lead` plus
 * three, two or one of them that fits, and nothing at all if even one does not.
 *
 * A blocker's name is a project's or a decision's, and those run long
 * (`martin-iphone-cold-restore-confirmation`). Dropping the whole tail because
 * the third name overran costs the row the one thing it is drawn for, so the
 * count of names gives way before the fact does — and after it, the words
 * around the names, which is what the second lead is for.
 */
function blockersFitting(blockers, leads, space) {
  for (const lead of [].concat(leads)) {
    for (let drawn = Math.min(BLOCKERS_DRAWN, blockers.length); drawn > 0; drawn -= 1) {
      const text = `${lead}${blockerWords(blockers, drawn)}`;
      if (text.length <= space) return text;
    }
  }
  return '';
}

/**
 * A programme's blocked projects as one row: how many, the numbers that still
 * open them, and what holds them.
 *
 * Twelve rows saying `blocked` with twelve different names is twelve rows of
 * the same fact; the fact worth the room is which blocker holds them. The
 * numbers stay because they are what a person types — a collapsed project is
 * still openable, and this row is where its number went.
 */
function collapsedLine(c, wide, blocked) {
  const room = wide - 8;
  const head = [
    { text: `${blocked.count} blocked`, styles: statusTone('blocked') },
    { text: `  ·  ${numberRanges(blocked.numbers)}`, styles: ['grey'] },
  ];
  const holders = blockersFitting(blocked.blockers, '  ·  ', room - head.reduce((n, part) => n + part.text.length, 0));
  return `        ${paint(c, fitting([...head, { text: holders, styles: ['grey'] }], room), room)}`;
}

/**
 * The one line worth more than every red cell under it: how many projects are
 * stopped, how many of them wait on an answer and how many on another project,
 * and the blockers holding the most.
 *
 * Drawn under NEXT and not in PROGRAMMES, because it answers *what should I
 * do* and NEXT is where somebody asking that is already looking. It says
 * `blocked` — the plan's own word, and the word the brand row and the skip line
 * use — rather than inventing a third for the same thirty-three projects.
 */
function blockedLines(lines, c, wide, blocked) {
  if (!blocked?.count) return;
  const kinds = blocked.kinds || {};
  const waits = [
    kinds.decision ? `${kinds.decision} on a decision` : '',
    kinds.project ? `${kinds.project} on a project` : '',
  ].filter(Boolean).join(', ');
  const room = wide - 7;
  const head = [
    { text: `${blocked.count} blocked`, styles: statusTone('blocked') },
    { text: waits ? ` · ${waits}` : '', styles: ['grey'] },
  ];
  const holders = blockersFitting(blocked.blockers, [' · held most by ', ' · '], room - head.reduce((n, part) => n + part.text.length, 0));
  lines.push(`       ${paint(c, fitting([...head, { text: holders, styles: ['grey'] }], room), room)}`);
}

function programmesLines(lines, c, wide, programmes, expand) {
  const statuses = Object.entries(programmes.statuses || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([status, n]) => ({ text: `${status} ${n}`, styles: statusTone(status) }));
  const groups = programmes.programmes || [];
  heading(lines, c, wide, 'PROGRAMMES', [
    { text: `${groups.length} programme${groups.length === 1 ? '' : 's'} · ${programmes.count} project${programmes.count === 1 ? '' : 's'}  `, styles: ['grey'] },
    ...between(statuses, ' · '),
  ], 'p  plan a programme');

  for (const group of groups) {
    lines.push(programmeLine(c, wide, group));
    // What is actionable keeps its row; what is stopped becomes one row for the
    // programme. `a` at the menu draws the page again with nothing collapsed —
    // the same rows, the same numbers, all of them.
    const collapsed = expand ? null : group.blocked;
    const held = new Set(collapsed ? collapsed.names : []);
    for (const project of group.projects) {
      if (!held.has(project.name)) lines.push(projectLine(c, wide, project));
    }
    if (collapsed) lines.push(collapsedLine(c, wide, collapsed));
  }
  if (programmes.no_workarea) {
    say(lines, c, wide, 7, `${programmes.no_workarea} of them ${programmes.no_workarea === 1 ? 'has' : 'have'} no workarea yet — opening by number makes one`);
  }

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
  // the steps the runner has in flight (RUNNER), and the plans that are ready
  // and blocked (PROGRAMMES). It said `N of M queued` until 2026-09-06, which
  // on an empty `queue.md` was `0 of 0 queued` while 41 projects had plans and
  // the runner was stepping one of them. The three ride in one part so that a
  // narrow terminal drops the cost rather than half of the answer.
  const statuses = data.programmes?.statuses || {};
  const flight = (data.runner?.steps || []).length;
  // Counted on the plain text, and the narrowest terminal keeps the count it
  const parts = [
    { text: `${flight} in flight · ${statuses.ready || 0} ready · ${statuses.blocked || 0} blocked` },
    cost ? { text: `${cost} today`, styles: ['grey'] } : null,
  ].filter(Boolean);
  const plain = () => parts.map((part) => part.text).join('  ·  ');
  while (parts.length > 1 && width(brand) + plain().length + 6 > wide) parts.pop();
  const counts = paint(c, between(parts, '  ·  '));
  const rule = wide - width(brand) - width(counts) - 4;
  lines.push('');
  lines.push(`  ${brand} ${c('─'.repeat(Math.max(2, rule)), 'grey')} ${counts}`);
  lines.push('');

  const sessions = data.sessions || { desks: {}, others: [] };
  // The order is one rule, kept by the whole page: **what does not move sits
  // above what does.** The live loop rewrites only rows still on the screen
  // (page-frame.js), so a row that changes has to be near the prompt or it
  // scrolls into history and stands there with its old text (Martin,
  // 2026-09-03: "Tid för runner ligger kvar"). PROGRAMMES, INTAKE and WORK are
  // the page as a listing — a project's status changes when a round lands, and
  // not between two frames. NEXT changes every round, RUNNER changes every
  // frame, and the two desks change while somebody is sitting at them.
  programmesLines(lines, c, wide, data.programmes, expand);
  lines.push('');
  intakeLines(lines, c, wide, data.intake);
  lines.push('');
  workLines(lines, c, wide, sessions, data.programmes?.unplanned);
  lines.push('');
  nextLines(lines, c, wide, data.next);
  // PROGRAMMES' rollup, under NEXT: the section above counts the stopped
  // projects and this is the line that says what would move them, drawn where
  // somebody asking what to do next is already looking.
  blockedLines(lines, c, wide, data.programmes?.blocked);
  lines.push('');
  runnerLines(lines, c, wide, { ...data.runner, at_ms: at });
  lines.push('');
  deskLine(lines, c, wide, 'HELPER', sessions.desks?.helper, 'mc helper');
  deskLine(lines, c, wide, 'BRIEF', sessions.desks?.brief, 'mc brief');

  const cache = data.caches?.fresh
    ? 'fresh — fetched and asked GitHub'
    : `offline${data.caches?.prs?.fetched ? `, PRs ${ageWords(data.caches.prs.age_seconds)} old` : ', no PR cache yet'} — --fresh asks GitHub`;
  lines.push('');
  say(lines, c, wide, 2, cache);
  for (const note of data.notes || []) {
    if (/^PRs from cache|^no PR cache yet/u.test(note)) continue; // the cache line already says it
    say(lines, c, wide, 2, `note: ${note}`);
  }
  return lines;
}

export function renderPage(data, options = {}) {
  return `${renderPageLines(data, options).join('\n')}\n`;
}
