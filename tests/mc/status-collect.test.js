/**
 * The readers behind the page — each block built from fixture data, with no
 * git, no gh and no tmux. The five sections themselves are page.test.js and
 * the surfaces are front-door.test.js; this is the shared half underneath.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRuns } from '../../src/mc/brief-collect.js';
import { estimateCost, priceFor } from '../../src/mc/prices.js';
import { nowBlock, pidAlive } from '../../src/mc/status-collect.js';

const TSV = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-25T18:00:00Z\tdocx-editor\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '2026-08-25T19:00:00Z\tavatar-image-animation\tstep\t0\t652\t10964\t56\t96\t33172\t4724690\t118362\ts3\tsuccess,merged',
  '2026-08-25T19:30:00Z\tfocused-session-ui\ttriage\t142\t5400\t-\t-\t-\t-\t-\t-\t-\ttimeout',
].join('\n');
const ROWS = parseRuns(TSV).filter((row) => Date.parse(row.ts) >= Date.parse('2026-08-25T00:00:00Z'));

describe('COST', () => {
  it('prices by family, and says n/a for a model it does not know', () => {
    assert.deepEqual(priceFor('opus'), { input: 5, output: 25 });
    assert.deepEqual(priceFor('claude-fable-5'), { input: 10, output: 50 });
    assert.equal(estimateCost({ input: 1e6 }, 'gemini'), null);
    assert.equal(estimateCost({ cacheRead: 1e6 }, 'opus'), 0.5);
  });
});

describe('NOW', () => {
  const NOW = new Date('2026-08-29T10:30:00Z');
  const RUNNER = { pid: 4242, started: '2026-08-29T08:30:00Z' };
  const CURRENT = {
    name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: 0,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
  };
  const OTHER = {
    name: 'docx-editor', kind: 'step', repo: 'memoro', tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: 0,
    started: '2026-08-29T10:20:00Z', pid: 4243, worktree: '/w/docx-editor/memoro',
  };
  const live = () => true;
  const dead = () => false;

  it('names the step in flight with its elapsed time and its check-ins', () => {
    const block = nowBlock({ runner: RUNNER, currents: [CURRENT], rows: ROWS, now: NOW, alive: live });
    assert.deepEqual(block.runner, { pid: 4242, started: '2026-08-29T08:30:00Z', alive: true, up_seconds: 7200 });
    assert.equal(block.steps.length, 1);
    assert.equal(block.steps[0].name, 'mc-ui');
    // A lane file from before says `step`, and is read as a project's build.
    assert.deepEqual([block.steps[0].kind, block.steps[0].variant, block.steps[0].goal], ['build', 'project', null]);
    assert.equal(block.steps[0].tool, 'claude');
    assert.equal(block.steps[0].repo, 'memoro-cli');
    assert.equal(block.steps[0].elapsed_seconds, 1800);
    assert.equal(block.steps[0].check_in_seconds, 3600);
    assert.equal(block.steps[0].check_ins, 0);
    assert.equal('over_budget' in block.steps[0], false, 'nothing is over a budget that is gone (ruling 18)');
    assert.deepEqual(block.stale, []);
    assert.equal(block.stop, false);
  });

  // One lane per repository, so there is one `current-<repo>.json` per lane
  // and NOW names every one of them — the file that says what is running is
  // no longer a single file.
  it('names every lane that has a step in flight', () => {
    const block = nowBlock({ runner: RUNNER, currents: [CURRENT, OTHER], now: NOW, alive: live });
    assert.deepEqual(block.steps.map((step) => [step.name, step.repo]), [
      ['docx-editor', 'memoro'], ['mc-ui', 'memoro-cli'],
    ]);
    assert.deepEqual(block.steps.map((step) => step.elapsed_seconds), [600, 1800]);
    assert.deepEqual(block.stale, []);
  });

  it('is empty when no runner has written a file, and counts the check-ins a long step has had', () => {
    const empty = nowBlock({ now: NOW, alive: live });
    assert.equal(empty.runner, null);
    assert.deepEqual(empty.steps, []);
    assert.deepEqual(empty.quota, { count: 0, last: null });
    const late = nowBlock({ currents: [{ ...CURRENT, started: '2026-08-29T08:00:00Z', check_ins: 2 }], now: NOW, alive: live });
    assert.deepEqual([late.steps[0].elapsed_seconds, late.steps[0].check_ins], [9000, 2]);
    // codex has no check-in, and a file written before them has no count.
    const codex = nowBlock({ currents: [{ ...CURRENT, tool: 'codex', check_in_minutes: null, check_ins: 0 }], now: NOW, alive: live });
    assert.deepEqual([codex.steps[0].check_in_seconds, codex.steps[0].check_ins], [null, null]);
    const older = nowBlock({ currents: [{ ...CURRENT, check_ins: undefined }], now: NOW, alive: live });
    assert.equal(older.steps[0].check_ins, 0);
  });

  it('a file whose pid is gone is stale, not running — and it says which lane', () => {
    const block = nowBlock({ runner: RUNNER, currents: [CURRENT, OTHER], now: NOW, alive: dead });
    assert.equal(block.runner.alive, false);
    assert.deepEqual(block.steps, []);
    assert.deepEqual(block.stale, [
      'runner.json (pid 4242 is gone)',
      'current-memoro-cli.json (pid 4242 is gone)',
      'current-memoro.json (pid 4243 is gone)',
    ]);
  });

  it('carries a pending STOP and the quota answers of the last 24 h', () => {
    const rows = parseRuns([
      'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
      '2026-08-29T04:00:00Z\tmc-ui\tstep\t1\t8\t-\t1\t-\t-\t-\t-\t-\tquota',
      '2026-08-29T05:00:00Z\tmc-ui\tstep\t0\t600\t9\t9\t-\t-\t-\t-\t-\tsuccess,merged',
    ].join('\n'));
    const block = nowBlock({ runner: RUNNER, stop: true, rows, now: NOW, alive: live });
    assert.equal(block.stop, true);
    assert.deepEqual(block.quota, { count: 1, last: '2026-08-29T04:00:00Z' });
  });

  // `disk.json` and `memory.json` as the caller read them: the runner's holds
  // on new starts, each with the line it said; no file, or no line, is null.
  it('carries the disk and the memory hold from the files the runner left', () => {
    const disk = { at: '2026-08-29T10:40:00Z', free_bytes: 118 * 2 ** 20, line: 'disk: 0.1 GiB free, below 5 GiB — no step started' };
    const memory = { at: '2026-08-29T10:45:00Z', free_percent: 12, line: 'memory: 12% free, below 20% — no step started' };
    const held = nowBlock({ runner: RUNNER, disk, memory, now: NOW, alive: live });
    assert.deepEqual(held.disk, disk);
    assert.deepEqual(held.memory, memory);
    const free = nowBlock({ runner: RUNNER, now: NOW, alive: live });
    assert.equal(free.disk, null);
    assert.equal(free.memory, null);
    assert.equal(nowBlock({ runner: RUNNER, memory: {}, now: NOW, alive: live }).memory, null);
  });

  it('liveness is this process by pid, and nothing for a pid that cannot exist', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(null), false);
    assert.equal(pidAlive('nope'), false);
  });
});
