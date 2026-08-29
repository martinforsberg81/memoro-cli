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
 * Lines rather than one string, so `--watch` can redraw and a test can look
 * at a row without splitting a page apart again.
 */
import { ageWords } from './page-cache.js';
import { clip, pad, painter, width } from './status-render.js';

/** Same glyphs as the old board, so nothing new has to be learnt. */
const MARK = { running: '●', waiting: '◆', stopped: '■', quiet: '·' };

const STATUS_TONE = {
  ready: 'green',
  'waiting-decision': 'yellow',
  blocked: 'red',
  done: 'grey',
};

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

/**
 * A heading: the section's name, its counts, and the verb that expands it
 * pushed to the right margin. The verb goes first when the width runs out —
 * it is a reminder, and the counts are the answer.
 */
function heading(lines, c, wide, title, counts, verb) {
  // The width is measured on the plain text and the colour applied after:
  // clipping a string that already carries escape sequences cuts them in half.
  const room = wide - 2 - title.length - (verb ? verb.length + 2 : 0);
  const shown = counts ? clip(counts, Math.max(12, room - 2)) : '';
  const left = `  ${c(title, 'bold')}${shown ? `  ${c(shown, 'grey')}` : ''}`;
  if (!verb) { lines.push(left); return; }
  const gap = wide - width(left) - verb.length;
  lines.push(gap > 2 ? `${left}${' '.repeat(gap)}${c(verb, 'grey')}` : left);
}

/** One line of prose, indented and cut to the terminal. */
function say(lines, c, wide, indent, text, tone = 'grey') {
  lines.push(`${' '.repeat(indent)}${c(clip(one(text), wide - indent), tone)}`);
}

/**
 * A row: a left part that keeps its width, a middle that gives way, and a
 * right that is dropped altogether when the terminal is too narrow to hold
 * both it and something readable in the middle.
 */
function row(c, wide, left, middle, right) {
  const tail = right ? `  ${right}` : '';
  const room = wide - width(left) - width(tail);
  if (room < 12 && tail) return row(c, wide, left, middle, null);
  const body = pad(clip(one(middle), Math.max(8, room)), Math.max(8, room));
  return `${left}${body}${c(tail, 'grey')}`.replace(/[ ]+$/u, '');
}

/* --------------------------------------------------------------- sections */

function nowLines(lines, c, wide, now) {
  heading(lines, c, wide, 'NOW', null, null);
  if (now.step) {
    const s = now.step;
    const budget = s.budget_seconds == null ? '' : ` of ${duration(s.budget_seconds)}`;
    const meta = [
      s.kind,
      [s.tool, s.model].filter(Boolean).join(' '),
      `${duration(s.elapsed_seconds)}${budget}${s.over_budget ? ' — over budget' : ''}`,
      s.pid ? `pid ${s.pid}` : null,
    ].filter(Boolean).join(c(' · ', 'grey'));
    lines.push(`  ${c(MARK.running, 'green')} ${c(pad(clip(s.name, 21), 22), 'bold')} ${clip(meta, wide - 28)}`);
  } else if (now.runner?.alive) {
    lines.push(`  ${c(MARK.quiet, 'grey')} ${c(pad('runner', 22), 'grey')} ${c('between steps — nothing in flight', 'grey')}`);
  } else {
    lines.push(`  ${c(MARK.quiet, 'grey')} ${c('the runner is not running — mc run starts it', 'grey')}`);
  }
  if (now.stop) say(lines, c, wide, 2, `${MARK.stopped} STOP requested — the runner exits after the step it is in`, 'yellow');
  for (const item of now.foreground) {
    const meta = [item.area, [item.tool, item.model].filter(Boolean).join(' '), item.pid ? `pid ${item.pid}` : null]
      .filter(Boolean).join(c(' · ', 'grey'));
    lines.push(`  ${c(MARK.running, 'green')} ${c(pad(clip(`mc ${item.verb || '?'}`, 21), 22), 'bold')} ${clip(meta, wide - 28)}`);
  }
  // A tmux area is a person's window, not the runner's: yellow, because what
  // is in it is waiting for somebody rather than working.
  for (const area of now.live) {
    const since = area.opened_ms ? `open ${duration(Math.max(0, Math.round((now.at_ms - area.opened_ms) / 1000)))}` : 'open';
    lines.push(`  ${c(MARK.waiting, 'yellow')} ${c(pad(clip(area.name, 21), 22), 'bold')} ${c(`tmux mc-${area.name} · ${since}`, 'grey')}`);
  }
  for (const line of now.stale) say(lines, c, wide, 2, `${MARK.quiet} stale: ${line}`, 'red');
  const day = now.day;
  const up = now.runner?.alive ? `runner up ${duration(now.runner.up_seconds)} · ` : '';
  const cost = money(day.cost);
  say(lines, c, wide, 2, `${up}${day.steps} steps in 24 h — merged ${day.merged}, open ${day.open}, `
    + `failed ${day.failed}, timed out ${day.timeout}`
    + `${cost ? ` · ${cost} list (${day.model}, ${day.prices_dated})` : ''}`);
  if (now.quota.count) {
    say(lines, c, wide, 2, `quota: ${now.quota.count} answer(s) in the last 24 h, last ${when(now.quota.last)}`, 'yellow');
  }
}

function queueLines(lines, c, wide, queue) {
  const counts = queue.depth
    ? `${queue.runnable} runnable of ${queue.depth}`
    : 'empty — mc brief queues the next thing';
  heading(lines, c, wide, 'QUEUE', counts, 'mc status <name>');
  for (const [index, item] of queue.next.entries()) {
    lines.push(`  ${c(String(index + 1).padStart(3), 'grey')}  ${c(pad(clip(item.name, 25), 26), 'bold')}${clip(item.kind, wide - 34)}`);
  }
  const tail = [
    queue.more ? `… ${queue.more} more runnable` : null,
    queue.skipped.count
      ? `skipped ${queue.skipped.count} (${Object.entries(queue.skipped.reasons).map(([why, n]) => `${why} ${n}`).join(', ')})`
      : null,
  ].filter(Boolean).join(' · ');
  if (tail) say(lines, c, wide, 7, tail);
}

function decisionsLines(lines, c, wide, decisions) {
  heading(lines, c, wide, 'DECISIONS', decisions.count ? `${decisions.count} waiting` : 'none waiting', 'mc brief');
  for (const d of decisions.first) {
    lines.push(row(c, wide, `       ${c(pad(clip(d.file, 41), 42), 'yellow')}`, d.title, null));
  }
  if (decisions.more) say(lines, c, wide, 7, `… ${decisions.more} more`);
}

/**
 * INTAKE — the helper's block: when it last looked, what it found, and how
 * many proposals nobody has queued or dropped.
 *
 * The `!` lines come first and whole, before anything else in the section.
 * The digest marks a new fingerprint `!` when it crossed the threshold, or a
 * condition `!` when it has just started failing; a count of those is a
 * number somebody has to go and look up, and the line is what makes them look.
 */
function intakeLines(lines, c, wide, intake) {
  if (!intake.digest) {
    heading(lines, c, wide, 'INTAKE', 'no digest yet — mc helper has not run', null);
    if (intake.proposals) say(lines, c, wide, 7, `${intake.proposals} proposal(s) waiting`, 'yellow');
    return;
  }
  const age = intake.age_seconds == null ? '' : ` (${ageWords(intake.age_seconds)} old)`;
  const errors = intake.first
    ? 'first digest — no baseline'
    : `${intake.new_errors} new error${intake.new_errors === 1 ? '' : 's'}${intake.loud ? ` (${intake.loud} loud)` : ''}`;
  const counts = `${intake.date}${age} · ${errors} · ${intake.proposals} proposal${intake.proposals === 1 ? '' : 's'}`;
  heading(lines, c, wide, 'INTAKE', counts, 'mc helper');
  for (const line of intake.loud_lines || []) {
    lines.push(`  ${c('  !', 'red')}  ${c(clip(one(line), wide - 7), 'bold')}`);
  }
  if (intake.more_loud) say(lines, c, wide, 7, `… ${intake.more_loud} more above the threshold`);
}

function workLines(lines, c, wide, work) {
  const liveCount = work.areas.filter((area) => area.live).length;
  const counts = `${work.count} workareas${liveCount ? ` · ${liveCount} live` : ''}`;
  heading(lines, c, wide, 'WORK', counts, 'mc status <name>');
  for (const area of work.areas) {
    const mark = area.live ? c(MARK.running, 'green') : c(MARK.quiet, 'grey');
    const status = area.status || '—';
    const left = `  ${c(String(area.number).padStart(3), 'grey')} ${mark} ${c(pad(clip(area.name, 25), 26), area.live ? 'bold' : 'grey')} `
      + `${c(pad(clip(status, 15), 16), STATUS_TONE[status] || 'grey')} `;
    const right = area.last
      ? `${when(area.last.ts)} ${area.last.kind}${area.pr ? ` #${area.pr}` : ''}`
      : (area.pr ? `PR #${area.pr}` : '');
    lines.push(row(c, wide, left, area.next || (area.status ? '' : 'no PLAN.md on main'), right));
  }
  if (work.without_workarea) {
    say(lines, c, wide, 7, `${work.without_workarea} project(s) on main without a workarea — mc status <name>`);
  }
}

/* ------------------------------------------------------------------- page */

/**
 * The whole page, as lines. `data` is exactly what `--json` prints: one key
 * per section, so the two can never say different things.
 */
export function renderPageLines(data, { columns = 100, colour = false, version = '', now = new Date() } = {}) {
  const c = painter(colour);
  const wide = Math.max(60, Math.min(columns, 160));
  const at = now instanceof Date ? now.getTime() : Number(now);
  const lines = [];

  const cost = money(data.now?.day?.cost);
  const brand = `${c('MEMORO', 'bold')}${c('·CLI', 'grey')}${version ? c(`  ${version}`, 'grey') : ''}`;
  // Counted on the plain text, and the narrowest terminal keeps the count it
  // was opened for: decisions wait on a person, the rest is bookkeeping.
  const parts = [
    data.decisions.count ? { text: `${data.decisions.count} decisions`, styles: ['yellow', 'bold'] } : null,
    { text: `${data.queue.runnable} of ${data.queue.depth} queued`, styles: [data.queue.runnable ? 'green' : 'grey'] },
    cost ? { text: `${cost} today`, styles: ['grey'] } : null,
  ].filter(Boolean);
  const plain = () => parts.map((part) => part.text).join('  ·  ');
  while (parts.length > 1 && width(brand) + plain().length + 6 > wide) parts.pop();
  const counts = parts.map((part) => c(part.text, ...part.styles)).join(c('  ·  ', 'grey'));
  const rule = wide - width(brand) - width(counts) - 4;
  lines.push('');
  lines.push(`  ${brand} ${c('─'.repeat(Math.max(2, rule)), 'grey')} ${counts}`);
  lines.push('');

  nowLines(lines, c, wide, { ...data.now, at_ms: at });
  lines.push('');
  queueLines(lines, c, wide, data.queue);
  lines.push('');
  decisionsLines(lines, c, wide, data.decisions);
  lines.push('');
  intakeLines(lines, c, wide, data.intake);
  lines.push('');
  workLines(lines, c, wide, data.work);

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
