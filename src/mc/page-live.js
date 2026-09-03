/**
 * The loop that does not interrupt the prompt.
 *
 * `page-frame.js` says what to write; this module is what runs while somebody
 * is sitting in front of it. The page is printed once, and from then on the
 * rows that changed are rewritten where they stand, every 30 seconds, while
 * the menu below is waiting for a line of input. Nothing else on the screen
 * moves: not the scrollback above, not the two key lines, not the prompt, not
 * the cursor in whatever the person is half-way through typing.
 *
 * **Why the reading had to change.** `prompt.js` reads a line with a blocking
 * `readSync` on `/dev/tty`. Blocking is the whole problem: no timer fires
 * while the process is parked in a syscall, so as long as the answer is read
 * that way nothing can happen between one question and its answer. The live
 * reader borrows `/dev/tty` the same way — its own descriptor, never
 * `process.stdin`, so the tool mc launches next inherits an untouched
 * terminal — but reads it asynchronously and in raw mode.
 *
 * **Why raw mode, given that the terminal's own line editing is free.** The
 * page grows: a session starts, a pull request appears, and a frame with more
 * rows than the last one cannot be written in place (`page-frame.js` says why
 * at length). It is reprinted, and everything below it — the key lines, the
 * prompt, the half-typed answer — has to be printed again by whoever owns
 * those rows. In canonical mode the typed characters live in the kernel's
 * line buffer where this process cannot see them, so a growth frame would
 * blank a person's input off the screen while still, invisibly, holding it.
 * Raw mode is what makes "half-typed input survives" true in every frame
 * rather than most of them. The price is that the echo, the backspace and
 * ctrl-c are ours, and they are the whole of `readLine` below.
 *
 * **Two numbers hold the geometry.** `footprint` is how many rows the page
 * occupies on screen — set when the page is printed, and unchanged by a frame
 * with fewer rows, because a shrinking frame blanks its surplus rows where
 * they stand rather than pulling the menu up. `above` is `footprint` plus the
 * newlines in the block the menu prints under the page, which is how many
 * rows above the cursor the page's first row sits. Both are derived, never
 * assumed: change what the menu prints under the page and the arithmetic
 * follows.
 *
 * **What is not live.** A terminal narrower than 60 columns, which is
 * `columnsFor`'s floor: every page row is then wider than the screen and
 * wraps, every row of the arithmetic above is off by the number of wrapped
 * rows, and a write meant for one row would land on another. There the page
 * is printed once and read the way it always was — `plainReader` — which is
 * also what a test drives. A pipe never gets here at all: `run()` returns
 * before the menu when there is no terminal.
 */
import { closeSync, constants, openSync, readSync } from 'node:fs';
import { ReadStream } from 'node:tty';

import { frameWrites } from './page-frame.js';
import { ask as askTerminal } from './prompt.js';
import { clip } from './status-render.js';

/** The interval. One number, chosen, and a floor rather than a schedule. */
export const REFRESH_MS = 30_000;

/** Below this the page wraps and none of the row arithmetic holds. */
export const LIVE_MIN_COLUMNS = 60;

const SAVE = '\x1b7';
const RESTORE = '\x1b8';
const CLEAR_LINE = '\x1b[2K';
const up = (n) => (n > 0 ? `\x1b[${n}A` : '');

/** Writes that go somewhere else on the screen and come back. */
const aside = (body) => (body ? `${SAVE}${body}${RESTORE}` : '');

const newlines = (text) => (String(text).match(/\n/gu) || []).length;

/**
 * The reader for a terminal too narrow to hold the page, and the one a test
 * drives: the page is printed, the line is asked for, and nothing refreshes.
 * Exactly what `mc` did before it was live.
 */
export function plainReader({ stdout, ask = askTerminal }) {
  return {
    async ask(tail, prompt) {
      stdout.write(tail);
      return ask(prompt, { stdout });
    },
    show(lines) {
      stdout.write(`${lines.join('\n')}\n`);
    },
  };
}

/**
 * The live one.
 *
 * `lines` is the page already on the screen — `run()` prints it before it
 * knows whether anybody is watching. `page()` is one collect and one render,
 * the same call the first print used, so a refresh is a read and nothing else.
 */
export function liveReader({
  stdout,
  lines,
  page,
  intervalMs = REFRESH_MS,
  input: openInput = openTty,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // Always exactly as long as the page's footprint: a frame with fewer rows
  // blanks the surplus where it stands, so the rows are still ours and still
  // have to be compared against something.
  let current = [...lines];
  let tailRows = 0;
  let typed = '';
  let holding = false;

  return { ask, show };

  function show(next) {
    stdout.write(`${next.join('\n')}\n`);
    current = [...next];
    holding = false;
  }

  /**
   * The block the menu prints under the page, the prompt, and then the two
   * things happening at once until a line comes back: the reading, and the
   * refreshing above it.
   */
  async function ask(tail, prompt) {
    tailRows = newlines(tail);
    typed = '';
    stdout.write(`${tail}${prompt} `);

    const promptText = `${prompt} `;
    let stopped = false;
    let timer = null;
    let dirty = false;

    // A resize invalidates the frame rather than the page: the widths were
    // computed for the old columns, so the next frame is reprinted whole
    // rather than diffed against lines that no longer describe the screen.
    const onResize = () => { dirty = true; };
    stdout.on?.('resize', onResize);

    const schedule = () => { timer = setTimer(tick, intervalMs); };
    schedule();

    const inputStream = openInput();
    try {
      const answer = await readLine({
        input: inputStream,
        stdout,
        onTyped: (value) => { typed = value; },
      });
      stopped = true;
      clearTimer(timer);
      return answer;
    } finally {
      stopped = true;
      clearTimer(timer);
      stdout.off?.('resize', onResize);
      closeInput(inputStream);
    }

    /**
     * One refresh. The interval is a floor and it is measured from the end of
     * the last collect: the next one is scheduled when this one has finished
     * drawing, so there are never two in flight and a collect slower than the
     * interval delays the next frame instead of queueing one behind it.
     */
    async function tick() {
      let next = null;
      try {
        next = await page();
      } catch (err) {
        if (!stopped) hold(err);
        if (!stopped) schedule();
        return;
      }
      // The answer came in while the collect was running: those rows belong to
      // whatever happens next, not to a frame nobody is waiting for any more.
      if (stopped) return;
      draw(next.lines);
      schedule();
    }

    /** The frame, written where the page stands. */
    function draw(next) {
      const rows = Number(stdout.rows) || Infinity;
      const above = current.length + tailRows;

      if (dirty || next.length > current.length) {
        // Grown past its footprint, or drawn for a terminal that has since
        // changed shape. `frameWrites` erases from the page down and prints
        // the frame as ordinary lines — which leaves nothing below it, so the
        // rows under the page are this caller's to print again, the typed
        // answer among them.
        stdout.write(`${frameWrites([], next, { above, rows })}${tail}${promptText}${typed}`);
        current = [...next];
        dirty = false;
        holding = false;
        return;
      }

      const writes = frameWrites(current, next, { above, rows });
      const cleared = holding ? `${up(tailRows)}\r${CLEAR_LINE}` : '';
      if (writes || cleared) stdout.write(`${aside(cleared)}${aside(writes)}`);
      // Padded back to the footprint: the surplus rows are blank on screen and
      // a later frame has to be compared against blank rows, not against the
      // rows that used to be there.
      current = [...next, ...Array(Math.max(0, current.length - next.length)).fill('')];
      holding = false;
    }

    /**
     * A collect that threw. The last good frame stays exactly where it is and
     * one line says so, in the blank row the menu prints between the page and
     * the keys — a row this loop can write without the page growing and
     * without anything scrolling. A live surface that blanks on a transient
     * failure is worse than one that says it is holding an old frame.
     */
    function hold(err) {
      const width = Number(stdout.columns) || 80;
      const note = clip(`  mc: holding the last frame — ${message(err)}`, width);
      stdout.write(aside(`${up(tailRows)}\r${CLEAR_LINE}${note}`));
      holding = true;
    }
  }
}

const message = (err) => String(err?.message || err || 'unknown').split('\n')[0];

/**
 * One line, typed at a terminal in raw mode.
 *
 * Raw mode means the echo is ours, so this is exactly as much line editing as
 * the menu needs and no more: characters, backspace, ctrl-u, and the two ways
 * of leaving. Arrow keys and anything else that arrives as an escape sequence
 * are swallowed rather than echoed as rubbish — the menu has no history to
 * walk through.
 *
 * Returns the trimmed line, or null for nothing at all: an empty answer,
 * ctrl-c, ctrl-d and a closed input are all the same answer, which the menu
 * reads as quit — the same as before it was live.
 */
export function readLine({ input, stdout, onTyped = () => {} }) {
  return new Promise((resolve) => {
    let buffer = '';
    let escape = false;
    let settled = false;

    const done = (value) => {
      if (settled) return;
      settled = true;
      input.off?.('data', onData);
      input.off?.('end', onEnd);
      input.off?.('error', onEnd);
      resolve(value);
    };
    // The newline is ours too: in raw mode the terminal does not echo the
    // return, and a shell prompt printed on the same row as the answer is not
    // the terminal mc was handed.
    const leave = (value) => { stdout.write('\n'); done(value); };
    const onEnd = () => done(null);

    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (escape) {
          if (/[A-Za-z~]/u.test(ch)) escape = false;
          continue;
        }
        if (ch === '\x1b') { escape = true; continue; }
        if (ch === '\r' || ch === '\n') { leave(buffer.trim() || null); return; }
        if (ch === '\x03') { leave(null); return; } // ctrl-c
        if (ch === '\x04') { if (buffer === '') { leave(null); return; } continue; } // ctrl-d
        if (ch === '\x7f' || ch === '\b') {
          if (buffer) {
            buffer = buffer.slice(0, -1);
            stdout.write('\b \b');
            onTyped(buffer);
          }
          continue;
        }
        if (ch === '\x15') { // ctrl-u
          if (buffer) {
            stdout.write('\b \b'.repeat(buffer.length));
            buffer = '';
            onTyped(buffer);
          }
          continue;
        }
        if (ch < ' ') continue;
        buffer += ch;
        stdout.write(ch);
        onTyped(buffer);
      }
    };

    input.on('data', onData);
    input.on?.('end', onEnd);
    input.on?.('error', onEnd);
  });
}

/**
 * The terminal, borrowed.
 *
 * Its own descriptor on `/dev/tty` rather than `process.stdin`, for the reason
 * `prompt.js` gives: node takes a stream over when it reads it, and handing it
 * back to the tool mc launches next turned out not to be something it can do.
 * Raw mode is a property of the terminal rather than of the descriptor, so it
 * is restored before the descriptor is closed — and again on the way out of
 * the process, in case something throws between here and there.
 */
function openTty() {
  const fd = openSync('/dev/tty', 'r');
  const stream = new ReadStream(fd);
  stream.setEncoding('utf8');
  stream.setRawMode?.(true);
  stream.resume();
  const restore = () => { try { stream.setRawMode?.(false); } catch { /* gone */ } };
  process.on('exit', restore);
  stream.mcRestore = restore;
  return stream;
}

/**
 * Destroying the stream closes the descriptor; the mode is put back first, and
 * then one read that looks pointless and is not.
 *
 * macOS sets `PENDIN` — "retype the pending input" — in the terminal's flags
 * on *every* switch back to canonical mode, whether or not anything is
 * actually pending. Measured 2026-09-03 in a pty: `stty -g` before `mc` and
 * after it differed by that one bit, and the input queue was empty. The
 * driver clears the bit the first time it services a read, so a single
 * non-blocking read — `EAGAIN`, almost always — is what makes the terminal mc
 * gives back bit-for-bit the terminal it was handed. Anything it does find was
 * typed at mc's prompt after the answer, which makes it mc's to drop rather
 * than the shell's to inherit.
 */
function closeInput(stream) {
  try { stream.mcRestore?.(); } catch { /* gone */ }
  if (stream.mcRestore) process.off('exit', stream.mcRestore);
  settleTty();
  try { stream.destroy?.(); } catch { /* gone */ }
}

function settleTty() {
  let fd = null;
  try {
    fd = openSync('/dev/tty', constants.O_RDONLY | constants.O_NONBLOCK);
    readSync(fd, Buffer.alloc(64), 0, 64, null);
  } catch { /* EAGAIN when there is nothing there, which is the ordinary case */ }
  if (fd !== null) { try { closeSync(fd); } catch { /* gone */ } }
}
