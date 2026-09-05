/**
 * How the page looks: the five sections `page-collect.js` gathers, drawn as
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
 *   - **Colour carries state, never decoration**: green is running, yellow
 *     waits on a person, red has failed, grey is quiet. Only on a TTY, and
 *     only when `NO_COLOR` is unset or empty — the convention is that any
 *     non-empty value turns colour off.
 *
 * The palette is a table rather than a habit, so a kind and a status look the
 * same wherever they are printed: `KIND_TONE` for what the runner is doing
 * (step, triage, the foreground verbs) and `STATUS_TONE` for where
 * a plan stands. Everything else is structure — cyan headings, grey for the
 * bookkeeping, white for the name a person is looking for.
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

/** A plan status's colour; no plan at all is the dimmest thing on the page. */
function statusTone(status) {
  return STATUS_TONE[status] || ['dim', 'grey'];
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
  // One line per lane: `mc run` drives one lane per repository at the same
  // time, and each of them is a step somebody may want to look at.
  const steps = now.steps || [];
  if (steps.length) {
    for (const s of steps) {
      const budget = s.budget_seconds == null ? '' : ` of ${duration(s.budget_seconds)}`;
      const meta = paint(c, between([
        { text: s.kind, styles: kindTone(s.kind) },
        { text: [s.tool, s.model].filter(Boolean).join(' '), styles: ['grey'] },
        {
          text: `${duration(s.elapsed_seconds)}${budget}${s.over_budget ? ' — over budget' : ''}`,
          styles: elapsedTone(s),
        },
        { text: s.pid ? `pid ${s.pid}` : '', styles: ['grey'] },
      ], ' · '), wide - 28);
      lines.push(`  ${c(MARK.running, 'green')} ${c(pad(clip(s.name, 21), 22), 'bold', 'white')} ${meta}`);
    }
  } else if (now.process?.alive) {
    lines.push(`  ${c(MARK.quiet, 'grey')} ${c(pad('runner', 22), 'grey')} ${c('between steps — nothing in flight', 'grey')}`);
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

/**
 * What is in production, in one line under the runner's day: the sha mc last
 * deployed, how long ago, and who typed it.
 *
 * The mismatch is the reason the line is worth its row. What mc shipped and
 * what `/api/version` answers should be the same sha; when they are not,
 * something happened outside the record — a deploy made another way, a deploy
 * that did not take — and no machine here can say which of the two to believe.
 * That is the page's yellow exactly: it waits on a person.
 *
 * Absent when neither source knows anything, which is the state before the
 * first `mc deploy` and before the helper has ever collected.
 */
function productionLine(lines, c, wide, production) {
  if (!production) return;
  const live = production.live;
  const liveAge = live ? ` (${ageWords(live.age_seconds)} old)` : '';
  const parts = [];
  if (production.sha) {
    parts.push({ text: `production ${production.short}`, styles: ['white'] });
    parts.push({
      text: `${production.build ? ` build ${production.build}` : ''} · deployed ${ageWords(production.age_seconds)} ago`
        + `${production.holder ? ` by ${production.holder}` : ''}`,
      styles: ['grey'],
    });
  } else {
    // Nothing mc deployed, but production answers something: say what it
    // answers and where that came from, rather than nothing at all.
    parts.push({ text: `production ${live.short}`, styles: ['white'] });
    parts.push({ text: ` · /api/version${liveAge} — mc has deployed nothing`, styles: ['grey'] });
  }
  if (production.differs) {
    parts.push({ text: ` · /api/version says ${live.short}${liveAge}`, styles: ['yellow', 'bold'] });
  }
  const running = production.running;
  if (running) {
    parts.push({
      text: ` · deploying ${running.short} since ${ageWords(running.age_seconds)}${running.late ? ' — no end recorded' : ''}`,
      styles: running.late ? ['yellow', 'bold'] : ['green'],
    });
  } else if (production.failed) {
    parts.push({
      text: ` · a deploy failed ${ageWords(production.failed.age_seconds)} ago`
        + `${production.failed.stopped_at ? ` at ${production.failed.stopped_at}` : ''}`,
      styles: ['yellow'],
    });
  }
  lines.push(`  ${paint(c, parts, wide - 2)}`);
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
    heading(lines, c, wide, title, [{ text: `${MARK.quiet}  not open`, styles: ['dim', 'grey'] }], verb);
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
    lines.push(`  ${mark} ${c(pad(clip(item.area || '?', 21), 22), 'bold', 'white')} ${meta}`);
  }

  // The folders no project explains, under the same heading as the sessions.
  // They were the tail of PROJECTS, which made that section answer two
  // questions — where the work stands, and which directories are left over —
  // and the second is this one's: a workarea with nothing to explain it is
  // work in exactly the sense WORK means, and often the same folder somebody
  // has a session open in. Nothing removes them (close-workarea.js), which is
  // why they are counted where somebody looks; `mc run` writes the whole list,
  // with whether each branch has landed, to `~/mc/runner/unplanned-workareas.md`.
  if (!folders.count) return;
  if (others.length) lines.push('');
  for (const area of folders.shown) lines.push(orphanLine(c, wide, area));
  if (folders.more) say(lines, c, wide, 7, `… ${folders.more} more — ~/mc/runner/unplanned-workareas.md has them all`);
}

/** How the clock reads: white, then yellow near the budget, then red past it. */
function elapsedTone(step) {
  if (step.over_budget) return ['red', 'bold'];
  const spent = step.elapsed_seconds;
  if (step.budget_seconds && spent != null && spent >= step.budget_seconds * 0.75) return ['yellow'];
  return ['white'];
}

function queueLines(lines, c, wide, queue) {
  const counts = queue.depth
    ? `${queue.runnable} runnable of ${queue.depth}`
    : 'empty — mc brief queues the next thing';
  // A pull request the runner would not land is not a queue depth, but it is
  // the reason a project is not in the queue at all — so it rides on the
  // heading's own count line, where the section's answer already is.
  const held = queue.held?.count
    ? [{ text: ' · ', styles: ['grey'] }, { text: `held before merge ${queue.held.count}`, styles: ['yellow', 'bold'] }]
    : [];
  heading(lines, c, wide, 'QUEUE', [{ text: counts, styles: ['grey'] }, ...held], 'mc status <name>');
  for (const [index, item] of queue.next.entries()) {
    const name = c(pad(clip(item.name, 25), 26), ...(index === 0 ? ['bold', 'white'] : ['white']));
    const kind = paint(c, [{ text: item.kind, styles: kindTone(item.kind) }], wide - 34);
    lines.push(`  ${c(String(index + 1).padStart(3), 'grey')}  ${name}${kind}`);
  }
  const more = queue.more ? `… ${queue.more} more runnable` : '';
  const skipped = queue.skipped.count
    ? `skipped ${queue.skipped.count} (${Object.entries(queue.skipped.reasons).map(([why, n]) => `${why} ${n}`).join(', ')})`
    : '';
  if (more || skipped) {
    // What was passed over is the quietest thing in the section: it is the
    // reason a name is *not* below, and dim grey is how the page says so.
    lines.push(`       ${paint(c, between([
      { text: more, styles: ['grey'] },
      { text: skipped, styles: ['dim', 'grey'] },
    ], ' · '), wide - 7)}`);
  }
  heldLines(lines, c, wide, queue.held);
  staleLine(lines, c, wide, queue.stale);
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
 * project too (`held-after-repair`, `in-flight` — queueSection reads the
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
    { text: ' — a blocked step is waiting on a project that is not coming', styles: ['yellow'] },
  ], wide - 7)}`);
  for (const item of stale.items) {
    lines.push(`       ${paint(c, [
      { text: `· ${item.project} step ${item.step} on ${item.blocker}, which ${item.why}`, styles: ['yellow'] },
    ], wide - 7)}`);
  }
  if (stale.more) lines.push(`       ${paint(c, [{ text: `· … ${stale.more} more`, styles: ['yellow'] }], wide - 7)}`);
}

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
      { text: repo.repo, styles: ['bold', 'white'] },
      { text: `${repo.date}${age}`, styles: repo.age_seconds == null ? ['grey'] : (fresh ? ['green'] : ['yellow']) },
      { text: errors, styles: !repo.first && repo.new_errors ? ['red'] : ['grey'] },
    ], ' · '), wide - 7)}`);
    for (const line of repo.loud_lines || []) {
      lines.push(`  ${c('  !', 'red')}  ${c(clip(one(line), wide - 7), 'bold', 'white')}`);
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
  const nameTone = project.running ? ['bold', 'white'] : ['white'];
  // A plan still on the old markdown file has no steps to count and is said to
  // be what it is, rather than drawn as a fraction of nothing.
  const steps = project.steps
    ? `${project.steps.done}/${project.steps.total}`
    : (project.legacy ? 'PLAN.md' : '—');
  const column = projectColumns(wide);
  const repo = column.repo
    ? `${c(pad(clip(project.repo || '—', column.repo), column.repo), 'dim', 'grey')} `
    : '';
  const left = `  ${c(String(project.number).padStart(3), 'grey')} ${mark} `
    + `${c(pad(clip(project.name, column.name), column.name), ...nameTone)} `
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
 * One row for a workarea that no project explains. Grey through and through:
 * the missing project is the whole content of the row, and nothing in it is
 * state. The middle carries what would be lost by removing it, because that is
 * the only question such a folder poses.
 */
function orphanLine(c, wide, area) {
  const column = projectColumns(wide);
  const mark = area.live ? c(MARK.running, 'green') : c(MARK.quiet, 'grey');
  const left = `  ${c(String(area.number).padStart(3), 'grey')} ${mark} `
    + `${c(pad(clip(area.name, column.name), column.name), 'grey')} `
    + `${c(pad(clip(area.repo || '—', column.repo || column.status), column.repo || column.status), 'dim', 'grey')}`;
  const parts = [];
  if (area.uncommitted) parts.push(`${area.uncommitted} uncommitted`);
  if (area.last_commit) parts.push(`last commit ${area.last_commit}`);
  return row(c, wide, left, parts.join(' · ') || 'no project on main', null, ['grey']);
}

/**
 * One programme heading, with the room for its planning session on the right
 * of it — filled or empty.
 *
 * Empty is the point. `mc plan <programme>` is how new work enters, and a
 * programme with no session open is one nobody is thinking about right now,
 * which is a thing worth being able to see at a glance rather than to work out
 * from an absence (Martin, 2026-09-02).
 */
function programmeLine(c, wide, group) {
  const session = group.planning;
  const left = `  ${c(pad(clip(group.programme, 30), 31), 'bold', 'cyan')}`;
  const meta = session
    ? paint(c, [
      { text: `${MARK.running} `, styles: ['cyan'] },
      ...between([
        { text: `plan ${openFor(session.age_seconds).replace(/^open /u, '')}`, styles: ageTone(session.age_seconds) },
        { text: [session.tool, session.model].filter(Boolean).join(' '), styles: ['grey'] },
        { text: session.pid ? `pid ${session.pid}` : '', styles: ['grey'] },
      ], ' · '),
    ], wide - 34)
    : c(`${MARK.quiet}  no plan session`, 'dim', 'grey');
  return `${left} ${meta}`;
}

function programmesLines(lines, c, wide, programmes) {
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
    for (const project of group.projects) lines.push(projectLine(c, wide, project));
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
  columns = 100, colour = false, version = '', now = new Date(),
} = {}) {
  const c = painter(colour);
  const wide = Math.max(60, Math.min(columns, 160));
  const at = now instanceof Date ? now.getTime() : Number(now);
  const lines = [];

  const cost = money(data.runner?.day?.cost);
  const brand = `${c('MEMORO·CLI', 'bold', 'white')}${version ? c(`  ${version}`, 'grey') : ''}`;
  // Counted on the plain text, and the narrowest terminal keeps the count it
  const parts = [
    { text: `${data.queue.runnable} of ${data.queue.depth} queued`, styles: ['white'] },
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
  queueLines(lines, c, wide, data.queue);
  lines.push('');
  intakeLines(lines, c, wide, data.intake);
  lines.push('');
  programmesLines(lines, c, wide, data.programmes);
  lines.push('');
  workLines(lines, c, wide, sessions, data.programmes?.unplanned);
  lines.push('');
  // The machine last, nearest the prompt. RUNNER and the two desks are the
  // rows that change while the page is left open — a step's minutes, a
  // session's age — and the live loop rewrites only rows still on the
  // screen (page-frame.js). At the top, under a hundred rows of projects,
  // they had scrolled into history before the prompt was printed and never
  // changed again (Martin, 2026-09-03: "Tid för runner ligger kvar"). The
  // listing above is the overview and stays whole; what moves sits where
  // the eye already is.
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
