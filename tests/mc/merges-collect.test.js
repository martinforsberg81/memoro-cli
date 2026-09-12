/**
 * `runningMerge` — the lock and the lease, joined into one sentence.
 *
 * Lives beside `merges-collect.js` rather than inside `gate-lock.test.js`:
 * the gate lock's own test file pins its export list as "the whole surface is
 * the round and its phase", and a function that also reads the lease and a
 * list of repositories is not that surface.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { takeGateLock } from '../../src/mc/gate-lock.js';
import { runningMerge } from '../../src/mc/merges-collect.js';
import { claimLease } from '../../src/mc/repo-lease.js';
import { repoFileSlug } from '../../src/mc/repo-snapshot.js';

const home = () => mkdtempSync(join(tmpdir(), 'mc-merges-collect-'));
const ALIVE = () => true;

describe('the running round, as a sentence', () => {
  it('nothing running is null', () => {
    const root = home();
    try {
      assert.equal(runningMerge({ root, repos: [] }), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('names the repository from the list, not the slug the lock holds', () => {
    const root = home();
    try {
      const repoPath = '/work/memoro-cli';
      takeGateLock({ repo: repoFileSlug(repoPath), pr: 485, mode: 'check', root });
      const running = runningMerge({ root, repos: [{ name: 'memoro-cli', path: repoPath }] });
      assert.equal(running.repo, 'memoro-cli');
      assert.equal(running.pr, 485);
      assert.equal(running.mode, 'check');
      assert.equal(running.pid, process.pid);
      assert.ok(Number.isFinite(running.age_seconds));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a slug matching nothing in the list falls back to the slug itself', () => {
    const root = home();
    try {
      takeGateLock({ repo: 'unknown-deadbeef', pr: 1, root });
      const running = runningMerge({ root, repos: [{ name: 'memoro', path: '/work/memoro' }] });
      assert.equal(running.repo, 'unknown-deadbeef');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('carries the phase once the round has said one', () => {
    const root = home();
    try {
      const repoPath = '/work/memoro';
      writeFileSync(join(root, 'gate-running.json'), JSON.stringify({
        pid: process.pid, repo: 'memoro-deadbeef', pr: 9, mode: 'merge', since: '2026-09-12T09:00:00.000Z', phase: 'running the suite', phase_at: '2026-09-12T09:00:05.000Z',
      }));
      const running = runningMerge({
        root, repos: [{ name: 'memoro', path: repoPath }], alive: ALIVE, now: new Date('2026-09-12T09:00:15.000Z'),
      });
      assert.equal(running.phase, 'running the suite');
      assert.equal(running.phase_age_seconds, 10);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reads the holder off the matched repository\'s lease', () => {
    const root = home();
    try {
      const repoPath = '/work/memoro-cli';
      claimLease({
        repoPath, holder: { name: 'martin@laptop', kind: 'shell' }, errand: 'reviewing #485', root,
      });
      takeGateLock({ repo: repoFileSlug(repoPath), pr: 485, root });
      const running = runningMerge({ root, repos: [{ name: 'memoro-cli', path: repoPath }] });
      assert.equal(running.holder, 'martin@laptop');
      assert.equal(running.errand, 'reviewing #485');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
