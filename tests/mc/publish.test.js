/**
 * `mc publish` — the publication sequence (`canon/tasks/publish-and-merge.md`), each rule a check.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { describedBody, messageParts, publishLines, readBody, refusal } from '../../src/mc/publish.js';
import { pushBranch, repoName, run } from '../../src/mc/commands/publish.js';
import { checkAgainstMain } from '../../src/mc/main-conflict.js';
import { goalField, goalJson } from './_helpers/goal-file.js';

/** The merge check's answer when the branch merges cleanly and the fetch works. */
const CLEAN_MAIN = { fetch: { ok: true, text: '' }, paths: [] };

describe('readBody and describedBody', () => {
  it('readBody and describedBody round-trip, and a second publish changes nothing', () => {
    const commits = [{ sha: 'def5678aaaa', subject: 'Fix it', body: 'Why.\n\nCo-Authored-By: x' }];
    const once = describedBody({ text: 'Intro', described: 'abc1234', commits });
    const read = readBody(once);
    assert.deepEqual(read, { text: 'Intro', described: 'abc1234' });
    assert.match(once, /- `def5678` Fix it\n {2}Why\./u);
    assert.doesNotMatch(once, /Co-Authored-By/u);
    assert.equal(describedBody({ ...read, commits }), once);
  });
});

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
  function fixture({ branch = 'step-x', status = '', remote = '', prs = [], created = 'https://x/pull/9\n', body = '', log = '', check = CLEAN_MAIN } = {}) {
    const out = { stdout: '', stderr: '', gh: [], pushed: [], pushOpts: [], merged: [] };
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
      if (key.startsWith('check-ref-format')) return args.at(-1).includes('..') ? null : args.at(-1);
      if (key.startsWith('rev-list')) return 'aaaaaaa1111';
      if (key.startsWith('log --reverse')) return log;
      return null;
    };
    const gh = (args) => {
      out.gh.push(args);
      if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(prs), text: '' };
      if (args[1] === 'create') return { ok: true, stdout: created, text: '' };
      if (args[1] === 'edit') return { ok: true, stdout: '', text: '' };
      if (args[1] === 'view' && args[4] === 'body') return { ok: true, stdout: JSON.stringify({ body }), text: '' };
      if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ number: Number(args[2]), url: `https://x/pull/${args[2]}`, headRefOid: 'aaaaaaa1111', baseRefName: 'main', mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }), text: '' };
      return { ok: false, stdout: '', text: 'unexpected' };
    };
    const deps = {
      env: {},
      stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } },
      cwd: '/w/x', git, gh, push: (name, opts) => { out.pushed.push(name); out.pushOpts.push(opts); return { ok: true, text: '' }; },
      merge: async (argv, { stdout }) => { out.merged.push(argv); stdout.write(`queued for the merger: ${argv.join(' ')}\n`); return 0; },
      mainCheck: () => check,
    };
    return { out, deps };
  }

  it('a fetch that fails is a warning, and the branch is checked against the origin/main it holds: published', async () => {
    const { out, deps } = fixture({ check: { fetch: { ok: false, text: 'could not read from remote' }, paths: [] } });
    assert.equal(await run(['--no-merge'], deps), 0);
    assert.equal(out.stderr, 'mc: warning: git fetch origin failed (could not read from remote) — checked against the origin/main already held\n');
    assert.deepEqual(out.pushed, ['step-x']);
  });

  it('a branch whose merge with origin/main conflicts is refused before anything is pushed, and the path is named', async () => {
    const { out, deps } = fixture({ check: { fetch: { ok: true, text: '' }, paths: ['canon/tasks/scratch-and-probes.md'] } });
    assert.equal(await run([], deps), 1);
    assert.equal(out.stderr, 'mc: the branch conflicts with origin/main in canon/tasks/scratch-and-probes.md — rebase onto origin/main, then run this again\n');
    assert.deepEqual([out.pushed, out.gh, out.merged], [[], [], []]);
  });

  it('pushes, creates the pull request from the last commit, views it once, and queues it for the merger', async () => {
    const { out, deps } = fixture();
    assert.equal(await run([], deps), 0);
    assert.deepEqual(out.pushed, ['step-x']);
    assert.deepEqual(out.gh.map((a) => a.slice(0, 2)), [['pr', 'list'], ['pr', 'create'], ['pr', 'view']]);
    assert.deepEqual(out.gh[1], ['pr', 'create', '--base', 'main', '--head', 'step-x', '--title', 'The subject', '--body', 'The body.\n\n<!-- mc:described aaaaaaa1111 -->']);
    assert.equal(out.stdout, '#9 https://x/pull/9\nopened from step-x → main; pushed aaaaaaa\nqueued for the merger: memoro 9\n');
    assert.deepEqual(out.merged, [['memoro', '9']]);
  });

  it('the merge\'s answer is the publish\'s: an unmet criterion is exit 1 after the PR exists', async () => {
    const { out, deps } = fixture();
    deps.merge = async (argv, { stderr }) => { stderr.write('mc: unmet-criteria — criterion 2\n'); return 1; };
    assert.equal(await run([], deps), 1);
    assert.match(out.stdout, /^#9 /u);
    assert.equal(out.stderr, 'mc: unmet-criteria — criterion 2\n');
  });

  it('--no-merge and --json queue nothing and say what to run next', async () => {
    const plain = fixture();
    assert.equal(await run(['--no-merge'], plain.deps), 0);
    assert.deepEqual(plain.out.merged, []);
    assert.match(plain.out.stdout, /\nnext: mc merge memoro 9\n$/u);
    const json = fixture();
    assert.equal(await run(['--json'], json.deps), 0);
    assert.deepEqual(json.out.merged, []);
  });

  it('a head GitHub does not hold yet is not queued', async () => {
    const { out, deps } = fixture();
    const gh = deps.gh;
    deps.gh = (args) => {
      const answer = gh(args);
      if (args[1] === 'view' && args[4] !== 'body') return { ...answer, stdout: JSON.stringify({ ...JSON.parse(answer.stdout), headRefOid: 'ccccccc' }) };
      return answer;
    };
    assert.equal(await run([], deps), 0);
    assert.deepEqual(out.merged, []);
    assert.match(out.stdout, /GitHub holds ccccccc[^\n]*\nnext: mc merge memoro 9\n$/u);
  });

  describe('the goal a pull request carries (goal-lifecycle)', () => {
    const HOME = '/programs';
    const GDIR = `${HOME}/ios/goals/asc`;
    const GOAL = goalJson({ stage: 'review', repos: ['memoro', 'memoro-cli'], title: 'asc' });
    /** A goal file model beside the publish fixture. */
    const withGoal = (over = {}) => {
      const f = fixture(over.fixture);
      const files = { [`${GDIR}/GOAL.json`]: GOAL, [`${GDIR}/LOG.md`]: '' };
      Object.assign(f.deps, {
        home: HOME, now: () => new Date('2026-11-03T09:00:00Z'),
        readGoal: (path) => files[path] ?? null, writeGoal: (path, text) => { files[path] = text; },
        listGoals: (path) => (path === HOME ? ['ios'] : path === `${HOME}/ios/goals` ? ['asc'] : []),
        ...over.deps,
      });
      return { ...f, files };
    };

    it('--goal writes the pull request into the goal\'s prs, with an entry, and still queues it', async () => {
      const f = withGoal();
      assert.equal(await run(['--goal', 'ios/asc'], f.deps), 0, f.out.stderr);
      assert.deepEqual(goalField(f.files[`${GDIR}/GOAL.json`], 'prs'), ['memoro#9']);
      assert.match(f.files[`${GDIR}/LOG.md`], /· person · review · ready\n\nDone: published memoro#9\n/u);
      assert.match(f.out.stdout, /goal ios\/asc carries memoro#9 — done when every pull request it carries has landed\n/u);
      assert.deepEqual(f.out.merged, [['memoro', '9']]);
    });

    it('MC_GOAL, the goal worktree it stands in, or a goal/<g> branch name the goal too', async () => {
      const byEnv = withGoal({ deps: { env: { MC_GOAL: 'ios/asc' } } });
      assert.equal(await run([], byEnv.deps), 0, byEnv.out.stderr);
      assert.deepEqual(goalField(byEnv.files[`${GDIR}/GOAL.json`], 'prs'), ['memoro#9']);
      const byPath = withGoal({ deps: { cwd: `${GDIR}/memoro` } });
      assert.equal(await run([], byPath.deps), 0, byPath.out.stderr);
      assert.deepEqual(goalField(byPath.files[`${GDIR}/GOAL.json`], 'prs'), ['memoro#9']);
      const byBranch = withGoal({ fixture: { branch: 'goal/asc' } });
      assert.equal(await run([], byBranch.deps), 0, byBranch.out.stderr);
      assert.deepEqual(goalField(byBranch.files[`${GDIR}/GOAL.json`], 'prs'), ['memoro#9']);
    });

    it('no goal named, none written; a --goal that is no goal is refused before the push', async () => {
      const none = withGoal();
      assert.equal(await run([], none.deps), 0);
      assert.deepEqual(goalField(none.files[`${GDIR}/GOAL.json`], 'prs'), []);
      const wrong = withGoal();
      assert.equal(await run(['--goal', 'ios/nope'], wrong.deps), 2);
      assert.match(wrong.out.stderr, /--goal ios\/nope is not a goal/u);
      assert.deepEqual(wrong.out.pushed, []);
    });
  });

  it('finds the open pull request rather than opening a second, edits it only when asked, and skips a push the remote already has', async () => {
    const same = fixture({ remote: 'aaaaaaa1111\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: 'Intro\n\n<!-- mc:described aaaaaaa1111 -->' });
    assert.equal(await run([], same.deps), 0);
    assert.deepEqual(same.out.pushed, []);
    assert.deepEqual(same.out.gh.map((a) => a[1]), ['list', 'view', 'view']);
    assert.match(same.out.stdout, /^#4 .*\nalready open from step-x → main; nothing to push aaaaaaa\nqueued for the merger: memoro 4\n$/u);
    const edited = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }] });
    assert.equal(await run(['--title', 'New', '--body', 'B'], edited.deps), 0);
    assert.deepEqual(edited.out.pushed, ['step-x']);
    assert.deepEqual(edited.out.gh[1], ['pr', 'edit', '4', '--title', 'New', '--body', 'B\n\n<!-- mc:described aaaaaaa1111 -->']);
  });

  it('on an open pull request --body edits the body alone', async () => {
    const edited = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }] });
    assert.equal(await run(['--body', 'B'], edited.deps), 0);
    assert.deepEqual(edited.out.gh[1], ['pr', 'edit', '4', '--body', 'B\n\n<!-- mc:described aaaaaaa1111 -->']);
  });

  it('--body-file reads the body from the file, on a new pull request and on an open one', async () => {
    const read = (path) => (path === 'b.md' ? 'File body.' : null);
    const created = fixture();
    assert.equal(await run(['--body-file', 'b.md'], { ...created.deps, read }), 0);
    assert.deepEqual(created.out.gh[1], ['pr', 'create', '--base', 'main', '--head', 'step-x', '--title', 'The subject', '--body', 'File body.\n\n<!-- mc:described aaaaaaa1111 -->']);
    const edited = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }] });
    assert.equal(await run(['--body-file', 'b.md'], { ...edited.deps, read }), 0);
    assert.deepEqual(edited.out.gh[1], ['pr', 'edit', '4', '--body', 'File body.\n\n<!-- mc:described aaaaaaa1111 -->']);
  });

  it('--title edits the title alone, --base the base alone', async () => {
    const marked = 'Intro\n\n<!-- mc:described aaaaaaa1111 -->';
    const titled = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: marked });
    assert.equal(await run(['--title', 'T'], titled.deps), 0);
    assert.deepEqual(titled.out.gh[2], ['pr', 'edit', '4', '--title', 'T']);
    const based = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: marked });
    assert.equal(await run(['--base', 'release'], based.deps), 0);
    assert.deepEqual(based.out.gh[2], ['pr', 'edit', '4', '--base', 'release']);
  });

  it('an open pull request with later commits gets them under After the description, and only the body is edited', async () => {
    const later = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: 'Intro\n\n<!-- mc:described ccccccc -->', log: 'ddddddd0000\x1fFix\x1f\x1e' });
    assert.equal(await run([], later.deps), 0);
    assert.deepEqual(later.out.gh[2], ['pr', 'edit', '4', '--body', 'Intro\n\n## After the description\n\n- `ddddddd` Fix\n\n<!-- mc:described ccccccc -->']);
    assert.equal(later.out.gh.filter((a) => a[1] === 'edit').length, 1);
    assert.match(later.out.stdout, /description at ccccccc; 1 later commit under "After the description"/u);
  });

  it('nothing after the mark: no edit', async () => {
    const marked = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: 'Intro\n\n<!-- mc:described ccccccc -->' });
    assert.equal(await run([], marked.deps), 0);
    assert.deepEqual(marked.out.gh.map((a) => a[1]), ['list', 'view', 'view']);
  });

  it('a new pull request aims at --base when given', async () => {
    const { out, deps } = fixture();
    assert.equal(await run(['--base', 'release'], deps), 0);
    assert.deepEqual(out.gh[1], ['pr', 'create', '--base', 'release', '--head', 'step-x', '--title', 'The subject', '--body', 'The body.\n\n<!-- mc:described aaaaaaa1111 -->']);
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

  it('--branch is gone with the mend: refused before the network, from a branch or a detached HEAD', async () => {
    for (const branch of ['other', 'HEAD']) {
      const f = fixture({ branch });
      assert.equal(await run(['--branch', 'step-x'], f.deps), 2);
      assert.deepEqual([f.out.pushed, f.out.gh], [[], []]);
    }
    const calls = [];
    const spawn = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    assert.equal(pushBranch('/w/x', 'step-x', { spawn, stderr: { write() {} } }).ok, true);
    assert.deepEqual(calls, [['git', 'push', '-u', 'origin', 'step-x']]);
  });

  it('a detached HEAD is refused', async () => {
    const { out, deps } = fixture({ branch: 'HEAD' });
    assert.equal(await run([], deps), 1);
    assert.match(out.stderr, /on HEAD/u);
    assert.deepEqual([out.pushed, out.gh], [[], []]);
  });

  describe('against a real origin/main', () => {
    // One origin and one clone, real git, built once: `step-x` edits shared.md, which main edits
    // later (a conflict once the clone fetches); `step-y` is behind main and edits only other.md.
    let root;
    let workX;
    let workY;
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const write = (dir, name, text) => writeFileSync(join(dir, name), text);
    const commit = (dir, subject) => git(dir, ['commit', '-q', '-am', subject]);

    before(() => {
      root = mkdtempSync(join(tmpdir(), 'mc-publish-main-'));
      const origin = join(root, 'origin.git');
      const seed = join(root, 'seed');
      workX = join(root, 'work-x');
      workY = join(root, 'work-y');
      git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
      git(root, ['init', '-q', '-b', 'main', seed]);
      write(seed, 'shared.md', 'one\ntwo\n');
      write(seed, 'other.md', 'x\n');
      git(seed, ['add', '.']);
      git(seed, ['commit', '-q', '-m', 'base']);
      git(seed, ['remote', 'add', 'origin', origin]);
      git(seed, ['push', '-q', 'origin', 'main']);
      git(seed, ['push', '-q', 'origin', 'main:release']);
      git(root, ['clone', '-q', origin, workX]);
      git(workX, ['checkout', '-q', '-b', 'step-x']);
      write(workX, 'shared.md', 'BRANCH\ntwo\n');
      commit(workX, 'branch edits the shared line');
      git(root, ['clone', '-q', origin, workY]);
      git(workY, ['checkout', '-q', '-b', 'step-y']);
      write(workY, 'other.md', 'y\n');
      commit(workY, 'branch edits another file');
      write(seed, 'shared.md', 'MAIN\ntwo\n');
      git(seed, ['commit', '-q', '-am', 'main edits the shared line']);
      git(seed, ['push', '-q', 'origin', 'main']);
    });

    after(() => rmSync(root, { recursive: true, force: true }));

    // The merge check is the real one, on the clone; GitHub, the push and the merger stay the fixture's.
    it('a branch that conflicts with origin/main, fetched just now, is refused: exit 1, the path named, nothing pushed or opened', async () => {
      const { out, deps } = fixture({ branch: 'step-x', check: checkAgainstMain(workX) });
      assert.equal(await run([], deps), 1);
      assert.equal(out.stderr, 'mc: the branch conflicts with origin/main in shared.md — rebase onto origin/main, then run this again\n');
      assert.deepEqual([out.pushed, out.gh, out.merged], [[], [], []]);
    });

    // origin/release is the base before main's edit: the branch that conflicts with main is clean against it.
    it('--base names the branch the merge is checked against: clean against origin/release, so published', async () => {
      const { out, deps } = fixture({ branch: 'step-x' });
      deps.mainCheck = (dir, opts) => checkAgainstMain(workX, opts);
      assert.equal(await run(['--base', 'release', '--no-merge'], deps), 0, out.stderr);
      assert.deepEqual(out.pushed, ['step-x']);
      assert.equal(out.stderr, '');
    });

    it('a branch only behind origin/main, with no conflict, publishes as before', async () => {
      const { out, deps } = fixture({ branch: 'step-y', check: checkAgainstMain(workY) });
      assert.equal(await run(['--no-merge'], deps), 0, out.stderr);
      assert.deepEqual(out.pushed, ['step-y']);
      assert.equal(out.stderr, '');
    });
  });
});

describe('pushBranch', () => {
  const thin = { status: 1, stdout: '', stderr: ' ! [remote rejected] step-x -> step-x (Internal Server Error)\nerror: failed to push some refs' };
  function fake(answers) {
    const out = { calls: [], stderr: '' };
    const spawn = (cmd, args) => { out.calls.push([cmd, ...args]); return answers[out.calls.length - 1]; };
    return { out, opts: { spawn, stderr: { write: (s) => { out.stderr += s; } } } };
  }

  it('pushes again once with --no-thin when GitHub rejects the thin pack, and says so', () => {
    const { out, opts } = fake([thin, { status: 0, stdout: '', stderr: 'To github.com:m/memoro.git' }]);
    assert.deepEqual(pushBranch('/w/x', 'step-x', opts), { ok: true, text: 'To github.com:m/memoro.git' });
    assert.deepEqual(out.calls, [['git', 'push', '-u', 'origin', 'step-x'], ['git', 'push', '--no-thin', '-u', 'origin', 'step-x']]);
    assert.equal(out.stderr, 'mc: GitHub rejected the thin pack; pushed again with --no-thin\n');
  });

  it('fails as before when the retry is rejected too, and retries no other failure', () => {
    const both = fake([thin, thin]);
    assert.deepEqual(pushBranch('/w/x', 'step-x', both.opts), { ok: false, text: thin.stderr.trim() });
    assert.equal(both.out.calls.length, 2);
    const other = fake([{ status: 128, stdout: '', stderr: 'fatal: could not read from remote repository' }]);
    assert.deepEqual(pushBranch('/w/x', 'step-x', other.opts), { ok: false, text: 'fatal: could not read from remote repository' });
    assert.equal(other.out.calls.length, 1);
    assert.equal(other.out.stderr, '');
  });
});
