import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LANES, laneCountPath, migratedLanes, readLaneCount, writeLaneCount } from '../../src/mc/lane-count.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'mc-lanes-'));

test('lanes: absent, broken or out of range reads as the default; a whole number from 1 to 8 is kept', () => {
  const root = fresh();
  assert.deepEqual(readLaneCount({ root }), { lanes: DEFAULT_LANES, migrated: null });
  assert.equal(DEFAULT_LANES, 2, 'what no file allowed before: one lane on each of two repositories');
  assert.deepEqual(writeLaneCount('4', { root, now: new Date('2026-11-02T20:00:00Z') }), { ok: true, lanes: 4 });
  assert.deepEqual(readLaneCount({ root }), { lanes: 4, migrated: null });
  assert.deepEqual(JSON.parse(readFileSync(laneCountPath(root), 'utf8')), { lanes: 4, set: '2026-11-02T20:00:00.000Z' });
  for (const bad of ['0', '9', 'four', '2.5', '', 'none']) assert.equal(writeLaneCount(bad, { root }).ok, false, bad);
  assert.match(writeLaneCount('9', { root }).reason, /lanes is a whole number from 1 to 8, not "9"/u);
  assert.deepEqual(readLaneCount({ root }), { lanes: 4, migrated: null }, 'a refused write changes nothing');
  writeFileSync(laneCountPath(root), '{ not json');
  assert.equal(readLaneCount({ root }).lanes, DEFAULT_LANES);
});

test('lanes: an old per_repo and total is read once into the total it allowed', () => {
  assert.equal(migratedLanes({ per_repo: 4, total: 4 }, 2), 4, 'the total bound');
  assert.equal(migratedLanes({ per_repo: 2, total: null }, 2), 4, 'no total: per_repo on each repository');
  assert.equal(migratedLanes({ per_repo: 3, total: 5 }, 2), 5);
  assert.equal(migratedLanes({ per_repo: 1, total: 6 }, 2), 2, 'a total that never bound');
  assert.equal(migratedLanes({ per_repo: 8, total: null }, 2), 8, 'never above eight');
  assert.equal(migratedLanes({ per_repo: 99, total: 3 }, 2), 2, 'a nonsense per_repo is one per repository');
  assert.equal(migratedLanes({ lanes: 3 }, 2), null, 'the new shape is not old');

  const root = fresh();
  writeFileSync(laneCountPath(root), JSON.stringify({ per_repo: 2, total: 3, set: '2026-11-02T09:29:28.288Z' }));
  assert.deepEqual(readLaneCount({ root, repos: 2 }), { lanes: 3, migrated: { per_repo: 2, total: 3 } });
  const written = JSON.parse(readFileSync(laneCountPath(root), 'utf8'));
  assert.equal(written.lanes, 3);
  assert.equal('per_repo' in written, false, 'the old fields are not left to be read again');
  assert.deepEqual(readLaneCount({ root, repos: 2 }), { lanes: 3, migrated: null }, 'read once');
});
