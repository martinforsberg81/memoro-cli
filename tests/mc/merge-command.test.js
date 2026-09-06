/**
 * `mc merge <repo> <pr>` — what becomes of a round that did not land.
 *
 * The round itself is `tests/mc/repo-merge.test.js`; this drives the verb over
 * a fake one, because what is asserted here is the half the round knows
 * nothing about: a refusal the runner's merge lane can act on is written to
 * `~/mc/runner/merges.json` and said in one line, and a machine with no runner
 * on it is left exactly as it was — the whole point of the queue is that
 * nobody has to type the command again, and a queue nothing drains would be a
 * promise mc could not keep.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { gate } from '../../src/mc/commands/repo.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';

let root = null;
let home = null;
let priorHome = null;

/** A round that stopped, in the shape `runMergeRound` returns one. */
function stopped(stoppedAt, reason) {
  return {
    repo: '/repos/memoro-cli',
    pr: { number: 671, base: 'main' },
    batch: null,
    ok: false,
    merged: false,
    merge_commit: null,
    merged_into: null,
    stopped_at: stoppedAt,
    reason,
    gate: {
      ok: false,
      stopped_at: stoppedAt,
      reason,
      pr: { number: 671, head: 'merge-queue', base: 'main' },
      candidate: { red: [], totals: { tests: 10 } },
      extra_gates: [],
    },
    deploy: null,
  };
}

function landed() {
  return {
    ...stopped(null, null),
    ok: true,
    merged: true,
    merge_commit: 'abc1234def',
    merged_into: 'main',
    default_branch: 'main',
    off_default: false,
    gate: { ...stopped(null, null).gate, ok: true, stopped_at: null, reason: null },
  };
}

/** Everything `gate` would otherwise reach the machine through. */
function deps(report, { runner = 'alive' } = {}) {
  const out = { out: '', err: '' };
  if (runner !== 'none') {
    // A live pid is this process's own; a dead one is a runner that was killed
    // and left its file behind, which `readRunner` answers as not alive.
    const pid = runner === 'alive' ? process.pid : 2 ** 22 - 1;
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(join(root, 'runner', 'runner.json'), JSON.stringify({ pid, started: '2026-09-06T12:00:00Z' }));
  }
  return {
    out,
    io: {
      stdout: { write: (text) => { out.out += text; } },
      stderr: { write: (text) => { out.err += text; } },
      root,
      resolveRepo: async () => '/repos/memoro-cli',
      mergeRound: async () => report,
      now: () => new Date('2026-09-06T18:00:00Z'),
    },
  };
}

const queue = () => parseQueue(existsSync(mergesPath(root)) ? readFileSync(mergesPath(root), 'utf8') : null);

describe('a refused mc merge is queued for the runner', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-merge-queue-'));
    home = mkdtempSync(join(tmpdir(), 'mc-merge-home-'));
    priorHome = process.env.MC_HOME;
    process.env.MC_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('writes one entry, says so in one line, and exits 0 — the merge is somebody\'s now', async () => {
    const { out, io } = deps(stopped('busy', 'another gate round is running'), {});
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0, 'the caller asked for a merge and the merge is now the lane\'s');
    const entries = queue();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      repo: 'memoro-cli',
      pr: 671,
      branch: 'merge-queue',
      reason: 'another gate round is running',
      stopped_at: 'busy',
      since: '2026-09-06T18:00:00Z',
      holder: entries[0].holder,
    });
    assert.match(out.out, /^mc: queued — the runner's merge lane lands #671, or holds it after one repair \(mc shows the queue\)$/mu);
    assert.equal(out.out.split('\n').filter((line) => line.startsWith('mc: queued')).length, 1, 'one line, not two');
    assert.equal(out.err, '', 'a queued refusal has nothing to warn about');
  });

  it('queues a red round too — that is what the one repair is for', async () => {
    const { io } = deps(stopped('red', '1 test red: new thing › broke'));
    await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.deepEqual(queue().map((entry) => entry.stopped_at), ['red']);
  });

  it('does not queue what nothing on this machine can land', async () => {
    const { out, io } = deps(stopped('pr', 'gh could not read the pull request'));
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 1);
    assert.deepEqual(queue(), [], 'a pull request the round could not name is not the lane\'s');
    assert.doesNotMatch(out.out, /queued/u);
    assert.equal(out.err, '', 'nothing was refused that a runner could have taken');
  });

  it('a landed round touches no queue and says nothing new', async () => {
    const { out, io } = deps(landed());
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0);
    assert.equal(existsSync(mergesPath(root)), false, 'the file is not even made');
    assert.doesNotMatch(out.out, /queued/u);
  });

  it('with no runner the command is what it was, plus one line on stderr', async () => {
    const { out, io } = deps(stopped('busy', 'another gate round is running'), { runner: 'none' });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 1, 'nothing will pick this up, so the refusal is still the caller\'s');
    assert.equal(existsSync(mergesPath(root)), false, 'the queue file is untouched');
    assert.doesNotMatch(out.out, /queued/u, 'stdout is byte-for-byte the round\'s own lines');
    assert.match(out.out, /^mc: nothing was merged$/mu);
    assert.equal(out.err, 'mc: no runner is running to take the refusal — start one, or run this again\n');
  });

  it('a runner.json naming a dead pid is no runner at all', async () => {
    const { out, io } = deps(stopped('busy', 'another gate round is running'), { runner: 'dead' });
    await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(existsSync(mergesPath(root)), false);
    assert.match(out.err, /no runner is running/u);
  });

  it('--json carries queued: true and the entry', async () => {
    const { out, io } = deps(stopped('lease', 'memoro-cli is held by mc-run'));
    const code = await gate({ repo: 'memoro-cli', pr: 671, json: true }, io);
    assert.equal(code, 0);
    const report = JSON.parse(out.out);
    assert.equal(report.queued, true);
    assert.equal(report.queue_entry.pr, 671);
    assert.equal(report.queue_entry.stopped_at, 'lease');
    assert.equal(report.stopped_at, 'lease', 'the round\'s own report is unchanged under it');
  });
});
