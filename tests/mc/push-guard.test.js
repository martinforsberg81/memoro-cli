/**
 * A push to a merged branch is said before it happens (push-guard.js, D-0164).
 *
 * Three parties pushed to a squash-merged branch on one day; git accepted
 * every push and nothing read any of them. The guard asks two questions —
 * is there a merged pull request for this branch, and does the branch carry
 * commits main lacks — and refuses only on both. Not knowing never refuses.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MARKER, hookScript, installPushGuard, pushCheckLines, pushGuardState, pushVerdict,
} from '../../src/mc/push-guard.js';

const NOW = new Date('2026-08-23T14:00:00Z');

/** A git that answers the two questions the verdict asks. */
const gitWith = ({ head = 'origin/main', ahead = '2' } = {}) => (args) => {
  if (args.includes('symbolic-ref')) return head;
  if (args.includes('rev-list')) return ahead;
  return null;
};
const ghWith = (answer) => (args, { cwd }) => {
  assert.ok(cwd, 'gh is asked in the repository');
  assert.deepEqual(args.slice(0, 5), ['pr', 'list', '--head', 'topic', '--state']);
  return typeof answer === 'string' ? { ok: true, stdout: answer } : answer;
};

describe('the verdict', () => {
  it('refuses when a merged pull request exists and the branch has commits main lacks — with number, age and count', () => {
    const verdict = pushVerdict({
      cwd: '/r', branch: 'topic', now: NOW,
      git: gitWith({ ahead: '2' }),
      gh: ghWith(JSON.stringify([
        { number: 378, title: 'older', mergedAt: '2026-08-22T10:00:00Z', mergeCommit: { oid: 'aaaaaaa1' } },
        { number: 381, title: 'newer', mergedAt: '2026-08-23T13:10:00Z', mergeCommit: { oid: 'bbbbbbb2' } },
      ])),
    });
    assert.equal(verdict.verdict, 'refuse');
    assert.equal(verdict.pr, 381, 'the newest merge is the fact');
    assert.equal(verdict.merge_commit, 'bbbbbbb');
    assert.equal(verdict.ahead, 2);
    assert.equal(verdict.reason, 'topic was merged as #381 50m ago — 2 commits here would go up to a branch nobody reads any more');
  });

  it('allows when nothing is ahead of main, or when no merged pull request exists', () => {
    assert.equal(pushVerdict({ cwd: '/r', branch: 'topic', git: gitWith({ ahead: '0' }), gh: () => { throw new Error('not asked'); } }).verdict, 'allow');
    const open = pushVerdict({ cwd: '/r', branch: 'topic', git: gitWith(), gh: ghWith('[]') });
    assert.equal(open.verdict, 'allow');
    assert.match(open.reason, /no merged pull request for topic/u);
    assert.equal(pushVerdict({ cwd: '/r', branch: null }).verdict, 'allow');
  });

  it('does not know rather than refuse: no gh, no network, no comparison, nonsense answer', () => {
    const noGh = pushVerdict({ cwd: '/r', branch: 'topic', git: gitWith(), gh: () => ({ ok: false, reason: 'gh is not installed' }) });
    assert.equal(noGh.verdict, 'unknown');
    assert.match(noGh.reason, /could not ask GitHub whether topic was merged — gh is not installed/u);
    assert.equal(pushVerdict({ cwd: '/r', branch: 'topic', git: gitWith({ ahead: null }) }).verdict, 'unknown');
    assert.equal(pushVerdict({ cwd: '/r', branch: 'topic', git: gitWith(), gh: ghWith('not json') }).verdict, 'unknown');
    // And the hook's lines for it: one line, and the push goes.
    assert.deepEqual(pushCheckLines(noGh, { branch: 'topic' }), ['mc: push-guard could not check topic: could not ask GitHub whether topic was merged — gh is not installed — pushing']);
    assert.deepEqual(pushCheckLines({ verdict: 'allow' }, { branch: 'topic' }), []);
  });

  it('the refusal says the way forward, and the override when it is set', () => {
    const refuse = { verdict: 'refuse', base: 'origin/main', reason: 'topic was merged as #1 1h ago — 1 commit here would go up to a branch nobody reads any more' };
    const lines = pushCheckLines(refuse, { branch: 'topic' });
    assert.match(lines[0], /^mc: push refused — topic was merged as #1/u);
    assert.match(lines[2], /git switch -c <new-branch> origin\/main/u);
    assert.match(lines[3], /MC_PUSH_ANYWAY=1 git push/u);
    assert.match(pushCheckLines(refuse, { branch: 'topic', anyway: true })[3], /pushing regardless/u);
  });
});

describe('the hook, installed', () => {
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mc-push-guard-')));
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 't@t']);
    git(dir, ['config', 'user.name', 't']);
    writeFileSync(join(dir, 'a'), 'a');
    git(dir, ['add', 'a']);
    git(dir, ['commit', '-q', '-m', 'one']);
    return dir;
  };

  it('is one sh file in the common hooks directory, calling mc off PATH — never a path that can go away', () => {
    const dir = repo();
    try {
      const first = installPushGuard(dir);
      assert.equal(first.ok, true);
      assert.equal(first.installed, true);
      assert.equal(first.path, join(dir, '.git', 'hooks', 'pre-push'));
      const text = readFileSync(first.path, 'utf8');
      assert.equal(text, hookScript());
      assert.match(text, /^#!\/bin\/sh\n/u);
      assert.ok(text.includes(MARKER));
      assert.match(text, /exec mc repo push-check "\$1" "\$2"/u);
      assert.doesNotMatch(text, /\/Users\/|\/home\//u, 'no absolute path into anybody\'s checkout');
      // No mc on PATH: said, and the push goes (exit 0).
      const noMc = execFileSync('sh', [first.path, 'origin', 'x'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, input: '', stdio: ['pipe', 'pipe', 'pipe'] });
      void noMc;
      // Again: nothing to do, and said so.
      const again = installPushGuard(dir);
      assert.deepEqual(again, { ok: true, installed: false, path: first.path });
      assert.equal(pushGuardState(dir).installed, true);
      // A worktree of the repository shares the hook: same common dir.
      const wt = join(dir, '..', `${dir.split('/').pop()}-wt`);
      git(dir, ['worktree', 'add', '-q', '-b', 'topic', wt]);
      assert.equal(pushGuardState(wt).path, first.path);
      rmSync(wt, { recursive: true, force: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never overwrites a hook it did not write, and says so', () => {
    const dir = repo();
    try {
      const path = join(dir, '.git', 'hooks', 'pre-push');
      writeFileSync(path, '#!/bin/sh\necho theirs\n');
      const outcome = installPushGuard(dir);
      assert.equal(outcome.ok, false);
      assert.match(outcome.reason, /is not mc's — left alone/u);
      assert.equal(readFileSync(path, 'utf8'), '#!/bin/sh\necho theirs\n');
      assert.match(pushGuardState(dir).reason, /not mc's/u);
      // An old mc hook is replaced: the marker is what makes it mc's.
      writeFileSync(path, `#!/bin/sh\n${MARKER}\necho old\n`);
      assert.equal(installPushGuard(dir).installed, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses to install where git would not run it: core.hooksPath set, or not a repository', () => {
    const dir = repo();
    try {
      git(dir, ['config', 'core.hooksPath', '/elsewhere']);
      const outcome = installPushGuard(dir);
      assert.equal(outcome.ok, false);
      assert.match(outcome.reason, /core.hooksPath is set to \/elsewhere/u);
      assert.equal(existsSync(join(dir, '.git', 'hooks', 'pre-push')), false);
      assert.equal(installPushGuard(tmpdir()).ok, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a real git push through the hook', () => {
  it('is refused when a stub gh says the branch was merged, goes with MC_PUSH_ANYWAY=1, and goes when gh cannot answer', () => {
    const git = (cwd, args, env = {}) => execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-push-guard-live-')));
    try {
      const bare = join(root, 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
      const work = join(root, 'work');
      execFileSync('git', ['clone', '-q', bare, work]);
      git(work, ['config', 'user.email', 't@t']);
      git(work, ['config', 'user.name', 't']);
      writeFileSync(join(work, 'a'), 'a');
      git(work, ['add', 'a']);
      git(work, ['commit', '-q', '-m', 'one']);
      git(work, ['push', '-q', '-u', 'origin', 'main']);
      git(work, ['switch', '-q', '-c', 'topic']);
      writeFileSync(join(work, 'b'), 'b');
      git(work, ['add', 'b']);
      git(work, ['commit', '-q', '-m', 'two']);

      // A gh on PATH that says topic was merged, and one that cannot answer.
      const bin = join(root, 'bin');
      execFileSync('mkdir', ['-p', bin]);
      const merged = '[{"number":42,"title":"t","mergedAt":"2026-08-23T13:00:00Z","mergeCommit":{"oid":"abcdef0123"}}]';
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ "$MC_TEST_GH" = down ]; then echo 'error connecting to api.github.com' >&2; exit 1; fi\necho '${merged}'\n`, { mode: 0o755 });
      // The mc the hook finds is this checkout's, not whatever is installed.
      const cli = fileURLToPath(new URL('../../src/mc-cli.js', import.meta.url));
      writeFileSync(join(bin, 'mc'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
      const env = { PATH: `${bin}:${process.env.PATH}` };

      assert.equal(installPushGuard(work).ok, true);
      let refused = null;
      try { git(work, ['push', '-u', 'origin', 'topic'], env); } catch (error) { refused = error; }
      assert.ok(refused, 'the push went through');
      assert.match(refused.stderr, /mc: push refused — topic was merged as #42 .* — 1 commit here would go up to a branch nobody reads any more/u);
      assert.match(refused.stderr, /MC_PUSH_ANYWAY=1 git push/u);
      assert.throws(() => git(work, ['rev-parse', '--verify', 'origin/topic']), 'nothing was pushed');

      // Deliberate: it goes, and says it went regardless.
      const anyway = execFileSync('git', ['-C', work, 'push', '-u', 'origin', 'topic'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, MC_PUSH_ANYWAY: '1' },
      });
      void anyway;
      assert.ok(git(work, ['rev-parse', '--verify', 'origin/topic']));

      // gh down: one line, and the push goes.
      writeFileSync(join(work, 'c'), 'c');
      git(work, ['add', 'c']);
      git(work, ['commit', '-q', '-m', 'three']);
      const out = execFileSync('git', ['-C', work, 'push', 'origin', 'topic'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, MC_TEST_GH: 'down' },
      });
      void out;
      assert.equal(git(work, ['rev-parse', 'origin/topic']).trim(), git(work, ['rev-parse', 'topic']).trim());
      // Main itself: nothing ahead of origin/main is nothing to ask about.
      git(work, ['switch', '-q', 'main']);
      writeFileSync(join(work, 'd'), 'd');
      git(work, ['add', 'd']);
      git(work, ['commit', '-q', '-m', 'four']);
      git(work, ['push', '-q', 'origin', 'main'], { ...env, MC_TEST_GH: 'down' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
