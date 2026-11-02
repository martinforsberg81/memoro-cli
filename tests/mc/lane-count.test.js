import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LANES, LANES_MAX, laneCountPath, legacyFields, migratedLanes, readLaneCount, writeLaneCount } from '../../src/mc/lane-count.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'mc-lanes-'));

test('lanes: absent, broken or out of range reads as the default; a whole number from 1 to 16 is kept', () => {
  const root = fresh();
  assert.deepEqual(readLaneCount({ root }), { lanes: DEFAULT_LANES, migrated: null });
  assert.equal(DEFAULT_LANES, 2, 'what no file allowed before: one lane on each of two repositories');
  assert.deepEqual(writeLaneCount('4', { root, now: new Date('2026-11-02T20:00:00Z') }), { ok: true, lanes: 4 });
  assert.deepEqual(readLaneCount({ root }), { lanes: 4, migrated: null });
  assert.deepEqual(JSON.parse(readFileSync(laneCountPath(root), 'utf8')), { lanes: 4, per_repo: 4, total: 4, set: '2026-11-02T20:00:00.000Z' });
  assert.equal(LANES_MAX, 16);
  assert.deepEqual(writeLaneCount('16', { root }), { ok: true, lanes: 16 });
  for (const bad of ['0', '17', 'four', '2.5', '', 'none']) assert.equal(writeLaneCount(bad, { root }).ok, false, bad);
  assert.match(writeLaneCount('17', { root }).reason, /lanes is a whole number from 1 to 16, not "17"/u);
  writeLaneCount('4', { root });
  assert.deepEqual(readLaneCount({ root }), { lanes: 4, migrated: null }, 'a refused write changes nothing');
  writeFileSync(laneCountPath(root), '{ not json');
  assert.equal(readLaneCount({ root }).lanes, DEFAULT_LANES);
});

test('lanes: an old per_repo and total is read once into the total it allowed', () => {
  assert.equal(migratedLanes({ per_repo: 4, total: 4 }, 2), 4, 'the total bound');
  assert.equal(migratedLanes({ per_repo: 2, total: null }, 2), 4, 'no total: per_repo on each repository');
  assert.equal(migratedLanes({ per_repo: 3, total: 5 }, 2), 5);
  assert.equal(migratedLanes({ per_repo: 1, total: 6 }, 2), 2, 'a total that never bound');
  assert.equal(migratedLanes({ per_repo: 8, total: null }, 2), 16, 'uncapped eight on each of two repositories ran sixteen, and keeps them');
  assert.equal(migratedLanes({ per_repo: 6 }, 2), 12, 'an absent total is no cap, above eight too');
  assert.equal(migratedLanes({ per_repo: 99, total: 3 }, 2), 2, 'a nonsense per_repo is one per repository');
  assert.equal(migratedLanes({ per_repo: 4, total: 12 }, 2), 8, 'a total the old reader refused (above 8) was no cap');
  assert.equal(migratedLanes({ lanes: 3 }, 2), null, 'the new shape is not old');

  const root = fresh();
  writeFileSync(laneCountPath(root), JSON.stringify({ per_repo: 2, total: 3, set: '2026-11-02T09:29:28.288Z' }));
  assert.deepEqual(readLaneCount({ root, repos: 2 }), { lanes: 3, migrated: { per_repo: 2, total: 3 } });
  const written = JSON.parse(readFileSync(laneCountPath(root), 'utf8'));
  assert.equal(written.lanes, 3);
  assert.deepEqual([written.per_repo, written.total], [3, 3], 'the pair an older runner reads as the same three');
  assert.deepEqual(readLaneCount({ root, repos: 2 }), { lanes: 3, migrated: null }, 'read once: lanes wins over the pair');

  const wide = fresh();
  writeFileSync(laneCountPath(wide), JSON.stringify({ per_repo: 8 }));
  assert.equal(readLaneCount({ root: wide, repos: 2 }).lanes, 16);
  assert.equal(JSON.parse(readFileSync(laneCountPath(wide), 'utf8')).lanes, 16, 'written back as sixteen');
});

/** What a runner older than the total did with the pair (9df9eb5e's lane-count.js and its cap). */
function oldReader(raw, repos = 2) {
  const range = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 8 ? n : null; };
  const per = range(raw?.per_repo) ?? 1;
  const total = range(raw?.total);
  return total === null ? per * repos : Math.min(per * repos, total);
}

test('lanes: every write keeps a pair an older runner reads as the same total, up to 8 exactly', () => {
  for (let n = 1; n <= LANES_MAX; n += 1) {
    const root = fresh();
    writeLaneCount(String(n), { root });
    const raw = JSON.parse(readFileSync(laneCountPath(root), 'utf8'));
    assert.equal(raw.lanes, n);
    if (n <= 8) assert.equal(oldReader(raw), n, `lanes ${n}`);
    else assert.equal(oldReader(raw), 16, `lanes ${n}: the old reader has no total above 8, so it runs its widest`);
    assert.deepEqual(legacyFields(n), { per_repo: raw.per_repo, total: raw.total });
  }
  // The shape that dropped the old runner to one lane per repository on 2026-11-02.
  assert.equal(oldReader({ lanes: 4 }), 2);
});

test('lanes: under MC_HOME the file read and migrated is that home\'s, and the home directory\'s copy is untouched', () => {
  const saved = { MC_HOME: process.env.MC_HOME, HOME: process.env.HOME };
  const home = fresh();
  const real = join(home, '.memoro', 'mc');
  mkdirSync(real, { recursive: true });
  const before = JSON.stringify({ per_repo: 1, set: '2026-11-01T00:00:00Z' });
  writeFileSync(join(real, 'lanes.json'), before);
  const isolated = fresh();
  writeFileSync(join(isolated, 'lanes.json'), JSON.stringify({ per_repo: 2, total: 3 }));
  try {
    process.env.HOME = home;
    process.env.MC_HOME = isolated;
    assert.equal(readLaneCount().lanes, 3, 'the isolated copy, migrated');
    assert.equal(writeLaneCount('5').lanes, 5);
    assert.equal(JSON.parse(readFileSync(join(isolated, 'lanes.json'), 'utf8')).lanes, 5);
    assert.equal(readFileSync(join(real, 'lanes.json'), 'utf8'), before, 'the home directory\'s lanes.json is byte for byte what it was');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
