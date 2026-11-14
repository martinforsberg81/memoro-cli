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

import { measurementCheckoutPath } from '../../src/mc/measurement-checkout.js';
import { runningRound } from '../../src/mc/gate-lock.js';
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
      mkdirSync(args.at(-2), { recursive: true });
      writeFileSync(join(args.at(-2), '.git'), 'gitdir: fake\n');
    }
    if (args[0] === 'checkout' && args.includes('--detach') && addFails) return { status: 1, stdout: '', stderr: 'invalid reference' };
    if (args[0] === 'rev-parse' && args.includes('--verify')) return { status: 1, stdout: '', stderr: '' };
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
    git,
    workRoot: join(root, 'work'),
    mcHome: join(root, 'home'),
    candidateDir: measurementCheckoutPath(repoPath, join(root, 'work')),
    // The standing checkout goes where the gate's does, under the work root.
    run: (over = {}) => freshenBranchForLanding({
      repoPath, branch: 'track-two', base: 'main', env: { MC_WORK_ROOT: join(root, 'work'), MC_HOME: join(root, 'home') }, git, candidateCwds: () => [], ...over,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('freshening the branch that is landing next in a batch', () => {
  it('holds the repository lane across detached freshening and push, then releases it', async () => {
    const fx = fixture();
    try {
      const out = await fx.run({ git: (args, opts) => {
        assert.equal(runningRound({ root: fx.mcHome, lane: 'repo' })?.pid, process.pid, `lane held during git ${args.join(' ')}`);
        return fx.git(args, opts);
      } });
      assert.equal(out.ok, true, out.reason || '');
      assert.equal(out.at, 'abc1234');
      const merged = fx.calls.find((c) => c.args[0] === 'merge');
      assert.deepEqual(merged.args, ['merge', '--no-edit', 'origin/main']);
      const pushed = fx.calls.find((c) => c.args[0] === 'push');
      assert.deepEqual(pushed.args, ['push', 'origin', 'HEAD:refs/heads/track-two']);
      assert.equal(merged.cwd, fx.candidateDir);
      assert.equal(pushed.cwd, fx.candidateDir);
      assert.deepEqual(fx.calls.filter(({ args }) => args[0] === 'checkout').map(({ args }) => args), [['checkout', '--detach', 'abc1234def']]);
      assert.deepEqual(fx.calls.filter(({ args }) => args[0] === 'update-ref'), [], 'the session branch never moves');
      assert.equal(runningRound({ root: fx.mcHome, lane: 'repo' }), null, 'released after the push');
      assert.equal((await fx.run()).ok, true);
      assert.deepEqual(fx.calls.filter(({ args }) => args[0] === 'worktree' && args[1] === 'add').map(({ args }) => args),
        [['worktree', 'add', '--detach', fx.candidateDir, 'abc1234def']]);
      assert.deepEqual(fx.calls.filter(({ args }) => args[0] === 'worktree' && args[1] === 'remove'), []);
    } finally { fx.cleanup(); }
  });

  it('a fetch or push the network stopped says offline; a refused push does not', async () => {
    const fx = fixture();
    try {
      const down = (stop) => (args, options) => (args[0] === stop
        ? { status: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com' }
        : fx.git(args, options));
      const fetched = await fx.run({ git: down('fetch') });
      assert.deepEqual([fetched.ok, fetched.offline], [false, true]);
      assert.match(fetched.reason, /^git fetch origin --prune failed before freshening track-two \(fatal: unable to access/u);
      assert.equal(fx.calls.some((c) => c.args[0] === 'merge'), false, 'nothing merged on an unknown base');
      const pushed = await fx.run({ git: down('push') });
      assert.deepEqual([pushed.ok, pushed.offline], [false, true]);
    } finally { fx.cleanup(); }
    const refused = fixture({ pushFails: true });
    try {
      const out = await refused.run();
      assert.deepEqual([out.ok, out.offline], [false, undefined]);
    } finally { refused.cleanup(); }
  });

  it('never rebases — the convention is merge in, no force-push', async () => {
    const fx = fixture();
    try {
      await fx.run();
      assert.equal(fx.calls.some((c) => c.args[0] === 'rebase'), false);
      assert.equal(fx.calls.some((c) => c.args.includes('--force') || c.args.includes('-f')), false);
    } finally { fx.cleanup(); }
  });

  it('a conflict aborts and leaves the branch exactly as it was', async () => {
    const fx = fixture({ conflicts: ['src/x.js', 'src/y.js'] });
    try {
      const out = await fx.run();
      assert.equal(out.ok, false);
      assert.match(out.reason, /conflicts with main in src\/x\.js, src\/y\.js/u);
      assert.match(out.reason, /left exactly as it was/u);
      assert.ok(fx.calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--abort'), 'the merge is aborted');
      assert.equal(fx.calls.some((c) => c.args[0] === 'push'), false, 'nothing is pushed on a conflict');
    } finally { fx.cleanup(); }
  });

  it('a refused push is reported and nothing is retried', async () => {
    const fx = fixture({ pushFails: true });
    try {
      const out = await fx.run();
      assert.equal(out.ok, false);
      assert.match(out.reason, /non-fast-forward/u);
      assert.equal(fx.calls.filter((c) => c.args[0] === 'push').length, 1);
      assert.equal(fx.calls.some((c) => c.args[0] === 'update-ref'), false);
    } finally { fx.cleanup(); }
  });

  it('a branch it cannot check out is a reason, never an exception', async () => {
    const fx = fixture({ addFails: true });
    try {
      const out = await fx.run();
      assert.equal(out.ok, false);
      assert.match(out.reason, /invalid reference/u);
    } finally { fx.cleanup(); }
  });

  it('keeps the standing checkout detached and releases the lane whatever happened', async () => {
    for (const conflicts of [[], ['src/x.js']]) {
      const fx = fixture({ conflicts });
      try {
        await fx.run();
        assert.ok(
          fx.calls.every((c) => c.args[0] !== 'checkout' || c.args[1] === '--detach'),
          'no branch is checked out on either path',
        );
        assert.equal(runningRound({ root: fx.mcHome, lane: 'repo' }), null);
      } finally { fx.cleanup(); }
    }
  });

  it('touches exactly one branch: the one it was given', async () => {
    // The property the removed sweep did not have. Every ref this names is
    // `track-two` or the base it merges in; nothing enumerates open pull
    // requests, and nothing pushes anywhere it was not told to.
    const fx = fixture();
    try {
      await fx.run();
      const refs = fx.calls.flatMap((c) => c.args).filter((a) => /^origin\/|refs\/heads\//u.test(String(a)));
      for (const ref of refs) {
        assert.match(String(ref), /track-two|^origin\/main$/u, `touched an unrelated ref: ${ref}`);
      }
      assert.equal(fx.calls.some((c) => c.args[0] === 'pr'), false, 'it never asks the forge what else is open');
    } finally { fx.cleanup(); }
  });
});

describe('the branch carries the regeneration the gate made', () => {
  const declaration = { prepare: 'npm ci', derived: [{ command: 'npm run sql:inventory -- --write', paths: ['docs/sql/'] }] };
  const withStatus = (fx, porcelain) => {
    let committed = false;
    return (args, opts = {}) => {
      if (args[0] === 'commit') committed = true;
      if (args[0] === 'status') {
        fx.calls.push({ args, cwd: opts.cwd });
        return { status: 0, stdout: committed ? '' : porcelain, stderr: '' };
      }
      return fx.git(args, opts);
    };
  };

  it('prepares, regenerates after the merge, commits, then pushes', async () => {
    const fx = fixture();
    const shelled = [];
    try {
      const out = await fx.run({
        declaration,
        git: withStatus(fx, ' M docs/sql/snapshot.json\n'),
        shell: (command) => { shelled.push(command); return { status: 0, stdout: '', stderr: '' }; },
      });
      assert.equal(out.ok, true, out.reason || '');
      assert.deepEqual(shelled, ['npm ci', 'npm run sql:inventory -- --write']);
      const order = fx.calls.map((c) => c.args[0]);
      assert.ok(order.indexOf('merge') < order.indexOf('commit'));
      assert.ok(order.indexOf('commit') < order.indexOf('push'));
    } finally { fx.cleanup(); }
  });

  it('dirt outside the declared paths pushes nothing', async () => {
    const fx = fixture();
    try {
      const out = await fx.run({
        declaration,
        git: withStatus(fx, ' M src/app.js\n'),
        shell: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      assert.equal(out.ok, false);
      assert.match(out.reason, /src\/app\.js/u);
      assert.equal(fx.calls.some((c) => c.args[0] === 'push'), false);
    } finally { fx.cleanup(); }
  });
});
