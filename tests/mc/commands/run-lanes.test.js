/**
 * `mc run lanes` — the verb that says the total.
 *
 * One number since 2026-11-02: how many headless sessions run at once across
 * every repository and kind. `per_repo` and `--total` are refused with what
 * replaced them, and an old setting is read into the total it allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRunArgs, run } from '../../../src/mc/commands/run.js';
import { laneCountPath, readLaneCount, writeLaneCount } from '../../../src/mc/lane-count.js';

/** `mc run lanes …` against a lanes.json of its own, with the lines it printed. */
function cli({ root = mkdtempSync(join(tmpdir(), 'mc-lanes-verb-')), currents = [] } = {}) {
  const out = [];
  const err = [];
  const deps = {
    stdout: { write: (text) => out.push(text.trimEnd()) },
    stderr: { write: (text) => err.push(text.trimEnd()) },
    readLanes: () => readLaneCount({ root, repos: 2 }),
    writeLanes: (value) => writeLaneCount(value, { root }),
    currents: () => currents,
    alive: (pid) => pid === 100,
  };
  return {
    root,
    async lanes(...argv) {
      out.length = 0;
      err.length = 0;
      const code = await run(['lanes', ...argv], deps);
      return { code, out: [...out], err: [...err] };
    },
  };
}

const session = (pid, repo = 'memoro') => ({ name: 'p', repo, pid });

test('lanes: the bare line says the total and how many are in flight across both repositories', async () => {
  const mc = cli({ currents: [session(100), session(100, 'memoro-cli'), session(999)] });
  await mc.lanes('4');
  const read = await mc.lanes();
  assert.equal(read.code, 0);
  assert.deepEqual(read.out, ['lanes 4 — 2 of 4 in flight, across every repository'], 'a dead pid is not in flight');
});

test('lanes: <n> sets the total and says a running runner takes it now', async () => {
  const mc = cli();
  const set = await mc.lanes('4');
  assert.equal(set.code, 0);
  assert.equal(set.out[0], 'lanes 4 — applies now, across every repository');
  assert.match(set.out[1], /a running runner takes it at once/u);
  assert.equal(readLaneCount({ root: mc.root }).lanes, 4);
});

test('lanes: a refused value names the form it takes and changes nothing', async () => {
  const mc = cli();
  await mc.lanes('3');
  const bad = await mc.lanes('12');
  assert.equal(bad.code, 2);
  assert.match(bad.err[0], /mc: lanes is a whole number from 1 to 8, not "12"/u);
  assert.equal(readLaneCount({ root: mc.root }).lanes, 3);
});

test('lanes: per_repo and --total are refused with a line saying what replaced them', async () => {
  const mc = cli();
  for (const argv of [['--total', '3'], ['4', '--total', 'none'], ['--total=3'], ['per_repo', '2']]) {
    const said = await mc.lanes(...argv);
    assert.equal(said.code, 2, argv.join(' '));
    assert.match(said.err[0], /mc run lanes <n> is the total number of headless sessions across every repository; per_repo and --total are gone/u, argv.join(' '));
  }
});

test('lanes: an old setting is read into the total it allowed, and the line says so once', async () => {
  const mc = cli();
  writeFileSync(laneCountPath(mc.root), JSON.stringify({ per_repo: 4, total: 4 }));
  const first = await mc.lanes();
  assert.equal(first.out[0], 'lanes 4 — 0 of 4 in flight, across every repository');
  assert.equal(first.out[1], 'read from the old setting (per_repo 4, total 4): the 4 it allowed');
  assert.deepEqual((await mc.lanes()).out, ['lanes 4 — 0 of 4 in flight, across every repository']);
});

test('parseRunArgs: `lanes` takes one number', () => {
  assert.deepEqual(parseRunArgs(['lanes']), { verb: 'lanes', count: null });
  assert.deepEqual(parseRunArgs(['lanes', '4']), { verb: 'lanes', count: '4' });
  assert.match(parseRunArgs(['lanes', '4', '5']).error, /one number/u);
  assert.match(parseRunArgs(['lanes', '--totals', '3']).error, /unknown flag/u);
});
