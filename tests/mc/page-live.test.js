/**
 * The loop that refreshes the page while the menu is waiting for a line.
 *
 * Everything here is asserted as bytes and as fake time: the reader is handed
 * an input it can be typed into, a stdout that is an array, and a clock the
 * test moves. What a real terminal does with those bytes is the one thing this
 * cannot say — `scripts/mc-live-page-check.mjs` runs the real `mc` in a real
 * pty and says it.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { liveReader, plainReader, readLine } from '../../src/mc/page-live.js';

const ESC = '\x1b';
const SAVE = '\x1b7';
const RESTORE = '\x1b8';
const KEYS = '  <n>  open it\n  q  quit';
const TAIL = `\n${KEYS}\n\n`;

/** The page, as three rows with one that moves. */
const frame = (age) => ['  RUNNER', '  PROGRAMMES', `  cached ${age}`];

/** A stdout that keeps what it was written, and can be resized. */
function screen({ columns = 100, rows = 40 } = {}) {
  const events = new EventEmitter();
  const written = [];
  return {
    columns,
    rows,
    written,
    write: (text) => { written.push(text); return true; },
    on: (name, fn) => events.on(name, fn),
    off: (name, fn) => events.off(name, fn),
    resize(next) { this.columns = next; events.emit('resize'); },
    /** Everything written since the prompt went up, as one string. */
    since(index) { return written.slice(index).join(''); },
  };
}

/** A terminal to type into: `type` is a person at a keyboard. */
function keyboard() {
  const input = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = () => {};
  input.destroyed = false;
  input.destroy = () => { input.destroyed = true; };
  input.type = (text) => input.emit('data', text);
  return input;
}

/**
 * Fake time. `advance` runs the timers that fall due and lets the promises
 * they resolve settle, so a collect that takes longer than the interval can be
 * watched rather than guessed at.
 */
function clock() {
  let at = 0;
  let id = 0;
  const pending = [];
  return {
    now: () => at,
    set(fn, ms) { id += 1; pending.push({ id, due: at + ms, fn }); return id; },
    clear(which) {
      const index = pending.findIndex((timer) => timer.id === which);
      if (index >= 0) pending.splice(index, 1);
    },
    async advance(ms) {
      const target = at + ms;
      for (;;) {
        pending.sort((a, b) => a.due - b.due);
        if (pending.length === 0 || pending[0].due > target) break;
        const next = pending.shift();
        at = next.due;
        next.fn();
        await settle();
      }
      at = target;
      await settle();
    },
  };
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe('the live page under the prompt', () => {
  /**
   * A reader with the clock, the keyboard and the page all handed in. `pages`
   * is what each successive collect answers.
   */
  function live(pages, { columns = 100, rows = 40 } = {}) {
    const stdout = screen({ columns, rows });
    const input = keyboard();
    const time = clock();
    const collected = [];
    let inFlight = 0;
    let most = 0;
    const page = async () => {
      collected.push(time.now());
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        const next = pages.shift();
        if (typeof next === 'function') return await next(time);
        return { data: {}, lines: next };
      } finally { inFlight -= 1; }
    };
    const reader = liveReader({
      stdout,
      lines: frame('2 h'),
      page,
      intervalMs: 30_000,
      input: () => input,
      setTimer: (fn, ms) => time.set(fn, ms),
      clearTimer: (which) => time.clear(which),
    });
    return {
      stdout, input, time, reader, collected, at: () => stdout.written.length, most: () => most,
    };
  }

  it('writes nothing at all when the page has not changed', async () => {
    const it_ = live([frame('2 h')]);
    const answer = it_.reader.ask(TAIL, '>');
    const mark = it_.at();
    await it_.time.advance(31_000);
    assert.equal(it_.collected.length, 1, 'the interval came round once');
    assert.equal(it_.stdout.since(mark), '', 'an unchanged page is no bytes, not a redraw');
    it_.input.type('q\r');
    assert.equal(await answer, 'q');
  });

  it('rewrites the row that changed and leaves the prompt row alone', async () => {
    const it_ = live([frame('3 h')]);
    const answer = it_.reader.ask(TAIL, '>');
    it_.input.type('1');
    const mark = it_.at();
    await it_.time.advance(31_000);

    const writes = it_.stdout.since(mark);
    // Around the cursor and back: the person's row is never written to, so the
    // half-typed `1` is still where they left it and so is the cursor.
    assert.ok(writes.startsWith(SAVE), writes);
    assert.ok(writes.endsWith(RESTORE), writes);
    assert.ok(writes.includes('cached 3 h'), 'the row that changed is written');
    assert.ok(!writes.includes('RUNNER') && !writes.includes('PROGRAMMES'), 'no other row is');
    assert.ok(!writes.includes('>'), 'the prompt is not reprinted');
    // Three page rows and four newlines under them: the first page row sits 7
    // rows above the cursor, the last of them 5.
    assert.ok(writes.includes(`${ESC}[5A`), `the row is addressed from the prompt: ${JSON.stringify(writes)}`);

    it_.input.type('\r');
    assert.equal(await answer, '1', 'and the line that comes back is the one that was typed');
  });

  it('reprints itself, its keys and the half-typed answer when the page grows', async () => {
    const grown = [...frame('2 h'), '  one more row'];
    const it_ = live([grown]);
    const answer = it_.reader.ask(TAIL, '>');
    it_.input.type('12');
    const mark = it_.at();
    await it_.time.advance(31_000);

    const writes = it_.stdout.since(mark);
    // A frame past its footprint is a reprint that erases everything below the
    // page, so the rows below it are the caller's to put back — all of them.
    assert.ok(writes.includes(`${ESC}[0J`), 'erased from the page down');
    assert.ok(writes.endsWith(`${grown.join('\n')}${TAIL}> 12`), JSON.stringify(writes.slice(-80)));
    assert.ok(!writes.includes(SAVE), 'nothing to come back to: the screen below the page is gone');

    it_.input.type('\r');
    assert.equal(await answer, '12');
  });

  it('blanks the rows a shorter page leaves behind, and keeps its footprint', async () => {
    const it_ = live([['  RUNNER'], ['  RUNNER', '  PROGRAMMES', '  cached 2 h']]);
    const answer = it_.reader.ask(TAIL, '>');
    let mark = it_.at();
    await it_.time.advance(31_000);
    const shrunk = it_.stdout.since(mark);
    assert.ok(shrunk.includes(`${ESC}[2K`), 'the surplus rows are cleared where they stand');
    assert.ok(!shrunk.includes(`${ESC}[0J`), 'and the menu below them is not moved or erased');

    // Back to three rows is not growth: the footprint never shrank, so those
    // two rows are written in place rather than the page being reprinted.
    mark = it_.at();
    await it_.time.advance(31_000);
    const back = it_.stdout.since(mark);
    assert.ok(back.includes('PROGRAMMES') && back.includes('cached 2 h'));
    assert.ok(!back.includes(`${ESC}[0J`), 'a page back inside its own footprint is not a reprint');

    it_.input.type('q\r');
    assert.equal(await answer, 'q');
  });

  it('holds the last good frame when a collect throws, and says so in one line', async () => {
    const it_ = live([
      () => { throw new Error('git: not a repository\nand a second line nobody needs'); },
      frame('4 h'),
    ]);
    const answer = it_.reader.ask(TAIL, '>');
    let mark = it_.at();
    await it_.time.advance(31_000);

    const held = it_.stdout.since(mark);
    assert.match(held, /holding the last frame — git: not a repository/u);
    assert.ok(!held.includes('and a second line'), 'one line, not a stack');
    assert.ok(!held.includes('RUNNER'), 'the frame on screen is left exactly where it is');
    // In the blank row the menu prints between the page and the keys: four
    // rows up, and back, so nothing grows and nothing scrolls.
    assert.ok(held.startsWith(`${SAVE}${ESC}[4A`), JSON.stringify(held));
    assert.ok(held.endsWith(RESTORE));

    // A failed collect does not stop the loop, and the frame that follows it
    // takes the line back off the screen.
    mark = it_.at();
    await it_.time.advance(31_000);
    const recovered = it_.stdout.since(mark);
    assert.equal(it_.collected.length, 2, 'the loop kept its interval through the failure');
    assert.ok(recovered.includes('cached 4 h'));
    assert.ok(recovered.startsWith(`${SAVE}${ESC}[4A\r${ESC}[2K${RESTORE}`), 'the line is cleared first');

    it_.input.type('q\r');
    assert.equal(await answer, 'q');
  });

  it('reprints rather than diffs after the terminal has been resized', async () => {
    const it_ = live([frame('2 h')]);
    const answer = it_.reader.ask(TAIL, '>');
    const mark = it_.at();
    it_.stdout.resize(80);
    await it_.time.advance(31_000);

    const writes = it_.stdout.since(mark);
    // The same three rows as before — which would have been no bytes at all —
    // but the widths they were drawn for are gone, so the page is printed
    // again rather than diffed against lines that no longer describe the
    // screen.
    assert.ok(writes.includes(`${ESC}[0J`), JSON.stringify(writes));
    assert.ok(writes.endsWith(`${frame('2 h').join('\n')}${TAIL}> `));

    it_.input.type('q\r');
    assert.equal(await answer, 'q');
  });

  it('never has two collects in flight, and delays rather than queues a slow one', async () => {
    // Every collect takes 45 s — longer than the interval, which is the worst
    // case measured on 2026-09-02.
    const slow = (time) => new Promise((resolve) => {
      time.set(() => resolve({ data: {}, lines: frame(`${time.now()}`) }), 45_000);
    });
    const it_ = live([slow, slow, slow, slow]);
    const answer = it_.reader.ask(TAIL, '>');
    const drawn = [];
    const write = it_.stdout.write;
    it_.stdout.write = (text) => { drawn.push(it_.time.now()); return write(text); };

    await it_.time.advance(200_000);

    assert.equal(it_.most(), 1, 'never two in flight');
    // The interval is a floor and it is measured from the end of the last
    // collect: 30 s of quiet, then 45 s of collecting, and nothing queued
    // behind it.
    assert.deepEqual(it_.collected, [30_000, 105_000, 180_000]);
    assert.deepEqual(drawn, [75_000, 150_000], 'every collect that finished was drawn — none skipped');

    it_.input.type('q\r');
    assert.equal(await answer, 'q');
  });

  it('drops the frame a collect was still holding when the answer arrives', async () => {
    const slow = (time) => new Promise((resolve) => {
      time.set(() => resolve({ data: {}, lines: frame('9 h') }), 45_000);
    });
    const it_ = live([slow]);
    const answer = it_.reader.ask(TAIL, '>');
    await it_.time.advance(31_000);
    const mark = it_.at();
    it_.input.type('q\r');
    assert.equal(await answer, 'q');
    // The collect is still running; when it lands, those rows belong to
    // whatever mc does next, not to a frame nobody is waiting for.
    await it_.time.advance(60_000);
    assert.equal(it_.stdout.since(mark), 'q\n', 'only the answer itself, echoed');
  });

  it('stops the clock and gives the terminal back when the answer comes', async () => {
    const it_ = live([frame('2 h')]);
    const answer = it_.reader.ask(TAIL, '>');
    it_.input.type('\x03'); // ctrl-c
    assert.equal(await answer, null, 'ctrl-c is a way out, like q');
    assert.equal(it_.input.destroyed, true, 'the terminal is handed back');
    await it_.time.advance(120_000);
    assert.equal(it_.collected.length, 0, 'and nothing refreshes after it');
  });
});

describe('a line typed at a terminal in raw mode', () => {
  function typing(text) {
    const stdout = screen();
    const input = keyboard();
    const line = readLine({ input, stdout });
    input.type(text);
    return { line, echoed: () => stdout.written.join('') };
  }

  it('echoes what was typed, because raw mode does not', async () => {
    const session = typing('open\r');
    assert.equal(await session.line, 'open');
    assert.equal(session.echoed(), 'open\n');
  });

  it('takes a character back on backspace and the line on ctrl-u', async () => {
    assert.equal(await typing('12\x7f3\r').line, '13');
    assert.equal(await typing('mc-ui\x15q\r').line, 'q');
  });

  it('swallows the arrow keys rather than echoing them as rubbish', async () => {
    const session = typing(`1${ESC}[A${ESC}[B2\r`);
    assert.equal(await session.line, '12');
    assert.ok(!session.echoed().includes(ESC), session.echoed());
  });

  it('reads nothing typed, ctrl-c, ctrl-d and a closed terminal as the same answer', async () => {
    assert.equal(await typing('\r').line, null);
    assert.equal(await typing('\x03').line, null);
    assert.equal(await typing('\x04').line, null);
    const input = keyboard();
    const line = readLine({ input, stdout: screen() });
    input.emit('end');
    assert.equal(await line, null);
  });
});

describe('the reader a terminal too narrow for the live page gets', () => {
  it('prints the keys, asks, and refreshes nothing', async () => {
    const stdout = screen({ columns: 40 });
    const reader = plainReader({ stdout, ask: () => '2' });
    assert.equal(await reader.ask(TAIL, '>'), '2');
    assert.equal(stdout.written.join(''), TAIL);
  });
});
