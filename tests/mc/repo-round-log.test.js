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
  countRounds, readRounds, recordRound, recordRoundStart, roundLogPath, unfinishedRounds,
} from '../../src/mc/repo-round-log.js';
import { resetRunId } from '../../src/mc/logger.js';

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
        gate: { timings: {}, standing_red: 55, broke: ['a', 'b'], fixed: [], ratchet: { baseline_risen: ['flaky-one', 'flaky-two'] } },
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
      // The delta by NAME: the two names that flapped 55 → 57 → 55 could
      // not be pointed at afterwards, because every log carried only
      // numbers. The next one names itself.
      assert.deepEqual(rounds[1].broke_names, ['a', 'b']);
      assert.equal(rounds[2].duration_ms, 900, 'the cost of a refusal is a fact too');

      assert.deepEqual(rounds[1].baseline_unstable, ['flaky-one', 'flaky-two'], 'an unstable baseline is in the line by name');
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

/**
 * The round that never reached its own end.
 *
 * The file above promises a line for every round, "merged, stopped, refused
 * the lease, cut short" — and it kept that promise for every round that
 * finished. On 2026-08-30 two merge rounds were killed from outside, the
 * first after #11082 had already landed and before #11085 was reached, and
 * neither wrote anything at all. What was left was a lease claimed at 09:48,
 * a reap at 10:01 saying pid 175 was gone, and a round log with nothing in
 * it — the meter built to answer "did the gate ever catch anything?" silent
 * about the two rounds of that day that went wrong.
 *
 * SIGKILL runs no handler, so there is no line the dying process could have
 * written. The only shape that catches it is a line written BEFORE the work
 * and a reader that notices the missing partner.
 */
describe('a round that was killed is still a fact', () => {
  it('announces itself before doing any work, carrying its pid and run', () => {
    const root = home();
    try {
      const line = recordRoundStart(
        { repo: '/x/memoro', mode: 'merge', prs: [11082, 11085], holder: 'icon-assets' },
        { root, now: NOW },
      );
      assert.equal(line.phase, 'start');
      assert.equal(line.repo, 'memoro');
      assert.deepEqual(line.prs, [11082, 11085]);
      assert.equal(line.holder, 'icon-assets');
      assert.equal(line.pid, process.pid);
      assert.match(line.run, /^run_/u);
      const { rounds } = readRounds({ root });
      assert.equal(rounds.length, 1, 'the start is on disk before anything else happens');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a start with no end and a dead pid is a round that died', () => {
    const root = home();
    try {
      resetRunId();
      recordRoundStart({ repo: '/x/memoro', mode: 'merge', prs: [11082, 11085] }, { root, now: NOW });
      const { rounds } = readRounds({ root });
      // Nothing else was written: this is the killed round, exactly as it
      // appears on disk afterwards.
      const open = unfinishedRounds(rounds, { alive: () => false });
      assert.equal(open.length, 1);
      assert.equal(open[0].verdict, 'died');
      assert.deepEqual(open[0].prs, [11082, 11085]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a start with no end and a live pid is a round still running — never called dead', () => {
    const root = home();
    try {
      resetRunId();
      recordRoundStart({ repo: '/x/memoro', mode: 'merge', prs: [11090] }, { root, now: NOW });
      const { rounds } = readRounds({ root });
      const open = unfinishedRounds(rounds, { alive: () => true });
      assert.equal(open[0].verdict, 'running');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a round that ended is not open, however long it took', () => {
    const root = home();
    try {
      resetRunId();
      recordRoundStart({ repo: '/x/memoro', mode: 'merge', prs: [11090] }, { root, now: NOW });
      recordRound({ repo: '/x/memoro', pr: { number: 11090 }, ok: true, merged: true }, { root, now: NOW });
      const { rounds } = readRounds({ root });
      assert.equal(rounds.length, 2);
      assert.equal(rounds[1].phase, 'end');
      assert.deepEqual(unfinishedRounds(rounds, { alive: () => false }), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lines written before the start/end pair existed are ends, not deaths', () => {
    const root = home();
    try {
      // A line from the old schema: no `phase`, no `run`, no `pid`. Reading it
      // as an unfinished round would report every historical round as dead.
      appendFileSync(roundLogPath(root), `${JSON.stringify({
        schema: 'mc-gate-round', version: 1, at: '2026-08-24T10:00:00.000Z',
        repo: 'memoro', mode: 'merge', prs: [400], ok: true, merged: [400], stopped_at: null,
      })}\n`);
      const { rounds } = readRounds({ root });
      assert.deepEqual(unfinishedRounds(rounds, { alive: () => false }), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
