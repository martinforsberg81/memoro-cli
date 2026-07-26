/**
 * Worktree reclaim liveness: a candidate is offered only with the FULL
 * liveness picture. Cloud-visible sessions are as live as local ones —
 * gc once offered to remove the worktree of a live coordinator session
 * that was only visible via the cloud.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { staleWorktreeCandidates } from '../../src/mc/storage-management.js';
import { makeTempRepo, git, addWorktree } from './_helpers/git-fixture.js';
import { makeEntry } from './_helpers/registry-fixture.js';

describe('stale worktree candidate liveness', () => {
  let repo;
  let wtPath;
  before(() => {
    repo = makeTempRepo();
    git(repo.dir, 'branch sess/reclaimable main');
    wtPath = join(repo.mcHome, 'worktrees', 'repo', 'reclaimable');
    addWorktree(repo.dir, wtPath, 'sess/reclaimable');
  });
  after(() => repo.cleanup());

  function eligibleEntry() {
    return makeEntry({
      name: 'reclaimable',
      branch: 'sess/reclaimable',
      worktree_path: wtPath,
      session_state: 'dead',
      coding_session_id: 'sess_reclaim1',
      dirty_files: 0,
      ahead: 0,
    });
  }

  test('a clean, merged, dead worktree is a candidate when nothing reports it live', async () => {
    const res = await staleWorktreeCandidates({ entries: [eligibleEntry()] }, {
      listSessions: async () => [],
      fetchCloudActive: async () => ({ ok: true, sessions: [] }),
    });
    assert.equal(res.warning, null);
    assert.deepEqual(res.candidates.map((c) => c.name), ['reclaimable']);
  });

  test('a worktree mc never launched is not auto-reclaimed', async () => {
    // Out-of-band worktrees (created by other tooling, coding_session_id
    // null, no-session-yet) may be in use by something mc cannot see —
    // they are offered only when explicitly named.
    const entry = makeEntry({
      name: 'reclaimable',
      branch: 'sess/reclaimable',
      worktree_path: wtPath,
      session_state: 'no-session-yet',
      coding_session_id: null,
      dirty_files: 0,
      ahead: 0,
    });
    const deps = {
      listSessions: async () => [],
      fetchCloudActive: async () => ({ ok: true, sessions: [] }),
    };
    const auto = await staleWorktreeCandidates({ entries: [entry] }, deps);
    assert.deepEqual(auto.candidates, []);
    const explicit = await staleWorktreeCandidates({ entries: [entry] }, {
      ...deps,
      includeUnlaunched: true,
    });
    assert.deepEqual(explicit.candidates.map((c) => c.name), ['reclaimable']);
  });

  test('a live session in the worktree protects it even when ids are unlinked', async () => {
    const entry = makeEntry({
      name: 'reclaimable',
      branch: 'sess/reclaimable',
      worktree_path: wtPath,
      session_state: 'dead',
      coding_session_id: 'sess_old_stale_id',
      dirty_files: 0,
      ahead: 0,
    });
    const res = await staleWorktreeCandidates({ entries: [entry] }, {
      listSessions: async () => [{
        coding_session_id: 'sess_new_unlinked',
        cwd: wtPath,
      }],
      fetchCloudActive: async () => ({ ok: true, sessions: [] }),
    });
    assert.deepEqual(res.candidates, []);
  });

  test('a cloud-active session protects its worktree from reclaim', async () => {
    const res = await staleWorktreeCandidates({ entries: [eligibleEntry()] }, {
      listSessions: async () => [],
      fetchCloudActive: async () => ({
        ok: true,
        sessions: [{ coding_session_id: 'sess_reclaim1' }],
      }),
    });
    assert.equal(res.warning, null);
    assert.deepEqual(res.candidates, []);
  });

  test('a failed cloud lookup offers NO candidates and says why', async () => {
    const res = await staleWorktreeCandidates({ entries: [eligibleEntry()] }, {
      listSessions: async () => [],
      fetchCloudActive: async () => ({ ok: false, sessions: [], warning: 'offline' }),
    });
    assert.deepEqual(res.candidates, []);
    assert.match(res.warning, /incomplete liveness picture/);
    assert.match(res.warning, /offline/);
  });

  test('a failed local enumeration offers NO candidates and says why', async () => {
    const res = await staleWorktreeCandidates({ entries: [eligibleEntry()] }, {
      listSessions: async () => { throw new Error('broker unreachable'); },
      fetchCloudActive: async () => ({ ok: true, sessions: [] }),
    });
    assert.deepEqual(res.candidates, []);
    assert.match(res.warning, /broker unreachable/);
  });
});
