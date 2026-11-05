/** Shared palette, clocks and numeric-safe clipping for the page layouts. */
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
  manager: ['cyan'],
  brief: ['cyan'],
  plan: ['blue'],
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
