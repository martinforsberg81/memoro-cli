/**
 * The shared grid for SESSIONS, DEV and MERGES. Repository, state, clock and
 * PR columns align across these operational sections. PROGRAMMES has its own
 * phase tree in page-programmes.js, with PR children rather than PR cells.
 *
 * Repository gives way below 90 columns, then names shorten; state, progress
 * and whole PR numbers remain readable. Palette and clipping helpers are also
 * used by the programme tree.
 */
import { width } from './status-render.js';

/** Where the grid changes shape: a repository column from here up. */
export const GRID_ROOMY = 90;

/** The fixed widths. Each includes the one space that separates it from the next cell. */
export const GRID = Object.freeze({
  indent: 2,
  // ``●  12 `` — a status circle, then the optional lane number.
  nr: 6,
  // `project`, `goal`, `BUILD`, `REVIEW`, `GATE`: the longest is seven.
  kind: 8,
  name: { roomy: 28, narrow: 20, least: 10 },
  // `memoro-cli` and a space.
  repo: { roomy: 12, narrow: 0 },
  // `blocked`, `invalid`, `running`, `landing`: seven, and room for `dropped`.
  state: 9,
  // `12/30`, `5 sess`, `2.5 h`, `45 min`, `PLAN.md`.
  progress: 10,
  // `#14709+3` — five digits and three more.
  pr: 9,
});

/**
 * The columns at a terminal width: each cell's start and width, and the tail's.
 * `repo.width` is 0 under `GRID_ROOMY`: the column is not drawn at all.
 */
export function gridColumns(wide) {
  const roomy = wide >= GRID_ROOMY;
  const fixed = GRID.indent + GRID.nr + GRID.kind + GRID.state + GRID.progress + GRID.pr;
  const repo = roomy ? GRID.repo.roomy : GRID.repo.narrow;
  // At 60 columns the floor leaves the tail six: the name shortens, the rest holds.
  const name = roomy ? GRID.name.roomy : Math.max(GRID.name.least, Math.min(GRID.name.narrow, wide - fixed - 6));
  const widths = [
    ['nr', GRID.nr], ['kind', GRID.kind], ['name', name], ['repo', repo],
    ['state', GRID.state], ['progress', GRID.progress], ['pr', GRID.pr],
  ];
  const out = {};
  let x = GRID.indent;
  for (const [key, w] of widths) { out[key] = { x, width: w }; x += w; }
  out.tail = { x, width: Math.max(0, wide - x) };
  return out;
}

/* ----------------------------------------------------------------- palette */

/**
 * One colour per state word, wherever the word is printed (goal
 * mc/page-columns): green is in hand — running, or with the merger; yellow
 * waits on a person or on another piece of work; red is blocked, red or
 * failed; grey is bookkeeping. A word not here is grey.
 */
export const STATE_TONE = Object.freeze({
  ready: ['green'],
  running: ['green'],
  landing: ['green'],
  review: ['green'],
  // A goal whose pull request is in the merger's queue.
  merge: ['green'],
  queued: ['green'],
  gate: ['green'],
  rebase: ['green'],
  leased: ['green'],
  waiting: ['yellow'],
  // Steps all done, a criterion not met: somebody has to measure.
  unmet: ['yellow', 'bold'],
  blocked: ['red'],
  red: ['red'],
  paused: ['red'],
  stopped: ['red'],
  failed: ['red', 'bold'],
  // A plan that does not parse is not a quiet state: the runner will refuse it
  // at the door, and nobody will be told unless the page says so.
  invalid: ['red', 'bold'],
  open: ['grey'],
  done: ['grey'],
  dropped: ['grey'],
  idle: ['grey'],
  cold: ['grey'],
});

/**
 * One colour per kind word. The runner's three session kinds — `plan`,
 * `build`, `review` — and the foreground verbs; the merger's three (`gate` a
 * round, `wait` the queue, `red`); and the kind of work PROGRAMMES lists, a
 * goal, which is bookkeeping.
 */
export const KIND_TONE = Object.freeze({
  build: ['green'],
  review: ['magenta'],
  triage: ['blue'],
  brief: ['cyan'],
  plan: ['cyan'],
  gate: ['green'],
  wait: ['grey'],
  red: ['red'],
  goal: ['grey'],
  idle: ['grey'],
});

/** An open pull request's number with nothing else to say about it. */
export const PR_TONE = Object.freeze(['cyan', 'bold']);

/** Past this long without anything happening on it, an open pull request waits on a person. */
export const PR_QUIET_S = 24 * 60 * 60;

export function stateTone(state) {
  return STATE_TONE[state] || ['grey'];
}

export function kindTone(kind) {
  return KIND_TONE[String(kind || '').replace(/^mc /u, '')] || ['grey'];
}

/**
 * A pull request cell's colour, from its own flags: grey once it has landed
 * (`merged`), green while the merger has
 * it, red when it came back red, yellow once a day has passed with nothing on
 * it — then it waits on a person — and bold cyan otherwise.
 */
export function prTone(prs = []) {
  // A pull request that has landed is history, and history is grey.
  if (prs.length && prs.every((pr) => pr.merged)) return ['grey'];
  if (prs.some((pr) => pr.merging)) return ['green', 'bold'];
  if (prs.some((pr) => pr.merge_red)) return ['red', 'bold'];
  if (prs.some((pr) => pr.quiet_seconds >= PR_QUIET_S)) return ['yellow', 'bold'];
  return [...PR_TONE];
}

/**
 * `#1251`, `#1251+2` — the first pull request and how many more, in `room`.
 * The count goes before the number does, and the number is never cut.
 */
export function prText(prs = [], room = GRID.pr - 1) {
  if (!prs?.length) return '';
  const first = `#${prs[0].number}`;
  const more = prs.length > 1 ? `${first}+${prs.length - 1}` : first;
  if (more.length <= room) return more;
  return first.length <= room ? first : '';
}

/** `4 min`, `2.5 h` — a span as a person says it: a session's clock. */
export function duration(seconds) {
  if (seconds == null) return '?';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 180 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

/* -------------------------------------------------------------------- text */

const one = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();

/**
 * `text` in at most `room` columns, cut with `…` — never inside a number. When
 * the cut would split a run of digits, the run goes whole: `step 12` in six is
 * `step …`, not `step 1…`. A `#` left in front of the cut goes with it.
 */
export function clipCell(text, room) {
  const value = one(text);
  if (value.length <= room) return value;
  if (room <= 0) return '';
  if (room === 1) return '…';
  let cut = room - 1;
  // A number is its digits and what joins them: `#14709`, `12/30`, `2.5`, `+3`.
  const numeric = /[\d#.,:/+]/u;
  if (numeric.test(value[cut - 1] || '') && numeric.test(value[cut] || '')) {
    let start = cut;
    while (start > 0 && numeric.test(value[start - 1])) start -= 1;
    let end = cut;
    while (end < value.length && numeric.test(value[end])) end += 1;
    if (/\d/u.test(value.slice(start, end))) cut = start;
  }
  return `${value.slice(0, cut).replace(/\s+$/u, '')}…`;
}

/* --------------------------------------------------------------------- row */

/** A painted cell of `columns`, its text clipped one short so a space always follows it. */
function cellOf(c, part, columns) {
  if (!columns) return '';
  const text = clipCell(part?.text ?? '', columns - 1);
  const painted = part?.styles?.length && text ? c(text, ...part.styles) : text;
  return `${painted}${' '.repeat(Math.max(0, columns - text.length))}`;
}

/**
 * The tail's parts in `room`: whole parts while they fit, each but the first
 * after a grey ` · `, then the next one clipped into what is left when that is
 * worth reading. The tail is what gives way first, so it is all of it that is
 * ever cut.
 */
function tailOf(c, parts = [], room) {
  const items = parts.filter((part) => part && one(part.text));
  let used = 0;
  let out = '';
  for (const [index, part] of items.entries()) {
    const sep = index ? ' · ' : '';
    const text = one(part.text);
    const left = room - used - sep.length;
    if (text.length <= left) {
      out += `${sep ? c(sep, 'grey') : ''}${part.styles?.length ? c(text, ...part.styles) : text}`;
      used += sep.length + text.length;
      continue;
    }
    if (left >= 6) {
      const cut = clipCell(text, left);
      out += `${sep ? c(sep, 'grey') : ''}${part.styles?.length ? c(cut, ...part.styles) : cut}`;
    }
    break;
  }
  return out;
}

/**
 * One row of the grid. `row` is
 *
 *   { nr, mark: { text, styles }, kind, name, repo, state, progress, pr, tail }
 *
 * where every cell but `nr` and `tail` is `{ text, styles }` and `tail` is a
 * list of them. A missing cell is spaces. The row is never wider than `wide`,
 * and ends where its text does.
 */
export function gridRow(c, wide, row) {
  const col = gridColumns(wide);
  const nr = row.nr == null ? '   ' : String(row.nr).padStart(3).slice(-3);
  const mark = '●';
  const head = `${' '.repeat(GRID.indent)}${row.mark?.styles?.length ? c(mark, ...row.mark.styles) : mark} `
    + `${row.nr == null ? nr : c(nr, 'grey')} `;
  const cells = head
    + cellOf(c, row.kind, col.kind.width)
    + cellOf(c, row.name, col.name.width)
    + cellOf(c, row.repo, col.repo.width)
    + cellOf(c, row.state, col.state.width)
    + cellOf(c, row.progress, col.progress.width)
    + cellOf(c, row.pr, col.pr.width);
  const tail = tailOf(c, row.tail, Math.max(0, wide - width(cells)));
  return `${cells}${tail}`.replace(/[ ]+$/u, '');
}

/** The pull request cell of a row, from its `prs`. */
export function prCellOf(prs) {
  const text = prText(prs || []);
  return { text, styles: text ? prTone(prs) : [] };
}
