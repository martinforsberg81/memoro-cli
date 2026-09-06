/**
 * The frame differ, as bytes. No terminal, no stream, no clock — this is the
 * one part of a live surface that can be asserted exactly, so it is the part
 * that carries the assertions: what is written, and just as much, what is not.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  intakeSection, programmesSection, queueSection, runnerSection, sessionsSection,
} from '../../src/mc/page-collect.js';
import { frameWrites, reprintPlan } from '../../src/mc/page-frame.js';
import { renderPageLines } from '../../src/mc/page-render.js';

const NOW = new Date('2026-08-29T12:00:00Z');

/** The page with nothing running, and one datum — the PR cache's age — to move. */
function emptyPage(ageSeconds) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    queue: queueSection({ queue: [], plans: [] }),
    intake: intakeSection({ digest: null, proposals: [], now: NOW }),
    programmes: programmesSection({ areas: [], plans: [] }),
    caches: {
      fresh: false,
      plans: [],
      prs: { fetched: '2026-08-29T10:00:00Z', age_seconds: ageSeconds, count: 1 },
    },
    notes: [],
  };
}

const frame = (ageSeconds) => renderPageLines(emptyPage(ageSeconds), { columns: 100, now: NOW });

describe('the difference between two frames', () => {
  it('writes nothing at all when the frame has not changed', () => {
    const lines = frame(7200);
    assert.equal(frameWrites(lines, frame(7200), { above: 23 }), '');
    // The same array, and an empty page, are the same answer.
    assert.equal(frameWrites(lines, lines, { above: 23 }), '');
    assert.equal(frameWrites([], [], { above: 0 }), '');
  });

  it('rewrites the one row that changed, and touches no other row', () => {
    const before = frame(7200);
    const after = frame(10800);
    // Exactly one row of the real page differs: the cache line at the foot.
    const changed = before.reduce((all, line, index) => (line === after[index] ? all : [...all, index]), []);
    assert.deepEqual(changed, [18]);

    // The page's first line sits 23 rows above the cursor: the 19 rows of the
    // page, then the blank, the two key lines and the blank the menu prints,
    // then the prompt row the cursor is sitting on — `lines.length + 4`.
    const writes = frameWrites(before, after, { above: 23 });
    assert.equal(writes, `\r\x1b[5A\x1b[2K${after[18]}\r\x1b[5B`);

    // Said as the criterion says it: the cursor is positioned once, one row is
    // written, and the writes return to where they started.
    assert.equal(writes.match(/\x1b\[\d+[AB]/gu).length, 2);
    assert.equal(writes.match(/\x1b\[2K/gu).length, 1);
    for (const line of before.filter((text, index) => text !== '' && index !== 18)) {
      assert.equal(writes.includes(line), false, `wrote a row that had not changed: ${line}`);
    }
  });

  it('moves relatively from row to row when more than one changed', () => {
    const before = ['a', 'b', 'c', 'd'];
    const after = ['a', 'B', 'c', 'D'];
    assert.equal(
      frameWrites(before, after, { above: 6 }),
      '\r\x1b[5A\x1b[2KB\r\x1b[2B\x1b[2KD\r\x1b[3B',
    );
  });

  it('clears the surplus rows of a frame that got shorter, and keeps its footprint', () => {
    const before = ['a', 'b', 'c', 'd'];
    const after = ['a', 'b'];
    // Rows 2 and 3 are cleared where they stand: nothing is pulled up, because
    // the rows below the page belong to the menu and the prompt.
    assert.equal(
      frameWrites(before, after, { above: 6 }),
      '\r\x1b[4A\x1b[2K\x1b[1B\x1b[2K\x1b[3B',
    );
    assert.equal(frameWrites(before, [], { above: 4 }), '\r\x1b[4A\x1b[2K\x1b[1B\x1b[2K\x1b[1B\x1b[2K\x1b[1B\x1b[2K\x1b[1B');
  });

  it('reprints a frame that grew, erasing from its first row to the end of the screen', () => {
    const before = ['a', 'b'];
    const after = ['a', 'B', 'c'];
    // Up to the page's first row, erase everything from there down — the rows
    // below belong to the caller and it reprints them — then print the frame.
    // The terminal scrolls at the bottom exactly as the first print did.
    assert.equal(frameWrites(before, after, { above: 4 }), '\r\x1b[4A\x1b[0Ja\nB\nc');
    // A first frame with nothing on screen yet is the same case.
    assert.equal(frameWrites([], ['a', 'b'], { above: 0 }), '\r\x1b[0Ja\nb');
  });

  it('addresses the row absolutely when the terminal has said where the cursor is', () => {
    const before = ['a', 'b', 'c', 'd'];
    const after = ['a', 'B', 'c', 'D'];
    // The cursor is on row 30 and the page's first row six above it, on 24.
    assert.equal(
      frameWrites(before, after, { above: 6, anchor: 30 }),
      '\x1b[25;1H\x1b[2KB\x1b[27;1H\x1b[2KD\x1b[30;1H',
    );
    // The point of it: a wrong `above` moves the whole frame together. Every
    // row is one further up and no row is left holding the old text, which is
    // what a relative walk does with the same wrong number.
    assert.equal(
      frameWrites(before, after, { above: 7, anchor: 30 }),
      '\x1b[24;1H\x1b[2KB\x1b[26;1H\x1b[2KD\x1b[30;1H',
    );
  });

  it('leaves a reported row above the top of the screen alone', () => {
    const before = ['a', 'b', 'c'];
    const after = ['A', 'b', 'C'];
    // The page's first row is at 4 - 5 = -1, off the top; row 1 is on screen.
    assert.equal(frameWrites(before, after, { above: 5, anchor: 4 }), '\x1b[1;1H\x1b[2KC\x1b[4;1H');
  });

  it('reprints a grown frame from the reported row', () => {
    assert.equal(frameWrites(['a', 'b'], ['a', 'B', 'c'], { above: 4, anchor: 10 }), '\x1b[6;1H\x1b[0Ja\nB\nc');
    // Starting above the screen: the reprint begins at row 1 and the rows that
    // scrolled off are not printed again.
    assert.equal(frameWrites(['a', 'b', 'c'], ['a', 'b', 'c', 'd'], { above: 5, anchor: 3 }), '\x1b[1;1H\x1b[0Jd');
  });

  it('leaves rows that have scrolled off the top alone', () => {
    const before = frame(7200);
    const after = [...frame(10800)];
    after[2] = '  a row nobody can see any more';
    // A terminal ten rows tall: the cursor is on the last of them, so nine
    // rows above it can be addressed. Row 18 is five up and is rewritten; row 2
    // is twenty-one up, off the screen, and is not.
    const writes = frameWrites(before, after, { above: 23, rows: 10 });
    assert.equal(writes, `\r\x1b[5A\x1b[2K${after[18]}\r\x1b[5B`);
    assert.equal(writes.includes(after[2]), false);
    // With nothing left to say on screen, that is no bytes at all.
    const hidden = [...before];
    hidden[2] = '  a row nobody can see any more';
    assert.equal(frameWrites(before, hidden, { above: 23, rows: 10 }), '');
  });

  it('reprints a grown frame from the first row it can still reach', () => {
    const before = ['a', 'b', 'c'];
    const after = ['a', 'b', 'c', 'd'];
    // Four rows tall: three rows above the cursor are addressable, so the
    // reprint starts at row 1 and row 0 is left in the scrollback.
    assert.equal(frameWrites(before, after, { above: 4, rows: 4 }), '\r\x1b[3A\x1b[0Jb\nc\nd');
  });
});

describe('where a reprint leaves the page', () => {
  /** The shape Martin was looking at: 45 rows, and 98 lines to put in them. */
  const page = Array.from({ length: 98 }, (unused, index) => `row ${index}`);

  it('says how much of a page taller than the screen is printed again', () => {
    // The page's first row is 56 rows above the top of the screen, so 57 lines
    // are history; the 41 that are left are what the reprint draws.
    const plan = reprintPlan(page, { above: 101, rows: 45, anchor: 45 });
    assert.deepEqual(plan, { skip: 57, printed: 41, below: 97 });
    // And by count it is the same arithmetic through `reach`.
    assert.deepEqual(reprintPlan(page, { above: 101, rows: 45 }), { skip: 57, printed: 41, below: 97 });
  });

  it('counts the cursor onto the last row it printed, not under it', () => {
    // The lines are joined, not terminated: three rows printed leaves the
    // cursor two rows below the first of them, which is one less than the
    // first print of the same page — that one row is the whole of the fault.
    assert.deepEqual(reprintPlan(['a', 'b', 'c'], { above: 4, anchor: 10 }), { skip: 0, printed: 3, below: 2 });
    assert.deepEqual(reprintPlan([], { above: 0 }), { skip: 0, printed: 0, below: 0 });
  });

  it('is the arithmetic the reprint itself uses', () => {
    // Said as an assertion rather than as a comment: the bytes start at the
    // row `skip` names, so a caller reading `reprintPlan` is reading what the
    // page did, not a second opinion about it.
    for (const at of [{ above: 101, rows: 45, anchor: 45 }, { above: 101, rows: 45 }]) {
      const { skip } = reprintPlan(page, at);
      const writes = frameWrites(page.slice(0, 97), page, at);
      assert.ok(writes.endsWith(page.slice(skip).join('\n')), JSON.stringify(writes.slice(0, 40)));
      assert.ok(!writes.includes(page[skip - 1]), 'and nothing above it');
    }
  });
});
