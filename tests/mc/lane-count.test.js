import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LANES, laneCountPath, readLaneCount, writeLaneCount } from '../../src/mc/lane-count.js';

test('lanes: absent, broken or out of range reads as one; a whole number from 1 to 8 is kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-lanes-'));
  assert.deepEqual(readLaneCount({ root }), { per_repo: DEFAULT_LANES, total: null });
  assert.deepEqual(
    writeLaneCount('4', { root, now: new Date('2026-09-03T20:00:00Z') }),
    { ok: true, field: 'per_repo', count: 4, per_repo: 4, total: null },
  );
  assert.deepEqual(readLaneCount({ root }), { per_repo: 4, total: null });
  assert.deepEqual(
    JSON.parse(readFileSync(laneCountPath(root), 'utf8')),
    { per_repo: 4, total: null, set: '2026-09-03T20:00:00.000Z' },
  );
  for (const bad of ['0', '9', 'four', '2.5', '', 'none']) assert.equal(writeLaneCount(bad, { root }).ok, false, bad);
  assert.match(writeLaneCount('9', { root }).reason, /whole number from 1 to 8/u);
  assert.doesNotMatch(writeLaneCount('9', { root }).reason, /none/u, 'none is a total form, not a per-repo one');
  assert.deepEqual(readLaneCount({ root }), { per_repo: 4, total: null }, 'a refused write changes nothing');
});

test('lanes: the total is the second number in the same file, and absent means no cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-lanes-'));
  writeLaneCount('4', { root });
  assert.deepEqual(
    writeLaneCount('3', { root, field: 'total' }),
    { ok: true, field: 'total', count: 3, per_repo: 4, total: 3 },
    'setting the total leaves per_repo alone',
  );
  assert.deepEqual(readLaneCount({ root }), { per_repo: 4, total: 3 });

  writeLaneCount('2', { root });
  assert.deepEqual(readLaneCount({ root }), { per_repo: 2, total: 3 }, 'setting per_repo leaves the total alone');

  for (const bad of ['0', '9', 'three', '2.5', '']) {
    const set = writeLaneCount(bad, { root, field: 'total' });
    assert.equal(set.ok, false, bad);
    assert.match(set.reason, /--total is a whole number from 1 to 8, or none for no cap/u, bad);
  }
  assert.deepEqual(readLaneCount({ root }), { per_repo: 2, total: 3 }, 'a refused write changes nothing');

  assert.deepEqual(
    writeLaneCount('None', { root, field: 'total' }),
    { ok: true, field: 'total', count: null, per_repo: 2, total: null },
    'none says no cap, in any case',
  );
  assert.deepEqual(readLaneCount({ root }), { per_repo: 2, total: null });
});

test('lanes: one bad number in the file does not cost the other', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-lanes-'));
  const write = (raw) => writeFileSync(laneCountPath(root), raw);

  write(JSON.stringify({ per_repo: 99, total: 3 }));
  assert.deepEqual(readLaneCount({ root }), { per_repo: DEFAULT_LANES, total: 3 });

  write(JSON.stringify({ per_repo: 4, total: 'lots' }));
  assert.deepEqual(readLaneCount({ root }), { per_repo: 4, total: null }, 'a nonsense total is no cap, not a wall');

  write('{ not json');
  assert.deepEqual(readLaneCount({ root }), { per_repo: DEFAULT_LANES, total: null });

  write(JSON.stringify({ per_repo: 4, total: 'lots' }));
  assert.deepEqual(
    writeLaneCount('3', { root, field: 'total' }),
    { ok: true, field: 'total', count: 3, per_repo: 4, total: 3 },
    'a merge writes what the file reads as, so a bad number is repaired rather than carried',
  );
});
