/**
 * The difference between two frames of the page, as bytes for a terminal.
 *
 * `page-render.js` draws lines and deliberately knows nothing about a
 * terminal. This module is the other half: given the lines that are on the
 * screen, the lines that should be, and where the page sits relative to the
 * cursor, it returns the writes that turn the first into the second — and
 * nothing at all when they are the same. It is pure: no stream, no state, no
 * clock, so every case below is asserted as bytes with no terminal involved.
 *
 * **Relative unless the caller has asked the terminal.** Every move is
 * `CSI n A` / `CSI n B` from where the cursor already is, because an absolute
 * row number the caller *guessed* is wrong the moment anything else writes to
 * the terminal: the page has no claim on the screen, it lives in the
 * scrollback with whatever was printed before it, and what is below it — the
 * menu, the prompt, whatever a person is half-way through typing — belongs to
 * somebody else.
 *
 * An absolute row the terminal *reported* is a different thing, and it is the
 * one case where absolute is the safer of the two. `anchor` is the screen row
 * the cursor is on, read back from `CSI 6n` by `page-live.js` after the prompt
 * was printed; with it every target is `CSI ${anchor - above + index};1H` and
 * the return is `CSI ${anchor};1H`. The gain is that a relative walk
 * accumulates: `vertical(target - row)` from row to row means one bad number
 * puts every later write on the wrong row and leaves the row it should have
 * written standing. An absolute move cannot accumulate — each row is addressed
 * from the same reported number — and a frame drawn against a screen that has
 * scrolled is re-anchored rather than re-derived. Without an `anchor` the
 * relative writes are exactly what they were, which is what a terminal that
 * will not answer `CSI 6n` gets.
 *
 * **What the caller owns.** Vertical moves keep the column, so the writes
 * come back to the row they started on, at column 0. The column the cursor
 * was in is not recoverable from arithmetic; a caller that cares (the menu
 * does) saves and restores it around the call.
 *
 * The four cases, and what was decided for each:
 *
 *   - **Unchanged** — no bytes. Not a redraw of identical text: a terminal
 *     that receives nothing is the only way to be sure nothing flickered.
 *   - **A row changed** — one move to that row, `CSI 2K`, the row, one move
 *     back. Rows that did not change are not written to at all.
 *   - **Fewer rows than before** — the surplus rows are cleared where they
 *     stand and the page keeps its footprint. `CSI M` (delete line) would
 *     close the gap, but it would also pull the menu and the prompt up a row
 *     and drop whatever is at the bottom of the screen — rows this page does
 *     not own. A blank row it printed is the page's to blank.
 *   - **More rows than before** — decided deliberately, because this is the
 *     case that can damage the scrollback. The page has grown past the
 *     footprint it was printed in, and there is nothing below its last row
 *     but rows belonging to the caller, so there is no in-place write that
 *     can be right. The writes are therefore a reprint: up to the page's
 *     first reachable row, `CSI 0J` to erase from there to the end of the
 *     screen, then the frame printed as ordinary lines. The terminal scrolls
 *     at the bottom exactly as the first print of the page scrolled it, which
 *     is what puts a line in the scrollback once and correctly — as opposed
 *     to inserting lines (`CSI L`), which does not scroll into the scrollback
 *     at all and silently discards the bottom line of the screen. The cost is
 *     stated rather than hidden: after a growth frame the cursor is at the end
 *     of the last page row, everything below it has been erased, and the
 *     caller reprints its own rows and recomputes `above`. `reprintPlan` is
 *     that recomputation, exported rather than described, because a caller
 *     that derives it a second time derives it differently — see below.
 *
 * **A page taller than the terminal.** The page is 87 lines at the current
 * `~/mc`, and rows that have scrolled off the top cannot be addressed —
 * moving up past the top row of the screen stops there, so a write meant for
 * an invisible row would land on a visible one and corrupt it. `rows` (the
 * terminal's height) bounds how far up the writes will reach; a changed row
 * further up than that is left alone. What has scrolled off is history, and
 * history is not rewritten and not scrolled back to.
 */

const CSI = '\x1b[';
const CLEAR_LINE = `${CSI}2K`;
const ERASE_BELOW = `${CSI}0J`;

const up = (n) => (n > 0 ? `${CSI}${n}A` : '');
const down = (n) => (n > 0 ? `${CSI}${n}B` : '');
const vertical = (delta) => (delta < 0 ? up(-delta) : down(delta));

/**
 * The writes that make a terminal showing `previous` show `next`.
 *
 * `above` is how many rows above the cursor the page's first line sits, so
 * line `i` is `above - i` rows above the cursor. `rows` is the terminal's
 * height, used only to decide how far up the writes may reach: the cursor is
 * assumed to be on the last row of the screen, which is where a page followed
 * by a prompt leaves it, so `rows - 1` rows above it can still be addressed.
 * Left out, nothing is skipped.
 *
 * `anchor` is the screen row the cursor is actually on, as the terminal
 * reported it. Given one, the writes are absolute and `rows` is not needed to
 * find the top of the screen: row 1 is the top, and a page row that would land
 * above it has scrolled off and is left alone.
 */
export function frameWrites(previous, next, { above = 0, rows = Infinity, anchor = null } = {}) {
  const before = previous || [];
  const after = next || [];
  const reach = Number.isFinite(rows) ? Math.max(0, rows - 1) : Infinity;

  if (after.length > before.length) return reprint(after, { above, rows, anchor });

  const writes = [];
  // Where the cursor is, in rows below the row it started on. Unused when the
  // moves are absolute, because an absolute move does not depend on the last.
  let row = 0;
  for (let index = 0; index < before.length; index += 1) {
    const line = index < after.length ? after[index] : '';
    if (line === before[index]) continue;
    if (anchor) {
      const at = anchor - above + index;
      if (at < 1) continue; // above the top of the screen; not ours to rewrite
      writes.push(`${CSI}${at};1H`, CLEAR_LINE, line);
      continue;
    }
    if (above - index > reach) continue; // scrolled off the top; not ours to rewrite
    const target = index - above;
    writes.push(vertical(target - row), CLEAR_LINE, line);
    if (line !== '') writes.push('\r');
    row = target;
  }
  if (writes.length === 0) return '';
  if (anchor) return `${writes.join('')}${CSI}${anchor};1H`;
  return `\r${writes.join('')}${vertical(-row)}`;
}

/**
 * What a reprint of `next` would do, for the caller that has to know where the
 * page ended up. Same arguments as `frameWrites`, describing the page as it
 * stands *before* the reprint.
 *
 * `skip` is how many of the page's first lines are not printed again: they are
 * above the top of the screen, which is history and stays there. `printed` is
 * how many rows the reprint therefore draws.
 *
 * `below` is the one a caller cannot get from the page's length, and the
 * reason this is exported rather than left inside: the lines are *joined*, not
 * terminated, so the cursor comes to rest on the last row of the page rather
 * than on the row under it — one row higher than the first print of the same
 * page leaves it. `below` is where the cursor ends up, counted in rows below
 * the page's first line (that line may itself have scrolled off; the count is
 * still the one the arithmetic needs). A caller that recomputes `above` as
 * `next.length + tail` after a growth frame is one row out, `CSI 2K` clears
 * the neighbour of every row it meant to rewrite, and the row that changed
 * keeps its old text. Measured at 45×120 on a 97-line page, 2026-09-06.
 */
export function reprintPlan(next, { above = 0, rows = Infinity, anchor = null } = {}) {
  const after = next || [];
  const reach = Number.isFinite(rows) ? Math.max(0, rows - 1) : Infinity;
  // The page's first row is `anchor - above`, or `reach` rows above the cursor
  // at the furthest, and what would be above the top of the screen is dropped.
  const skip = anchor ? Math.max(0, 1 - (anchor - above)) : Math.max(0, above - reach);
  const printed = Math.max(0, after.length - skip);
  return { skip, printed, below: skip + Math.max(0, printed - 1) };
}

/** A frame that has outgrown its footprint: erase from the top of what can be reached, print it again. */
function reprint(after, { above, rows, anchor }) {
  const { skip } = reprintPlan(after, { above, rows, anchor });
  if (anchor) return `${CSI}${Math.max(1, anchor - above)};1H${ERASE_BELOW}${after.slice(skip).join('\n')}`;
  return `\r${up(above - skip)}${ERASE_BELOW}${after.slice(skip).join('\n')}`;
}
