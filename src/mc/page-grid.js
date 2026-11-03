/**
 * The page's one grid: the columns every row of PROGRAMMES, SESSIONS and
 * MERGES is drawn in — and DEV's, when it comes (goal mc/dev-section).
 *
 * Each section had widths of its own: a project row's (`projectColumns`), which
 * a goal borrowed and filled with `g · <name>` and `N sessions`; a lane row's
 * (`LANE_KIND`, `workWidth`, `SESSION_REPO`); and none at all for a merge. So the
 * repository, the state and the pull request stood at a different x in every
 * section (Martin, 2026-11-03: *"vi behöver sätta fast kolumner"*). Here they
 * stand at one:
 *
 *   nr+mark  kind  name  repo  state  progress  pr  tail
 *
 * The same kind of fact in the same column, in every section: a row's name
 * where the name stands, its repository where the repository stands, its pull
 * request in the PR column, and the grey tail last. A row is drawn from the
 * fields `mc --json` carries under the same names in every section — `name`,
 * `repo`, `state`, `progress`, `prs` — and the page computes nothing the JSON
 * lacks.
 *
 * **What gives way, in order** (docs/technical/mc-ui.md § *The grid*): the
 * tail first — it takes what is left — then the repository, which is not drawn
 * under 90 columns, then the name shortens. The state, the progress and the
 * pull request never give way: they are the answer.
 *
 * **A cell is clipped with `…` and never in the middle of a number.** A cell
 * whose cut would fall inside a run of digits is cut before the run, so
 * `#14709` is never `#147…` and `12/30` never `12/3…`.
 *
 * The palette is here too: one colour per state word and one per kind word,
 * wherever the word is printed (`STATE_TONE`, `KIND_TONE`). The table in
 * mc-ui.md § *The palette* is read against them by a test.
 */
import { width } from './status-render.js';

/** Where the grid changes shape: a repository column from here up. */
export const GRID_ROOMY = 90;

/** The fixed widths. Each includes the one space that separates it from the next cell. */
export const GRID = Object.freeze({
  indent: 2,
  // `` 12 ● `` — the row's number, right-aligned in three, and its mark.
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
  merging: ['green'],
  queued: ['green'],
  gate: ['green'],
  rebase: ['green'],
  fixing: ['green'],
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
 * `build`, `review` — and the foreground verbs; the merger's four (`gate` a
 * round, `wait` the queue, `fix` a red a session holds, `red`); and the two
 * kinds of work PROGRAMMES lists, which are bookkeeping. `step` is a project's
 * build under the word it had before.
 */
export const KIND_TONE = Object.freeze({
  build: ['green'],
  step: ['green'],
  review: ['magenta'],
  triage: ['blue'],
  brief: ['cyan'],
  plan: ['cyan'],
  gate: ['green'],
  fix: ['green'],
  wait: ['grey'],
  red: ['red'],
  project: ['grey'],
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
  const mark = row.mark?.text || ' ';
  const head = `${' '.repeat(GRID.indent)}${row.nr == null ? nr : c(nr, 'grey')} `
    + `${row.mark?.styles?.length ? c(mark, ...row.mark.styles) : mark} `;
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
