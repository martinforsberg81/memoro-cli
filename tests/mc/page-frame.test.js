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
import { frameWrites } from '../../src/mc/page-frame.js';
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
    assert.equal(frameWrites(lines, frame(7200), { above: 24 }), '');
    // The same array, and an empty page, are the same answer.
    assert.equal(frameWrites(lines, lines, { above: 24 }), '');
    assert.equal(frameWrites([], [], { above: 0 }), '');
  });

  it('rewrites the one row that changed, and touches no other row', () => {
    const before = frame(7200);
    const after = frame(10800);
    // Exactly one row of the real page differs: the cache line at the foot.
    const changed = before.reduce((all, line, index) => (line === after[index] ? all : [...all, index]), []);
    assert.deepEqual(changed, [18]);

    // The page's first line sits 24 rows above the cursor: 19 rows of page,
    // then the blank, the two key lines and the blank the menu prints, then
    // the prompt the cursor is sitting on.
    const writes = frameWrites(before, after, { above: 24 });
    assert.equal(writes, `\r\x1b[6A\x1b[2K${after[18]}\r\x1b[6B`);

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

  it('leaves rows that have scrolled off the top alone', () => {
    const before = frame(7200);
    const after = [...frame(10800)];
    after[2] = '  a row nobody can see any more';
    // A terminal ten rows tall: the cursor is on the last of them, so nine
    // rows above it can be addressed. Row 18 is six up and is rewritten; row 2
    // is twenty-two up, off the screen, and is not.
    const writes = frameWrites(before, after, { above: 24, rows: 10 });
    assert.equal(writes, `\r\x1b[6A\x1b[2K${after[18]}\r\x1b[6B`);
    assert.equal(writes.includes(after[2]), false);
    // With nothing left to say on screen, that is no bytes at all.
    const hidden = [...before];
    hidden[2] = '  a row nobody can see any more';
    assert.equal(frameWrites(before, hidden, { above: 24, rows: 10 }), '');
  });

  it('reprints a grown frame from the first row it can still reach', () => {
    const before = ['a', 'b', 'c'];
    const after = ['a', 'b', 'c', 'd'];
    // Four rows tall: three rows above the cursor are addressable, so the
    // reprint starts at row 1 and row 0 is left in the scrollback.
    assert.equal(frameWrites(before, after, { above: 4, rows: 4 }), '\r\x1b[3A\x1b[0Jb\nc\nd');
  });
});
