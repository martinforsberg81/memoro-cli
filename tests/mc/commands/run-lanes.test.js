/**
 * `mc run lanes` — the verb that says both numbers.
 *
 * The line is the deliverable, not the plumbing: the old one (`lanes 3 — 3
 * steps in flight per repository`) was true and gave the wrong picture,
 * because it never said there were two repositories and so never said the
 * machine was running six. These tests hold the new line to saying both
 * numbers, what they come to together, and what is actually running.
 *
 * The file is real — `writeLaneCount` merges into a temp root — so a write
 * that clobbered the other number would fail here rather than in a unit test
 * of the writer alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRunArgs, run } from '../../../src/mc/commands/run.js';
import { readLaneCount, writeLaneCount } from '../../../src/mc/lane-count.js';

/** `mc run lanes …` against a lanes.json of its own, with the lines it printed. */
function cli({ root = mkdtempSync(join(tmpdir(), 'mc-lanes-verb-')), currents = [], repos = ['memoro', 'memoro-cli'] } = {}) {
  const out = [];
  const err = [];
  const deps = {
    stdout: { write: (text) => out.push(text.trimEnd()) },
    stderr: { write: (text) => err.push(text.trimEnd()) },
    readLanes: () => readLaneCount({ root }),
    writeLanes: (value, opts = {}) => writeLaneCount(value, { ...opts, root }),
    currents: () => currents,
    alive: (pid) => pid === 100,
    repos,
  };
  return {
    root,
    out,
    err,
    async lanes(...argv) {
      out.length = 0;
      err.length = 0;
      const code = await run(['lanes', ...argv], deps);
      return { code, out: [...out], err: [...err] };
    },
  };
}

const step = (pid) => ({ name: 'p', repo: 'memoro', pid });

test('lanes: the bare line says both numbers and what is in flight', async () => {
  const mc = cli({ currents: [step(100), step(100)] });
  await mc.lanes('3');
  await mc.lanes('--total', '3');

  const read = await mc.lanes();
  assert.deepEqual(read.out, ['lanes 3 per repository, 3 in total — 2 in flight']);
  assert.equal(read.code, 0);
});

test('lanes: no total is said, with what it comes to, rather than left out', async () => {
  // `3 per repository` alone cannot be told apart from a total that happens to
  // be 3 — and the number it leaves unsaid, six, is the whole reason for this.
  const mc = cli();
  await mc.lanes('3');

  const read = await mc.lanes();
  assert.deepEqual(read.out, ['lanes 3 per repository, no total cap (up to 6 across 2 repositories) — 0 in flight']);
});

test('lanes: a current file naming a dead pid is not a step in flight', async () => {
  // A killed runner leaves its current files behind; the page reads them the
  // same way (`nowBlock`), so the two cannot disagree about what is running.
  const mc = cli({ currents: [step(100), step(999)] });
  const read = await mc.lanes();
  assert.match(read.out[0], / 1 in flight$/u);
});

test('lanes: the positional sets per_repo and --total sets the total, neither touching the other', async () => {
  const mc = cli();

  const per = await mc.lanes('4');
  assert.equal(per.code, 0);
  assert.equal(per.out[0], 'lanes 4 per repository, no total cap (up to 8 across 2 repositories) from the next start');
  assert.match(per.out.at(-1), /mc run --update takes the new ones after the round it is in/u);
  assert.deepEqual(readLaneCount({ root: mc.root }), { per_repo: 4, total: null });

  const total = await mc.lanes('--total', '3');
  assert.equal(total.out[0], 'lanes 4 per repository, 3 in total from the next start');
  assert.deepEqual(readLaneCount({ root: mc.root }), { per_repo: 4, total: 3 }, 'the total left per_repo alone');

  const both = await mc.lanes('2', '--total', '3');
  assert.equal(both.out[0], 'lanes 2 per repository, 3 in total from the next start');
  assert.deepEqual(readLaneCount({ root: mc.root }), { per_repo: 2, total: 3 });

  const none = await mc.lanes('--total', 'none');
  assert.equal(none.out[0], 'lanes 2 per repository, no total cap (up to 4 across 2 repositories) from the next start');
  assert.deepEqual(readLaneCount({ root: mc.root }), { per_repo: 2, total: null });
});

test('lanes: a refused value names the forms it takes, and changes nothing', async () => {
  const mc = cli();
  await mc.lanes('3');

  const bad = await mc.lanes('--total', '12');
  assert.equal(bad.code, 2);
  assert.deepEqual(bad.out, [], 'a refusal is not a report of what was set');
  assert.match(bad.err[0], /mc: lanes --total is a whole number from 1 to 8, or none for no cap, not "12"/u);
  assert.deepEqual(readLaneCount({ root: mc.root }), { per_repo: 3, total: null });

  assert.match((await mc.lanes('none')).err[0], /lanes is a whole number from 1 to 8, not "none"/u, 'none is a total form');
});

test('lanes: a refused total does not land the per_repo typed beside it', async () => {
  // Half of what was asked for, with no line saying which half, is the failure
  // this refuses: both values are checked before either is written.
  const mc = cli();
  await mc.lanes('2');

  const bad = await mc.lanes('4', '--total', '12');
  assert.equal(bad.code, 2);
  assert.deepEqual(readLaneCount({ root: mc.root }), { per_repo: 2, total: null }, 'the 4 was not written either');
});

test('lanes: a total no repository can reach is said to be a no-op', async () => {
  const mc = cli();
  await mc.lanes('2');

  const set = await mc.lanes('--total', '4');
  assert.equal(set.out[1], 'that total never binds: 2 per repository across 2 repositories is at most 4');

  const read = await mc.lanes();
  assert.equal(read.out[0], 'lanes 2 per repository, 4 in total — 0 in flight');
  assert.equal(read.out[1], 'that total never binds: 2 per repository across 2 repositories is at most 4');

  const binds = await mc.lanes('--total', '3');
  assert.equal(binds.out.length, 2, 'a total of 3 under 2×2 binds, so there is nothing to warn about');
});

test('parseRunArgs: `lanes` takes one number, --total, or both', () => {
  assert.deepEqual(parseRunArgs(['lanes']), { verb: 'lanes', count: null, total: null });
  assert.deepEqual(parseRunArgs(['lanes', '4']), { verb: 'lanes', count: '4', total: null });
  assert.deepEqual(parseRunArgs(['lanes', '--total', '3']), { verb: 'lanes', count: null, total: '3' });
  assert.deepEqual(parseRunArgs(['lanes', '4', '--total', 'none']), { verb: 'lanes', count: '4', total: 'none' });
  assert.match(parseRunArgs(['lanes', '4', '5']).error, /one number/u);
  assert.match(parseRunArgs(['lanes', '--total']).error, /--total needs a value/u);
  assert.match(parseRunArgs(['lanes', '--totals', '3']).error, /unknown flag/u);
});
