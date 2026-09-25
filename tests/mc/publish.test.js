/**
 * `mc publish` — AGENTS.md's publication sequence, each rule a check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { messageParts, publishLines, refusal } from '../../src/mc/publish.js';
import { repoName, run } from '../../src/mc/commands/publish.js';

describe('refusal', () => {
  it('refuses main, a dirty tree, and a remote branch that moved — and nothing else', () => {
    assert.match(refusal({ branch: 'main', localHead: 'a' }), /on main/u);
    assert.match(refusal({ branch: 'HEAD', localHead: 'a' }), /on HEAD/u);
    const dirty = refusal({ branch: 'x', dirty: [' M a.js', '?? b.js'], localHead: 'a' });
    assert.match(dirty, /not clean/u);
    assert.match(dirty, /\n {2} M a\.js\n {2}\?\? b\.js$/u);
    assert.match(refusal({ branch: 'x', dirty: Array.from({ length: 12 }, (_, i) => `?? f${i}`), localHead: 'a' }), /… and 2 more/u);
    assert.match(refusal({ branch: 'x', remoteHead: 'bbbbbbb1', localHead: 'a', remoteIsAncestor: false }), /origin\/x is at bbbbbbb.*never force/u);
    assert.equal(refusal({ branch: 'x', remoteHead: 'b', localHead: 'a', remoteIsAncestor: true }), null);
    assert.equal(refusal({ branch: 'x', remoteHead: null, localHead: 'a' }), null);
  });
});

describe('messageParts and publishLines', () => {
  it('splits a commit message into subject and body', () => {
    assert.deepEqual(messageParts('Subject line\n\nBody one\nBody two\n\n'), { title: 'Subject line', body: 'Body one\nBody two' });
    assert.deepEqual(messageParts('Only subject'), { title: 'Only subject', body: '' });
  });

  it('prints the number, the URL, the head and the next line', () => {
    const pr = { number: 7, url: 'https://x/pull/7', headRefOid: 'abcdef0123', baseRefName: 'main', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' };
    assert.deepEqual(publishLines({ pr, localHead: 'abcdef0123456', branch: 'step-x', pushed: true, created: true, repo: 'memoro' }), [
      '#7 https://x/pull/7',
      'opened from step-x → main; pushed abcdef0',
      'state clean, mergeable',
      'next: mc merge memoro 7',
    ]);
    const stale = publishLines({ pr: { ...pr, headRefOid: '9999999', mergeStateStatus: 'UNKNOWN' }, localHead: 'abcdef0', branch: 'b', pushed: false, created: false, repo: 'memoro-cli' });
    assert.equal(stale[1], 'already open from b → main; nothing to push abcdef0 — GitHub holds 9999999, not the head that was pushed: read gh pr view 7');
    assert.deepEqual(stale.slice(2), ['next: mc merge memoro-cli 7']);
  });

  it('names the repository from origin\'s URL', () => {
    assert.equal(repoName('git@github.com:martin/memoro.git', '/w/x'), 'memoro');
    assert.equal(repoName('https://github.com/martin/memoro-cli', '/w/x'), 'memoro-cli');
    assert.equal(repoName('', '/w/memoro-cli'), 'memoro-cli');
  });
});

describe('mc publish', () => {
  function fixture({ branch = 'step-x', status = '', remote = '', prs = [], created = 'https://x/pull/9\n' } = {}) {
    const out = { stdout: '', stderr: '', gh: [], pushed: [] };
    const git = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return '/w/x';
      if (key === 'rev-parse --abbrev-ref HEAD') return branch;
      if (key === 'rev-parse HEAD') return 'aaaaaaa1111';
      if (key === 'status --porcelain') return status;
      if (key.startsWith('ls-remote')) return remote;
      if (key.startsWith('merge-base --is-ancestor')) return '';
      if (key === 'remote get-url origin') return 'git@github.com:m/memoro.git';
      if (key === 'log -1 --format=%B') return 'The subject\n\nThe body.\n';
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      return null;
    };
    const gh = (args) => {
      out.gh.push(args);
      if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(prs), text: '' };
      if (args[1] === 'create') return { ok: true, stdout: created, text: '' };
      if (args[1] === 'edit') return { ok: true, stdout: '', text: '' };
      if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ number: Number(args[2]), url: `https://x/pull/${args[2]}`, headRefOid: 'aaaaaaa1111', baseRefName: 'main', mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }), text: '' };
      return { ok: false, stdout: '', text: 'unexpected' };
    };
    const deps = {
      stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } },
      cwd: '/w/x', git, gh, push: (name) => { out.pushed.push(name); return { ok: true, text: '' }; },
    };
    return { out, deps };
  }

  it('pushes, creates the pull request from the last commit, views it once, and says what to run next', async () => {
    const { out, deps } = fixture();
    assert.equal(await run([], deps), 0);
    assert.deepEqual(out.pushed, ['step-x']);
    assert.deepEqual(out.gh.map((a) => a.slice(0, 2)), [['pr', 'list'], ['pr', 'create'], ['pr', 'view']]);
    assert.deepEqual(out.gh[1], ['pr', 'create', '--base', 'main', '--head', 'step-x', '--title', 'The subject', '--body', 'The body.']);
    assert.equal(out.stdout, '#9 https://x/pull/9\nopened from step-x → main; pushed aaaaaaa\nnext: mc merge memoro 9\n');
  });

  it('finds the open pull request rather than opening a second, edits it only when asked, and skips a push the remote already has', async () => {
    const same = fixture({ remote: 'aaaaaaa1111\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }] });
    assert.equal(await run([], same.deps), 0);
    assert.deepEqual(same.out.pushed, []);
    assert.deepEqual(same.out.gh.map((a) => a[1]), ['list', 'view']);
    assert.match(same.out.stdout, /^#4 .*\nalready open from step-x → main; nothing to push aaaaaaa\nnext: mc merge memoro 4\n$/u);
    const edited = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }] });
    assert.equal(await run(['--title', 'New', '--body', 'B'], edited.deps), 0);
    assert.deepEqual(edited.out.pushed, ['step-x']);
    assert.deepEqual(edited.out.gh[1], ['pr', 'edit', '4', '--title', 'New', '--body', 'B']);
  });

  it('refuses main and a dirty tree before touching the network; --json is the snapshot', async () => {
    const main = fixture({ branch: 'main' });
    assert.equal(await run([], main.deps), 1);
    assert.deepEqual([main.out.pushed, main.out.gh], [[], []]);
    assert.match(main.out.stderr, /on main/u);
    const dirty = fixture({ status: ' M a.js' });
    assert.equal(await run([], dirty.deps), 1);
    assert.match(dirty.out.stderr, /not clean[\s\S]* M a\.js/u);
    const json = fixture();
    assert.equal(await run(['--json'], json.deps), 0);
    const parsed = JSON.parse(json.out.stdout);
    assert.deepEqual([parsed.number, parsed.created, parsed.pushed, parsed.next], [9, true, true, 'mc merge memoro 9']);
    assert.equal(await run(['extra'], fixture().deps), 2);
  });
});
