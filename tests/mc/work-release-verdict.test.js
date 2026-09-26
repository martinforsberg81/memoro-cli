/**
 * `releaseVerdict` — may this one worktree go? Pure: whether something
 * stands in it and what GitHub says are handed in (2026-09-26: 29 areas kept
 * as "cannot tell" had merged at their tip).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { releaseVerdict } from '../../src/mc/work-area.js';

const wt = (over = {}) => ({
  path: '/w/x/repo', branch: 'feat', is_git: true, uncommitted: 0, unmerged_commits: 2, landed: 'landed', ...over,
});

function spy(result = null) {
  const calls = [];
  const fn = (w) => { calls.push(w); return result; };
  fn.calls = calls;
  return fn;
}

describe('releaseVerdict', () => {
  it('removes a directory that is not a git checkout', () => {
    assert.deepEqual(releaseVerdict(wt({ is_git: false })), { remove: true, what: 'directory', landed_by: null });
  });

  it('keeps a worktree something stands in', () => {
    assert.deepEqual(releaseVerdict(wt(), { inUse: ['zsh', 'node'] }), { remove: false, why: 'in use by zsh, node' });
  });

  it('keeps uncommitted work', () => {
    assert.deepEqual(releaseVerdict(wt({ uncommitted: 3 })), { remove: false, why: '3 uncommitted' });
  });

  it('keeps a branch that is ahead and never asks GitHub about it', () => {
    const pullAtTip = spy({ number: 1 });
    const verdict = releaseVerdict(wt({ landed: 'ahead', unmerged_commits: 1 }), { pullAtTip });
    assert.deepEqual(verdict, { remove: false, why: '1 commit main lacks' });
    assert.equal(pullAtTip.calls.length, 0);
  });

  it('removes a landed branch without asking GitHub', () => {
    const pullAtTip = spy({ number: 1 });
    assert.deepEqual(releaseVerdict(wt(), { pullAtTip }), { remove: true, what: 'worktree and branch', landed_by: null });
    assert.equal(pullAtTip.calls.length, 0);
  });

  it('removes an unknown branch whose tip is the head of a merged pull request, and names it', () => {
    const pullAtTip = spy({ number: 468, merged_at: '2026-08-30T00:00:00Z' });
    const worktree = wt({ landed: 'unknown' });
    assert.deepEqual(releaseVerdict(worktree, { pullAtTip }),
      { remove: true, what: 'worktree and branch', landed_by: { pr: 468 } });
    assert.deepEqual(pullAtTip.calls, [worktree]);
  });

  it('keeps an unknown branch GitHub cannot vouch for, with the conflict wording', () => {
    assert.deepEqual(releaseVerdict(wt({ landed: 'unknown' }), { pullAtTip: spy(null) }), {
      remove: false,
      why: 'cannot tell whether main has this content — its merge against origin/main conflicts; left for a person',
    });
  });
});
