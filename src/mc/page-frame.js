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
 *   - **More rows than before** — not this function's case, and decided
 *     deliberately, because it is the case that used to fill the scrollback.
 *     The page has grown past the footprint it was printed in and there is
 *     nothing below its last row but rows belonging to the caller, so there
 *     is no in-place write that can be right. The caller prints the page
 *     again whole, from an empty terminal: `CLEAR_ALL` — cursor home, erase
 *     the screen, erase the scrollback — then the lines, exactly as the first
 *     print wrote them. Rows of `next` past the end of `previous` are not
 *     written here.
 *
 * **A page taller than the terminal.** The page is 87 lines at the current
 * `~/mc`, and rows that have scrolled off the top cannot be addressed —
 * moving up past the top row of the screen stops there, so a write meant for
 * an invisible row would land on a visible one and corrupt it. `rows` (the
 * terminal's height) bounds how far up the writes will reach; a changed row
 * further up than that is left alone by the diff. When the change up there
 * matters, the caller asks `topOffScreen` and prints the page again whole —
 * the same reprint as growth: the screen and the scrollback are cleared first,
 * so the terminal only ever holds the current page plus whatever scrolled off
 * since the last whole reprint, never a stack of old pages. The first whole
 * reprint also clears what was in the terminal before `mc` started.
 */

/**
 * Cursor home, erase the screen, erase the scrollback: what every whole
 * reprint of the page starts with, so the tab holds one copy of it.
 */
export const CLEAR_ALL = '\x1b[H\x1b[2J\x1b[3J';

const CSI = '\x1b[';
const CLEAR_LINE = `${CSI}2K`;

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
 * Has the top of the page scrolled off the screen? Then some of its rows cannot
 * be written to, and a change in one of them will never be drawn by
 * `frameWrites` — it skips them, by design.
 */
export function topOffScreen({ above = 0, rows = Infinity, anchor = null } = {}) {
  if (anchor) return anchor - above < 1;
  return Number.isFinite(rows) && above > Math.max(0, rows - 1);
}
