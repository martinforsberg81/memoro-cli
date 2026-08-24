/**
 * After a green merge, the branches the merge just made dirty (A6).
 *
 * Measured 2026-08-23: one branch rebased twice in forty minutes because
 * main moved under it, ~12 minutes of a track's time with no value in it;
 * three of the day's PRs touched the same hotspot file. The round that
 * moved main freshens the open branches — by merging the base in, never by
 * rewriting them — under rules that are asserted here because each one is
 * a way a helpful mechanism becomes a destructive one:
 * a conflict touches nothing; no push without the owner's inbox line; a
 * declared affected that is red means no push; no declaration means no run,
 * said plainly; an occupied worktree's branch is skipped.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { freshenOpenBranches } from '../../src/mc/repo-freshen.js';

const BASE_SHA = 'basebasebase';

function fixture({
  open = [{ number: 501, headRefName: 'track-one' }],
  behind = { 'track-one': 2 },
  conflicts = {},           // branch -> [files]
  affected = null,          // declared command, via the table stub below
  affectedRed = {},         // branch -> true
  worktrees = {},           // path -> branch (the repo's worktrees)
  busy = [],                // paths with a live process standing in them
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-repo-freshen-'));
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath, { recursive: true });
  // A manifest with no dependencies: the declaration resolves to
  // "nothing-to-install", whose affected is null — tests that declare one
  // inject the outcome through `shell` instead.
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'repo' }));

  const calls = [];
  const sent = [];
  const git = (args, opts = {}) => {
    calls.push({ tool: 'git', args, cwd: opts.cwd });
    if (args[0] === 'rev-list') {
      const branch = String(args[2]).split('..')[0].replace('origin/', '');
      return { status: 0, stdout: `${behind[branch] ?? 0}\n` };
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      mkdirSync(args[3], { recursive: true });
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      const lines = Object.entries(worktrees).flatMap(([path, branch]) => [`worktree ${path}`, `branch refs/heads/${branch}`, '']);
      return { status: 0, stdout: `worktree ${repoPath}\nbranch refs/heads/main\n\n${lines.join('\n')}` };
    }
    if (args[0] === 'merge' && args[1] !== '--abort') {
      const branch = current.branch;
      return conflicts[branch] ? { status: 1, stdout: 'CONFLICT' } : { status: 0, stdout: '' };
    }
    if (args[0] === 'diff') {
      return { status: 0, stdout: (conflicts[current.branch] || []).join('\n') };
    }
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${BASE_SHA}\n` };
    if (args[0] === 'push') return { status: 0, stdout: '' };
    return { status: 0, stdout: '' };
  };
  // Which branch the throwaway worktree currently holds, tracked off the add.
  const current = { branch: null };
  const gitTracking = (args, opts = {}) => {
    if (args[0] === 'worktree' && args[1] === 'add') current.branch = String(args[4]).replace('origin/', '');
    return git(args, opts);
  };
  const gh = (args, opts = {}) => {
    calls.push({ tool: 'gh', args, cwd: opts.cwd });
    if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(open) };
    return { status: 0, stdout: '' };
  };
  const shell = (command, opts) => {
    calls.push({ tool: 'shell', command, cwd: opts.cwd });
    if (command === affected) return { status: affectedRed[current.branch] ? 1 : 0, stdout: '' };
    return { status: 0, stdout: '' };
  };
  return {
    root, repoPath, calls, sent, current,
    pushes: () => calls.filter((call) => call.tool === 'git' && call.args[0] === 'push'),
    run: (extra = {}) => freshenOpenBranches({
      repoPath,
      base: 'main',
      root: join(root, 'home'),
      env: { PATH: '/nonexistent' },
      git: gitTracking,
      gh,
      shell,
      send: (message) => { sent.push(message); return { ok: true, file: '/x.md' }; },
      processes: (paths) => paths.filter((path) => busy.includes(path)).map((path) => ({ pid: 1, path })),
      say: () => {},
      ...extra,
    }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('the freshen step: the same work, done once, by the lease holder', () => {
  it('a branch behind the base gets the base merged in, pushed plainly, and its owner a line', () => {
    const fx = fixture({ worktrees: { '/Users/x/mc/msr-track-1/repo': 'track-one' } });
    try {
      const outcome = fx.run();
      assert.deepEqual(outcome.branches.map((item) => [item.number, item.action]), [[501, 'pushed']]);
      assert.equal(fx.pushes().length, 1);
      assert.deepEqual(fx.pushes()[0].args, ['push', 'origin', 'HEAD:refs/heads/track-one'], 'a plain push — never force');
      assert.equal(outcome.branches[0].told, 'msr-track-1');
      assert.equal(fx.sent.length, 1);
      assert.match(fx.sent[0].message, /freshened .* nothing rewritten, git pull and continue/u);
      assert.equal(fx.sent[0].wake, false, 'a moved branch can wait for the owner\'s next turn');
      // No affected declared: the line says to run your own, not that it ran.
      assert.match(outcome.branches[0].detail, /no affected declared — run yours/u);
    } finally { fx.cleanup(); }
  });

  it('a conflict touches nothing: aborted, reported with the files, the owner told, no push', () => {
    const fx = fixture({ conflicts: { 'track-one': ['src/hot.js', 'src/spot.js'] }, worktrees: { '/Users/x/mc/msr-track-1/repo': 'track-one' } });
    try {
      const outcome = fx.run();
      assert.equal(outcome.branches[0].action, 'conflict');
      assert.match(outcome.branches[0].detail, /conflicts with main in src\/hot\.js, src\/spot\.js — left exactly as it was/u);
      assert.equal(fx.pushes().length, 0);
      assert.ok(fx.calls.some((call) => call.tool === 'git' && call.args[0] === 'merge' && call.args[1] === '--abort'));
      assert.equal(fx.sent.length, 1);
    } finally { fx.cleanup(); }
  });

  it('conflicts only under artifacts/ are said as regenerate-never-resolve, and still not resolved', () => {
    const fx = fixture({ conflicts: { 'track-one': ['artifacts/a.json', 'artifacts/b.json'] } });
    try {
      const outcome = fx.run();
      assert.equal(outcome.branches[0].action, 'conflict');
      assert.match(outcome.branches[0].detail, /only under artifacts\/ \(2 files\) — regenerate, never resolve/u);
      assert.equal(fx.pushes().length, 0);
    } finally { fx.cleanup(); }
  });

  it('a declared affected runs first; red means no push, and the owner is told why', () => {
    const fx = fixture({ affected: 'affected-cmd', affectedRed: { 'track-one': true }, worktrees: { '/Users/x/mc/msr-track-1/repo': 'track-one' } });
    try {
      // Declared the way an operator would: in the table under the home root.
      const home = join(fx.root, 'home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'repo-gates.json'), JSON.stringify({
        repo: { prepare: null, prepare_why: 'test fixture', affected: 'affected-cmd' },
      }));
      const outcome = fx.run();
      assert.equal(outcome.branches[0].action, 'affected-red');
      assert.match(outcome.branches[0].detail, /main merged in cleanly but affected-cmd is red — nothing pushed/u);
      assert.equal(fx.pushes().length, 0);
      assert.equal(fx.sent.length, 1);
      assert.match(fx.sent[0].message, /the branch needs its owner/u);
    } finally { fx.cleanup(); }
  });

  it('a declared affected that is green is run and then pushed, and the line says it ran', () => {
    const fx = fixture({ affected: 'affected-cmd' });
    try {
      const home = join(fx.root, 'home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'repo-gates.json'), JSON.stringify({
        repo: { prepare: null, prepare_why: 'test fixture', affected: 'affected-cmd' },
      }));
      const outcome = fx.run();
      assert.equal(outcome.branches[0].action, 'pushed');
      assert.match(outcome.branches[0].detail, /affected-cmd green/u);
      assert.ok(fx.calls.some((call) => call.tool === 'shell' && call.command === 'affected-cmd'));
    } finally { fx.cleanup(); }
  });

  it('an occupied worktree\'s branch is skipped and says so', () => {
    const fx = fixture({ worktrees: { '/Users/x/mc/msr-track-1/repo': 'track-one' }, busy: ['/Users/x/mc/msr-track-1/repo'] });
    try {
      const outcome = fx.run();
      assert.deepEqual(outcome.branches.map((item) => item.action), ['skipped']);
      assert.match(outcome.branches[0].detail, /somebody is working in a worktree on track-one right now/u);
      assert.equal(fx.pushes().length, 0);
    } finally { fx.cleanup(); }
  });

  it('a branch already current is not even an entry', () => {
    const fx = fixture({ behind: { 'track-one': 0 } });
    try {
      assert.deepEqual(fx.run().branches, []);
    } finally { fx.cleanup(); }
  });
});
