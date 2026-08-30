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
 * (step, reconcile, triage, the foreground verbs) and `STATUS_TONE` for where
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
  'waiting-decision': ['yellow'],
  blocked: ['red'],
  done: ['grey'],
  // A plan that does not parse is not a quiet state: the runner will refuse it
  // at the door, and nobody will be told unless the page says so.
  invalid: ['red', 'bold'],
};

/** What is being done, one colour each, wherever a kind is printed. */
const KIND_TONE = {
  step: ['green'],
  reconcile: ['magenta'],
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

function nowLines(lines, c, wide, now) {
  heading(lines, c, wide, 'NOW', null, null);
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
  } else if (now.runner?.alive) {
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
  // A foreground verb is a person's session: cyan, the colour of the verbs
  // that hold a terminal, and the same cyan wherever `brief` or `plan` is
  // printed.
  for (const item of now.foreground) {
    const meta = paint(c, between([
      { text: item.area || '', styles: ['grey'] },
      { text: [item.tool, item.model].filter(Boolean).join(' '), styles: ['grey'] },
      { text: item.pid ? `pid ${item.pid}` : '', styles: ['grey'] },
    ], ' · '), wide - 28);
    lines.push(`  ${c(MARK.running, 'cyan')} ${c(pad(clip(`mc ${item.verb || '?'}`, 21), 22), 'bold', 'cyan')} ${meta}`);
  }
  // A tmux area is a person's window, not the runner's: yellow, because what
  // is in it is waiting for somebody rather than working.
  for (const area of now.live) {
    const since = area.opened_ms ? `open ${duration(Math.max(0, Math.round((now.at_ms - area.opened_ms) / 1000)))}` : 'open';
    lines.push(`  ${c(MARK.waiting, 'yellow')} ${c(pad(clip(area.name, 21), 22), 'bold', 'white')} ${c(`tmux mc-${area.name} · ${since}`, 'grey')}`);
  }
  for (const line of now.stale) say(lines, c, wide, 2, `${MARK.quiet} stale: ${line}`, 'red');
  const day = now.day;
  const up = now.runner?.alive ? `runner up ${duration(now.runner.up_seconds)} · ` : '';
  const cost = money(day.cost);
  say(lines, c, wide, 2, `${up}${day.steps} steps in 24 h — merged ${day.merged}, open ${day.open}, `
    + `failed ${day.failed}, timed out ${day.timeout}`
    + `${cost ? ` · ${cost} list (${day.model}, ${day.prices_dated})` : ''}`);
  if (now.quota.count) {
    // Yellow while a refusal is recent enough to still be the reason the
    // runner is idle; older than that it is history, and history is grey.
    const at = Date.parse(now.quota.last);
    const recent = Number.isFinite(at) && now.at_ms - at < QUOTA_FRESH_MS;
    say(lines, c, wide, 2, `quota: ${now.quota.count} answer(s) in the last 24 h, last ${when(now.quota.last)}`,
      recent ? 'yellow' : 'grey');
  }
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
  heading(lines, c, wide, 'QUEUE', counts, 'mc status <name>');
  for (const [index, item] of queue.next.entries()) {
    const name = c(pad(clip(item.name, 25), 26), ...(index === 0 ? ['bold', 'white'] : ['white']));
    const kind = paint(c, [{ text: item.kind, styles: kindTone(item.kind) }], wide - 34);
    lines.push(`  ${c(String(index + 1).padStart(3), 'grey')}  ${name}${kind}`);
  }
  const more = queue.more ? `… ${queue.more} more runnable` : '';
  const skipped = queue.skipped.count
    ? `skipped ${queue.skipped.count} (${Object.entries(queue.skipped.reasons).map(([why, n]) => `${why} ${n}`).join(', ')})`
    : '';
  if (!more && !skipped) return;
  // What was passed over is the quietest thing in the section: it is the
  // reason a name is *not* below, and dim grey is how the page says so.
  lines.push(`       ${paint(c, between([
    { text: more, styles: ['grey'] },
    { text: skipped, styles: ['dim', 'grey'] },
  ], ' · '), wide - 7)}`);
}

function decisionsLines(lines, c, wide, decisions) {
  heading(lines, c, wide, 'DECISIONS', decisions.count ? `${decisions.count} waiting` : 'none waiting', 'mc brief');
  for (const d of decisions.first) {
    // The mark is yellow and the question white: what waits on a person is
    // the one thing on the page nothing else can move.
    const left = `     ${c(MARK.running, 'yellow')} ${c(pad(clip(d.file, 41), 42), 'grey')}`;
    lines.push(row(c, wide, left, d.title, null, ['white']));
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
    heading(lines, c, wide, 'INTAKE', 'no digest yet — mc helper --intake has not run', null);
    if (intake.proposals) say(lines, c, wide, 7, `${intake.proposals} proposal(s) waiting`, 'yellow');
    return;
  }
  const age = intake.age_seconds == null ? '' : ` (${ageWords(intake.age_seconds)} old)`;
  const errors = intake.first
    ? 'first digest — no baseline'
    : `${intake.new_errors} new error${intake.new_errors === 1 ? '' : 's'}${intake.loud ? ` (${intake.loud} loud)` : ''}`;
  // A digest under a day old is green because somebody has looked; older, and
  // the age itself is the thing to see.
  const fresh = intake.age_seconds != null && intake.age_seconds < 24 * 60 * 60;
  heading(lines, c, wide, 'INTAKE', between([
    { text: `${intake.date}${age}`, styles: intake.age_seconds == null ? ['grey'] : (fresh ? ['green'] : ['yellow']) },
    { text: errors, styles: !intake.first && intake.new_errors ? ['red'] : ['grey'] },
    { text: `${intake.proposals} proposal${intake.proposals === 1 ? '' : 's'}`, styles: intake.proposals ? ['yellow'] : ['grey'] },
  ], ' · '), 'mc helper --intake');
  for (const line of intake.loud_lines || []) {
    lines.push(`  ${c('  !', 'red')}  ${c(clip(one(line), wide - 7), 'bold', 'white')}`);
  }
  if (intake.more_loud) say(lines, c, wide, 7, `… ${intake.more_loud} more above the threshold`);
}

/**
 * The fixed columns of a PROJECTS row, sized to the terminal rather than to a
 * number somebody typed once — which is the rule this file keeps everywhere
 * else, and the one a first draft of this section broke: 41 columns of name
 * plus 17 of status is wider than the 60-column floor all by itself.
 *
 * `waiting-decision` is sixteen characters and the longest status there is, so
 * it gets its whole width the moment the terminal can afford it and is clipped
 * below that. The name is whatever is left once the middle has the eight
 * columns `row` will insist on anyway.
 */
function projectColumns(wide) {
  const roomy = wide >= 90;
  const status = roomy ? 17 : 10;
  const steps = roomy ? 8 : 6;
  return { status, steps, name: Math.max(16, Math.min(41, wide - 10 - status - steps - 8)) };
}

/**
 * One PROJECTS row: the number the menu opens it by, where the plan stands,
 * how far through its steps it is, and what happens next.
 *
 * `programme/project` and not just the name — a project belongs to a
 * programme, and two projects of one programme read as one piece of work only
 * when it is on the row. The steps cell is what a list of names could never
 * say: `3/7` is where the work stands.
 */
function projectLine(c, wide, project) {
  const mark = project.live ? c(MARK.running, 'green') : c(MARK.quiet, 'grey');
  const nameTone = project.live ? ['bold', 'white'] : ['white'];
  // A plan still on the old markdown file has no steps to count and is said to
  // be what it is, rather than drawn as a fraction of nothing.
  const steps = project.steps
    ? `${project.steps.done}/${project.steps.total}`
    : (project.legacy ? 'PLAN.md' : '—');
  const column = projectColumns(wide);
  const left = `  ${c(String(project.number).padStart(3), 'grey')} ${mark} `
    + `${c(pad(clip(`${project.programme}/${project.name}`, column.name), column.name), ...nameTone)} `
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
    + `${c(pad(clip(area.repo || '—', column.status), column.status), 'dim', 'grey')}`;
  const parts = [];
  if (area.uncommitted) parts.push(`${area.uncommitted} uncommitted`);
  if (area.last_commit) parts.push(`last commit ${area.last_commit}`);
  return row(c, wide, left, parts.join(' · ') || 'no project on main', null, ['grey']);
}

function projectsLines(lines, c, wide, projects) {
  const statuses = Object.entries(projects.statuses || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([status, n]) => ({ text: `${status} ${n}`, styles: statusTone(status) }));
  const repos = projects.repos || [];
  heading(lines, c, wide, 'PROJECTS', [
    { text: `${projects.count} in ${repos.length} repo${repos.length === 1 ? '' : 's'}  `, styles: ['grey'] },
    ...between(statuses, ' · '),
  ], 'mc status <name>');

  for (const group of repos) {
    lines.push(`  ${c(group.repo, 'bold', 'cyan')} ${c(String(group.projects.length), 'dim', 'grey')}`);
    for (const project of group.projects) lines.push(projectLine(c, wide, project));
  }
  if (projects.no_workarea) {
    say(lines, c, wide, 7, `${projects.no_workarea} of them ${projects.no_workarea === 1 ? 'has' : 'have'} no workarea yet — opening by number makes one`);
  }

  // The workareas nothing explains, under one heading rather than scattered
  // through the rows above. No machine removes them — `mc run` writes the same
  // list, with whether each branch has landed, to
  // `~/mc/intake/unplanned-workareas.md` for `mc brief` to raise.
  const orphans = projects.unplanned || { count: 0, shown: [], more: 0 };
  if (!orphans.count) return;
  lines.push('');
  say(lines, c, wide, 2, `${orphans.count} workarea${orphans.count === 1 ? '' : 's'} with no project on main — nothing removes them`);
  for (const area of orphans.shown) lines.push(orphanLine(c, wide, area));
  if (orphans.more) say(lines, c, wide, 7, `… ${orphans.more} more — ~/mc/intake/unplanned-workareas.md has them all`);
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

  const cost = money(data.now?.day?.cost);
  const brand = `${c('MEMORO·CLI', 'bold', 'white')}${version ? c(`  ${version}`, 'grey') : ''}`;
  // Counted on the plain text, and the narrowest terminal keeps the count it
  // was opened for: decisions wait on a person, the rest is bookkeeping.
  const parts = [
    data.decisions.count ? { text: `${data.decisions.count} decisions`, styles: ['yellow', 'bold'] } : null,
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

  nowLines(lines, c, wide, { ...data.now, at_ms: at });
  lines.push('');
  queueLines(lines, c, wide, data.queue);
  lines.push('');
  decisionsLines(lines, c, wide, data.decisions);
  lines.push('');
  intakeLines(lines, c, wide, data.intake);
  lines.push('');
  projectsLines(lines, c, wide, data.projects);

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
