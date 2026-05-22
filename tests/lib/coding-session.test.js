import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  mintCodingSessionId,
  makeKey,
  sweepStale,
  lookupOrMintPure,
} from '../../src/lib/coding-session.js';

describe('mintCodingSessionId', () => {
  test('matches the server regex /^sess_[a-zA-Z0-9_-]{6,}$/', () => {
    for (let i = 0; i < 50; i++) {
      const id = mintCodingSessionId();
      assert.match(id, /^sess_[a-zA-Z0-9_-]{6,}$/, id);
    }
  });

  test('produces unique ids across calls', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(mintCodingSessionId());
    assert.equal(seen.size, 100);
  });
});

describe('makeKey', () => {
  test('combines repoIdentity, machineId, llmSessionId stably', () => {
    const k = makeKey({ repoIdentity: 'r', machineId: 'm', llmSessionId: 'l' });
    assert.equal(k, 'r::m::l');
  });
});

describe('sweepStale', () => {
  test('drops entries older than 30 days', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    const map = {
      'fresh':  { coding_session_id: 'sess_a', last_seen_at: '2026-05-30T00:00:00Z' },
      'old':    { coding_session_id: 'sess_b', last_seen_at: '2026-04-01T00:00:00Z' },
      'ancient':{ coding_session_id: 'sess_c', last_seen_at: '2025-01-01T00:00:00Z' },
    };
    const swept = sweepStale(map, now);
    assert.ok(swept.fresh);
    assert.equal(swept.old, undefined);
    assert.equal(swept.ancient, undefined);
  });

  test('keeps entries exactly at the boundary', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const map = { 'boundary': { coding_session_id: 'sess_x', last_seen_at: cutoff } };
    const swept = sweepStale(map, now);
    assert.ok(swept.boundary);
  });

  test('handles null/empty input', () => {
    assert.deepEqual(sweepStale(null), {});
    assert.deepEqual(sweepStale({}), {});
  });

  test('drops entries with malformed last_seen_at', () => {
    const map = {
      'bad': { coding_session_id: 'sess_a', last_seen_at: 'not a date' },
      'missing': { coding_session_id: 'sess_b' },
    };
    const swept = sweepStale(map, Date.now());
    assert.equal(swept.bad, undefined);
    assert.equal(swept.missing, undefined);
  });
});

describe('lookupOrMintPure', () => {
  const identity = { repoIdentity: 'r', machineId: 'm', llmSessionId: 'l' };
  const now = new Date('2026-06-01T00:00:00Z');

  test('mints a fresh id when the map has no entry', () => {
    const { codingSessionId, map, minted } = lookupOrMintPure({}, identity, now);
    assert.match(codingSessionId, /^sess_[a-zA-Z0-9_-]{6,}$/);
    assert.equal(minted, true);
    const key = makeKey(identity);
    assert.equal(map[key].coding_session_id, codingSessionId);
    assert.equal(map[key].created_at, now.toISOString());
    assert.equal(map[key].last_seen_at, now.toISOString());
  });

  test('reuses an existing id and refreshes last_seen_at', () => {
    const key = makeKey(identity);
    const initial = {
      [key]: {
        coding_session_id: 'sess_existing12',
        created_at: '2026-05-30T10:00:00Z',
        last_seen_at: '2026-05-30T10:00:00Z',
      },
    };
    const { codingSessionId, map, minted } = lookupOrMintPure(initial, identity, now);
    assert.equal(codingSessionId, 'sess_existing12');
    assert.equal(minted, false);
    assert.equal(map[key].created_at, '2026-05-30T10:00:00Z');
    assert.equal(map[key].last_seen_at, now.toISOString());
  });

  test('different llmSessionId mints a separate id (same repo, same machine)', () => {
    const a = { repoIdentity: 'r', machineId: 'm', llmSessionId: 'L_a' };
    const b = { repoIdentity: 'r', machineId: 'm', llmSessionId: 'L_b' };
    let map = {};
    ({ map } = lookupOrMintPure(map, a, now));
    const { codingSessionId: idA } = lookupOrMintPure(map, a, now);
    const r2 = lookupOrMintPure(map, b, now);
    map = r2.map;
    assert.notEqual(idA, r2.codingSessionId);
  });

  test('repo change mints a separate id within the same llm session', () => {
    const inRepoA = { repoIdentity: 'repo-A', machineId: 'm', llmSessionId: 'L' };
    const inRepoB = { repoIdentity: 'repo-B', machineId: 'm', llmSessionId: 'L' };
    let map = {};
    let r = lookupOrMintPure(map, inRepoA, now);
    map = r.map;
    const idA = r.codingSessionId;
    r = lookupOrMintPure(map, inRepoB, now);
    map = r.map;
    assert.notEqual(idA, r.codingSessionId);
  });

  test('sweeps stale entries while reading', () => {
    const oldKey = makeKey({ repoIdentity: 'old', machineId: 'm', llmSessionId: 'L' });
    const initial = {
      [oldKey]: {
        coding_session_id: 'sess_old_1234',
        created_at: '2025-01-01T00:00:00Z',
        last_seen_at: '2025-01-01T00:00:00Z',
      },
    };
    const { map } = lookupOrMintPure(initial, identity, now);
    assert.equal(map[oldKey], undefined);
  });
});
