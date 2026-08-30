/**
 * Closing a workarea against real git.
 *
 * `tests/mc/run.test.js` drives the same code with an injected git, which
 * proves the rule and nothing about the plumbing: whether `git worktree
 * remove` and `git branch -D` are the commands git actually takes, whether
 * the folder really goes, and whether what it kept beside its checkout is
 * really still there afterwards. Nothing here is faked — no gh and no
 * network are needed, because closing a workarea touches neither.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createRunner, realDeps } from '../../src/mc/run.js';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const RUNS = ['ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-28T10:00:00Z\tfinished\tstep\t0\t10\t77\t4\t1\t2\t3\t4\tsid\tsuccess,merged',
  '2026-08-28T11:00:00Z\tdirty\tstep\t0\t10\t78\t4\t1\t2\t3\t4\tsid\tsuccess,merged',
  ''].join('\n');

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'mc-close-live-'));
  const bare = join(root, 'origin.git');
  const repo = join(root, 'memoro-cli');
  const work = join(root, 'work');
  git(root, ['init', '-q', '--bare', bare]);
  git(root, ['clone', '-q', bare, repo]);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'mc-test']);
  const write = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  write('README.md', '# a repository\n');
  // `finished` came through the plan world and `dirty` did not: the boundary a
  // round closes across is a PLAN.json in main's history, and this is it.
  write('docs/project/mc/finished/PLAN.json', '{"schema":"mc-plan","version":1}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'first']);
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  git(repo, ['fetch', '-q', 'origin']);

  // Three workareas: one finished, one with an uncommitted change, and one
  // from before the plan world with a commit of its own and no plan at all.
  for (const name of ['finished', 'dirty', 'orphan']) {
    git(repo, ['worktree', 'add', '-q', '-b', name, join(work, name, 'memoro-cli'), 'origin/main']);
  }
  mkdirSync(join(work, 'finished', 'decisions'), { recursive: true });
  writeFileSync(join(work, 'finished', 'decisions', 'mc-1.md'), '# a question that was answered\n');
  mkdirSync(join(work, 'finished', 'inbox'), { recursive: true });
  writeFileSync(join(work, 'finished', 'inbox', 'note.md'), 'a message\n');
  writeFileSync(join(work, 'dirty', 'memoro-cli', 'README.md'), '# edited, not committed\n');
  writeFileSync(join(work, 'orphan', 'memoro-cli', 'kept.md'), '# work main does not have\n');
  git(join(work, 'orphan', 'memoro-cli'), ['add', '-A']);
  git(join(work, 'orphan', 'memoro-cli'), ['commit', '-q', '-m', 'work of its own']);

  mkdirSync(join(work, 'runner', 'log'), { recursive: true });
  writeFileSync(join(work, 'runner', 'log', 'runs.tsv'), RUNS);
  // mc's own folder, and a directory that is not a workarea at all.
  mkdirSync(join(work, 'brief'), { recursive: true });
  writeFileSync(join(work, 'brief', '2026-08-29.md'), '# a brief\n');

  const env = { ...process.env, MC_WORK_ROOT: work, MC_REPOS_HOME: root };
  const deps = { ...realDeps(env), tmuxHas: () => false, log: () => {} };
  return {
    root, repo, work, deps,
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

const PLANS = [
  { repo: 'memoro-cli', programme: 'mc', project: 'finished', status: 'done' },
  { repo: 'memoro-cli', programme: 'mc', project: 'dirty', status: 'done' },
];

describe('closing a workarea, for real', () => {
  const fx = repository();
  after(() => fx.cleanup());

  it('is only the three workareas — mc\'s own folders are not work', () => {
    assert.deepEqual(createRunner({ deps: fx.deps }).workareas(), ['dirty', 'finished', 'orphan']);
  });

  it('closes only the plan-world project — the other finished one is not the runner\u2019s', () => {
    const out = createRunner({ deps: fx.deps }).closeWorkareas(PLANS, ['finished', 'dirty']);
    assert.equal(out.closed, 1);

    assert.equal(existsSync(join(fx.work, 'finished')), false, 'the folder is gone');
    assert.doesNotMatch(git(fx.repo, ['worktree', 'list']), /\/finished\//u);
    assert.doesNotMatch(git(fx.repo, ['branch', '--list', 'finished']), /finished/u);
    // Nothing was deleted: what the folder kept is where the log line says.
    const closed = join(fx.work, 'runner', 'log', 'closed', 'finished');
    assert.equal(readFileSync(join(closed, 'decisions', 'mc-1.md'), 'utf8'), '# a question that was answered\n');
    assert.equal(readFileSync(join(closed, 'inbox', 'note.md'), 'utf8'), 'a message\n');
    assert.match(readFileSync(join(fx.work, 'runner', 'log', 'runner.log'), 'utf8'),
      /close: finished removed — worktree, branch finished, 2 file\(s\) moved/u);
  });

  it('keeps the workarea with an uncommitted change, and says why', () => {
    assert.equal(existsSync(join(fx.work, 'dirty', 'memoro-cli', 'README.md')), true);
    assert.match(git(fx.repo, ['branch', '--list', 'dirty']), /dirty/u);
    assert.match(readFileSync(join(fx.work, 'runner', 'log', 'runner.log'), 'utf8'),
      /close: dirty kept — an uncommitted change/u);
  });

  it('never removes the workarea no project explains, and writes it where mc brief looks', () => {
    assert.equal(existsSync(join(fx.work, 'orphan', 'memoro-cli')), true);
    const text = readFileSync(join(fx.work, 'intake', 'unplanned-workareas.md'), 'utf8');
    assert.match(text, /# Workareas with no project on main/u);
    // Asked of content, not of commit counts: this branch has a commit main
    // does not, so it is `ahead` and something would be lost.
    assert.match(text, /\| orphan \| memoro-cli \| 0 \| \d{4}-\d{2}-\d{2} \| ahead \|/u);
    assert.doesNotMatch(text, /\| finished \|/u);
  });
});
