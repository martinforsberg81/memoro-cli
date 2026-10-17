/**
 * "Unmerged" counts content, not commits (2026-08-24).
 *
 * Every merge here is a squash: the branch's commits never appear on main,
 * so the SHA count called every landed branch unmerged forever — twelve of
 * fourteen MSR areas read as disorder, and release refused to clean them.
 * Real git throughout: the squash artefact is the subject, not a stub.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { branchLanded, landedThroughRemote, mergedPullAtTip } from '../../src/mc/branch-landed.js';
import { inspectWorkArea, releaseWorkArea, removeWorktree } from '../../src/mc/work-area.js';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

/**
 * A repository whose branch was squash-merged: `feat` carries two commits
 * main lacks by SHA, and main carries their content in one. `origin/main`
 * is a plain ref — no network anywhere near this.
 */
function squashed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-landed-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-q', '-m', 'root']);
  git(repo, ['switch', '-qc', 'feat']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'one']);
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, ['add', 'b.txt']);
  git(repo, ['commit', '-q', '-m', 'two']);
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['merge', '--squash', '-q', 'feat']);
  git(repo, ['commit', '-q', '-m', 'feat, squashed']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('what landed means after a squash', () => {
  it('a squash-merged branch is landed: commits main lacks, and nothing main lacks', () => {
    const fx = squashed();
    try {
      assert.equal(git(fx.repo, ['rev-list', '--count', 'origin/main..feat']), '2', 'the SHA count still says two');
      assert.equal(branchLanded(fx.repo, 'feat'), 'landed');
    } finally { fx.cleanup(); }
  });

  it('real work is ahead, a conflict is unknown, and no base is unknown too', () => {
    const fx = squashed();
    try {
      git(fx.repo, ['switch', '-q', 'feat']);
      writeFileSync(join(fx.repo, 'c.txt'), 'c\n');
      git(fx.repo, ['add', 'c.txt']);
      git(fx.repo, ['commit', '-q', '-m', 'three']);
      git(fx.repo, ['switch', '-q', 'main']);
      assert.equal(branchLanded(fx.repo, 'feat'), 'ahead');

      // A branch that rewrote what main also rewrote: not answerable.
      git(fx.repo, ['switch', '-qc', 'conf']);
      writeFileSync(join(fx.repo, 'base.txt'), 'theirs\n');
      git(fx.repo, ['commit', '-aqm', 'their base']);
      git(fx.repo, ['switch', '-q', 'main']);
      writeFileSync(join(fx.repo, 'base.txt'), 'ours\n');
      git(fx.repo, ['commit', '-aqm', 'our base']);
      git(fx.repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
      assert.equal(branchLanded(fx.repo, 'conf'), 'unknown');

      assert.equal(branchLanded(fx.repo, 'feat', { base: 'origin/nowhere' }), 'unknown');
    } finally { fx.cleanup(); }
  });
});

/** A work area holding one worktree of the squashed repository's feat branch. */
function area(fx, { branch = 'feat' } = {}) {
  const workRoot = join(fx.root, 'work');
  mkdirSync(join(workRoot, 'x'), { recursive: true });
  git(fx.repo, ['worktree', 'add', '-q', join(workRoot, 'x', 'repo'), branch]);
  return { workRoot, env: { ...process.env, MC_WORK_ROOT: workRoot } };
}

describe('release and remove act on content', () => {
  it('release cleans a landed branch, and says what it kept and why for the other two', () => {
    const fx = squashed();
    try {
      const { workRoot, env } = area(fx);
      const seen = inspectWorkArea('x', env).worktrees[0];
      assert.equal(seen.unmerged_commits, 2);
      assert.equal(seen.landed, 'landed');
      const result = releaseWorkArea('x', { env, dryRun: false });
      assert.equal(result.kept.length, 0, JSON.stringify(result.kept.map((k) => k.why)));
      assert.equal(result.removed[0].what, 'worktree and branch');
      assert.equal(existsSync(join(workRoot, 'x', 'repo')), false);
      assert.throws(() => git(fx.repo, ['rev-parse', '--verify', 'feat']), 'the squash artefact branch survived');
    } finally { fx.cleanup(); }
  });

  it('release keeps real work, named as commits main lacks', () => {
    const fx = squashed();
    try {
      const { env } = area(fx);
      const wt = join(fx.root, 'work', 'x', 'repo');
      writeFileSync(join(wt, 'c.txt'), 'c\n');
      git(wt, ['add', 'c.txt']);
      git(wt, ['commit', '-q', '-m', 'three']);
      const result = releaseWorkArea('x', { env, dryRun: false });
      assert.equal(result.kept.length, 1);
      assert.match(result.kept[0].why, /3 commits main lacks/u);
    } finally { fx.cleanup(); }
  });

  it('release keeps a conflict as a doubt, not as work', () => {
    const fx = squashed();
    try {
      const { env } = area(fx);
      const wt = join(fx.root, 'work', 'x', 'repo');
      writeFileSync(join(wt, 'base.txt'), 'theirs\n');
      git(wt, ['commit', '-aqm', 'their base']);
      git(fx.repo, ['switch', '-q', 'main']);
      writeFileSync(join(fx.repo, 'base.txt'), 'ours\n');
      git(fx.repo, ['commit', '-aqm', 'our base']);
      git(fx.repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
      const result = releaseWorkArea('x', { env, dryRun: false, gh: () => ({ ok: true, stdout: '[]' }) });
      assert.equal(result.kept.length, 1);
      assert.match(result.kept[0].why, /cannot tell whether main has this content/u);
    } finally { fx.cleanup(); }
  });

  it('remove deletes a landed branch and says why when it keeps one', () => {
    const fx = squashed();
    try {
      const { env } = area(fx);
      const result = removeWorktree({ name: 'x', repo: 'repo', env });
      assert.equal(result.ok, true);
      assert.equal(result.branch_kept, false, result.branch_kept_why);
      assert.throws(() => git(fx.repo, ['rev-parse', '--verify', 'feat']));
    } finally { fx.cleanup(); }
  });

  it('remove keeps a branch that is ahead, and its why names the commits', () => {
    const fx = squashed();
    try {
      const { env } = area(fx);
      const wt = join(fx.root, 'work', 'x', 'repo');
      writeFileSync(join(wt, 'c.txt'), 'c\n');
      git(wt, ['add', 'c.txt']);
      git(wt, ['commit', '-q', '-m', 'three']);
      const result = removeWorktree({ name: 'x', repo: 'repo', env });
      assert.equal(result.branch_kept, true);
      assert.match(result.branch_kept_why, /3 commits main lacks/u);
      assert.equal(git(fx.repo, ['rev-parse', '--verify', '--quiet', 'feat']).length > 0, true, 'the work survived');
    } finally { fx.cleanup(); }
  });
});

/**
 * The second question, asked of GitHub (2026-09-26): 29 workareas kept as
 * "cannot tell" had each a merged pull request whose head was their tip.
 * A fake `gh` in the `{ ok, stdout }` shape; every failure is `null`.
 */
describe('mergedPullAtTip', () => {
  const answer = (rows) => () => ({ ok: true, stdout: JSON.stringify(rows) });

  it('returns the newest merged pull request when its head is the tip', () => {
    const gh = answer([
      { number: 7, mergedAt: '2026-09-01T00:00:00Z', headRefOid: 'old' },
      { number: 9, mergedAt: '2026-09-20T00:00:00Z', headRefOid: 'tip' },
    ]);
    assert.deepEqual(mergedPullAtTip('/x', 'b', { gh, tip: 'tip' }), { number: 9, merged_at: '2026-09-20T00:00:00Z' });
  });

  it('is null when an older one matches the tip but the newest does not', () => {
    const gh = answer([
      { number: 7, mergedAt: '2026-09-01T00:00:00Z', headRefOid: 'tip' },
      { number: 9, mergedAt: '2026-09-20T00:00:00Z', headRefOid: 'other' },
    ]);
    assert.equal(mergedPullAtTip('/x', 'b', { gh, tip: 'tip' }), null);
  });

  it('is null when gh fails, answers garbage, answers nothing, or there is no tip', () => {
    assert.equal(mergedPullAtTip('/x', 'b', { gh: () => ({ ok: false, stdout: '' }), tip: 'tip' }), null);
    assert.equal(mergedPullAtTip('/x', 'b', { gh: () => ({ ok: true, stdout: 'not json' }), tip: 'tip' }), null);
    assert.equal(mergedPullAtTip('/x', 'b', { gh: answer([]), tip: 'tip' }), null);
    assert.equal(mergedPullAtTip('/x', 'b', { gh: () => { throw new Error('boom'); }, tip: 'tip' }), null);
    assert.equal(mergedPullAtTip('/x', 'b', { gh: answer([{ number: 1, mergedAt: 'x', headRefOid: 'tip' }]), tip: null }), null);
  });

  it('asks for merged pull requests from the branch', () => {
    let seen = null;
    mergedPullAtTip('/x', 'feat', { gh: (args) => { seen = args; return { ok: false }; }, tip: 't' });
    assert.deepEqual(seen, ['pr', 'list', '--head', 'feat', '--state', 'merged', '--limit', '5', '--json', 'number,mergedAt,headRefOid']);
  });
});

/**
 * A branch the merger restacked (2026-10-17): `restack` (merger.js) replayed
 * `publish-handover-7` onto main and pushed a new head, so #929's head was
 * not the workarea's tip and the next step was built on a dead branch.
 * A bare origin: `feat` carries A locally; the remote `feat` is A′, the same
 * patch on a newer main.
 */
function restacked() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-restack-')));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['remote', 'add', 'origin', origin]);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-q', '-m', 'root']);
  git(repo, ['push', '-q', 'origin', 'main']);
  git(repo, ['switch', '-qc', 'feat']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'A']);
  git(repo, ['push', '-q', 'origin', 'feat']);
  git(repo, ['switch', '-q', 'main']);
  writeFileSync(join(repo, 'm.txt'), 'm\n');
  git(repo, ['add', 'm.txt']);
  git(repo, ['commit', '-q', '-m', 'main moves on']);
  git(repo, ['push', '-q', 'origin', 'main']);
  // The merger's restack: A replayed onto the newer main, pushed as feat.
  git(repo, ['switch', '-qc', 'replay']);
  git(repo, ['cherry-pick', 'feat']);
  git(repo, ['push', '-q', '--force', 'origin', 'replay:feat']);
  const head = git(repo, ['rev-parse', 'replay']);
  git(repo, ['switch', '-q', 'feat']);
  git(repo, ['branch', '-qD', 'replay']);
  git(repo, ['fetch', '-q', 'origin']);
  return { root, repo, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('landedThroughRemote', () => {
  const pulls = (head) => () => ({ ok: true, stdout: JSON.stringify([
    { number: 7, mergedAt: '2026-10-01T00:00:00Z', headRefOid: 'old' },
    { number: 929, mergedAt: '2026-10-17T06:23:00Z', headRefOid: head },
  ]) });

  it('answers when origin/<branch> is the merged head and the local tip carries nothing else', () => {
    const fx = restacked();
    try {
      assert.notEqual(git(fx.repo, ['rev-parse', 'feat']), fx.head, 'the local tip is not the merged head');
      assert.deepEqual(landedThroughRemote(fx.repo, 'feat', { gh: pulls(fx.head) }), { number: 929, merged_at: '2026-10-17T06:23:00Z' });
    } finally { fx.cleanup(); }
  });

  it('is null when the local branch carries a commit the merged head lacks', () => {
    const fx = restacked();
    try {
      writeFileSync(join(fx.repo, 'b.txt'), 'b\n');
      git(fx.repo, ['add', 'b.txt']);
      git(fx.repo, ['commit', '-q', '-m', 'B']);
      assert.equal(landedThroughRemote(fx.repo, 'feat', { gh: pulls(fx.head) }), null);
    } finally { fx.cleanup(); }
  });

  it('is null when gh fails', () => {
    const fx = restacked();
    try {
      assert.equal(landedThroughRemote(fx.repo, 'feat', { gh: () => ({ ok: false, stdout: '' }) }), null);
      assert.equal(landedThroughRemote(fx.repo, 'feat', { gh: () => { throw new Error('boom'); } }), null);
    } finally { fx.cleanup(); }
  });

  it('is null when origin/<branch> is not the merged pull request\'s head', () => {
    const fx = restacked();
    try {
      const other = git(fx.repo, ['rev-parse', 'origin/main']);
      assert.equal(landedThroughRemote(fx.repo, 'feat', { gh: pulls(other) }), null);
    } finally { fx.cleanup(); }
  });
});
