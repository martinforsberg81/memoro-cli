import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LANES, laneCountPath, readLaneCount, writeLaneCount } from '../../src/mc/lane-count.js';

test('lanes: absent, broken or out of range reads as one; a whole number from 1 to 8 is kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-lanes-'));
  assert.equal(readLaneCount({ root }), DEFAULT_LANES);
  assert.deepEqual(writeLaneCount('4', { root, now: new Date('2026-09-03T20:00:00Z') }), { ok: true, count: 4 });
  assert.equal(readLaneCount({ root }), 4);
  assert.deepEqual(JSON.parse(readFileSync(laneCountPath(root), 'utf8')), { per_repo: 4, set: '2026-09-03T20:00:00.000Z' });
  for (const bad of ['0', '9', 'four', '2.5', '']) assert.equal(writeLaneCount(bad, { root }).ok, false, bad);
  assert.equal(readLaneCount({ root }), 4, 'a refused write changes nothing');
});
