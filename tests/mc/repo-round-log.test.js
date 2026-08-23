/**
 * One line per gate round — every round, not only the survivors (A7).
 *
 * The review that ordered this measured "92 machine-run rounds, 0 with a
 * red delta" and then tore its own number down: the merge log is written
 * after a successful merge, so "0 of 92" can never contain a round that
 * stopped on red. What is asserted here is that a stopped round, a refused
 * round and a merged round all leave a line, that the line carries where
 * it stopped and what it had cost, and that counting them answers the
 * question the merge log cannot.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  countRounds, readRounds, recordRound, roundLogPath,
} from '../../src/mc/repo-round-log.js';

function home() {
  return mkdtempSync(join(tmpdir(), 'mc-round-log-'));
}

const NOW = new Date('2026-08-23T21:00:00.000Z');

describe('every round leaves a line', () => {
  it('a merged round, a red round and a refused lease are all lines, with stopped_at and cost', () => {
    const root = home();
    try {
      recordRound({
        repo: '/x/memoro', pr: { number: 401 }, holder: 'pm', ok: true, merged: true,
        stopped_at: null, reason: null, duration_ms: 300_000, started_at: '2026-08-23T20:00:00.000Z',
        gate: { timings: { 'suite candidate': 146_000 }, standing_red: 0, broke: [] },
      }, { root, now: NOW });
      recordRound({
        repo: '/x/memoro', pr: { number: 402 }, holder: 'pm', ok: false, merged: false,
        stopped_at: 'red', reason: '2 tests red on the candidate and green on the baseline', duration_ms: 280_000,
        gate: { timings: {}, standing_red: 55, broke: ['a', 'b'] },
      }, { root, now: NOW });
      recordRound({
        repo: '/x/memoro', pr: { number: 403 }, holder: 'msr-track-1', ok: false, merged: false,
        stopped_at: 'suite-lease', reason: 'the suite right is held by pm', duration_ms: 900,
      }, { root, now: NOW });

      const { rounds, skipped } = readRounds({ root });
      assert.equal(skipped, 0);
      assert.deepEqual(rounds.map((line) => [line.prs, line.stopped_at, line.merged]), [
        [[401], null, [401]],
        [[402], 'red', []],
        [[403], 'suite-lease', []],
      ]);
      assert.equal(rounds[1].broke, 2);
      assert.equal(rounds[1].standing_red, 55);
      assert.equal(rounds[2].duration_ms, 900, 'the cost of a refusal is a fact too');

      const counted = countRounds(rounds);
      assert.equal(counted.rounds, 3);
      assert.equal(counted.merged_prs, 1);
      assert.deepEqual(counted.by_stop, { completed: 1, red: 1, 'suite-lease': 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a batch round is one line carrying which landed and which did not', () => {
    const root = home();
    try {
      recordRound({
        repo: '/x/memoro', pr: { number: 401 }, holder: 'pm', ok: false, merged: false,
        batch: { prs: [401, 402, 403], merges: [{ number: 401, merged: true }, { number: 402, merged: false }] },
        stopped_at: 'merge', reason: '#402: not mergeable', duration_ms: 400_000,
        gate: { timings: { 'suite baseline': 140_000 } },
      }, { root, now: NOW });
      const { rounds } = readRounds({ root });
      assert.deepEqual(rounds[0].prs, [401, 402, 403]);
      assert.deepEqual(rounds[0].merged, [401]);
      assert.equal(rounds[0].stopped_at, 'merge');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lines that will not parse are skipped and counted, never guessed at', () => {
    const root = home();
    try {
      recordRound({ repo: '/x/r', pr: { number: 1 }, ok: true, merged: true }, { root, now: NOW });
      appendFileSync(roundLogPath(root), 'not json at all\n{"schema":"something-else"}\n');
      const { rounds, skipped } = readRounds({ root });
      assert.equal(rounds.length, 1);
      assert.equal(skipped, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a log that cannot be written never fails the round it describes', () => {
    const root = home();
    try {
      writeFileSync(roundLogPath(root), '');
      // A directory where the file should be: the append will throw inside.
      rmSync(roundLogPath(root)); 
      const outcome = recordRound({ repo: '/x/r', pr: { number: 1 }, ok: true }, { root: join(root, 'no', 'such', '\0bad'), now: NOW });
      assert.equal(outcome, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
