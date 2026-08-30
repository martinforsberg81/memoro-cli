/**
 * A round touches the branch it was asked about, and no other.
 *
 * This file used to assert the opposite. Until 2026-08-30 a green merge round
 * ended by sweeping **every open pull request on the repository** — checking
 * each one out, merging the new main in, running its declared `affected`,
 * pushing, and writing a line into its owner's inbox (A6). It came from a real
 * measurement — one branch rebased twice in forty minutes because main moved
 * under it — and it was still the wrong shape: a round that lands #482 has one
 * subject, and every branch it touched that nobody asked about was a surprise
 * waiting to happen. In practice it meant every round reported that two
 * unrelated six-day-old pull requests conflicted with main, until that read as
 * though the merge which had just succeeded had gone wrong.
 *
 * It was redundant too. The gate merges the current base *into the candidate*
 * before measuring, so drift is already handled in the round that can do
 * something about it — the branch's own.
 *
 * What is asserted now is the one freshen that is left, and the property that
 * makes it legitimate: every branch it touches was named on the command line.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { freshenBranchForLanding } from '../../src/mc/repo-freshen.js';

function fixture({ conflicts = [], addFails = false, pushFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-repo-freshen-'));
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'repo' }));

  const calls = [];
  const git = (args, opts = {}) => {
    calls.push({ args, cwd: opts.cwd });
    if (args[0] === 'worktree' && args[1] === 'add') {
      if (addFails) return { status: 1, stdout: '', stderr: 'invalid reference' };
      mkdirSync(args[3], { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'merge' && args[1] !== '--abort') {
      return conflicts.length ? { status: 1, stdout: 'CONFLICT', stderr: '' } : { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'diff') return { status: 0, stdout: conflicts.join('\n'), stderr: '' };
    if (args[0] === 'push') {
      return pushFails ? { status: 1, stdout: '', stderr: 'non-fast-forward' } : { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abc1234def\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return {
    repoPath,
    calls,
    run: (over = {}) => freshenBranchForLanding({
      repoPath, branch: 'track-two', base: 'main', root: join(root, 'home'), git, ...over,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('freshening the branch that is landing next in a batch', () => {
  it('merges the base in and pushes it plainly', () => {
    const fx = fixture();
    try {
      const out = fx.run();
      assert.equal(out.ok, true, out.reason || '');
      assert.equal(out.at, 'abc1234');
      const merged = fx.calls.find((c) => c.args[0] === 'merge');
      assert.deepEqual(merged.args, ['merge', '--no-edit', 'origin/main']);
      const pushed = fx.calls.find((c) => c.args[0] === 'push');
      assert.deepEqual(pushed.args, ['push', 'origin', 'HEAD:refs/heads/track-two']);
    } finally { fx.cleanup(); }
  });

  it('never rebases — the convention is merge in, no force-push', () => {
    const fx = fixture();
    try {
      fx.run();
      assert.equal(fx.calls.some((c) => c.args[0] === 'rebase'), false);
      assert.equal(fx.calls.some((c) => c.args.includes('--force') || c.args.includes('-f')), false);
    } finally { fx.cleanup(); }
  });

  it('a conflict aborts and leaves the branch exactly as it was', () => {
    const fx = fixture({ conflicts: ['src/x.js', 'src/y.js'] });
    try {
      const out = fx.run();
      assert.equal(out.ok, false);
      assert.match(out.reason, /conflicts with main in src\/x\.js, src\/y\.js/u);
      assert.match(out.reason, /left exactly as it was/u);
      assert.ok(fx.calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--abort'), 'the merge is aborted');
      assert.equal(fx.calls.some((c) => c.args[0] === 'push'), false, 'nothing is pushed on a conflict');
    } finally { fx.cleanup(); }
  });

  it('a refused push is reported and nothing is retried', () => {
    const fx = fixture({ pushFails: true });
    try {
      const out = fx.run();
      assert.equal(out.ok, false);
      assert.match(out.reason, /non-fast-forward/u);
      assert.equal(fx.calls.filter((c) => c.args[0] === 'push').length, 1);
    } finally { fx.cleanup(); }
  });

  it('a branch it cannot check out is a reason, never an exception', () => {
    const fx = fixture({ addFails: true });
    try {
      const out = fx.run();
      assert.equal(out.ok, false);
      assert.match(out.reason, /invalid reference/u);
    } finally { fx.cleanup(); }
  });

  it('prunes its throwaway worktree whatever happened', () => {
    for (const conflicts of [[], ['src/x.js']]) {
      const fx = fixture({ conflicts });
      try {
        fx.run();
        assert.ok(
          fx.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'prune').length >= 1,
          'the worktree is pruned on both paths',
        );
      } finally { fx.cleanup(); }
    }
  });

  it('touches exactly one branch: the one it was given', () => {
    // The property the removed sweep did not have. Every ref this names is
    // `track-two` or the base it merges in; nothing enumerates open pull
    // requests, and nothing pushes anywhere it was not told to.
    const fx = fixture();
    try {
      fx.run();
      const refs = fx.calls.flatMap((c) => c.args).filter((a) => /^origin\/|refs\/heads\//u.test(String(a)));
      for (const ref of refs) {
        assert.match(String(ref), /track-two|^origin\/main$/u, `touched an unrelated ref: ${ref}`);
      }
      assert.equal(fx.calls.some((c) => c.args[0] === 'pr'), false, 'it never asks the forge what else is open');
    } finally { fx.cleanup(); }
  });
});
