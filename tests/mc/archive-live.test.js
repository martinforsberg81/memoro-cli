/**
 * Archiving a done plan against real git.
 *
 * `tests/mc/run.test.js` drives the same code with an injected git, which
 * proves the decisions and nothing about the plumbing: whether
 * `git worktree add -b`, `git rm -r --`, the commit and the push are the
 * commands git actually takes, and whether what lands on main is a
 * repository with the directory gone and the row in place.
 *
 * So this builds a repository for the purpose — a bare origin, a checkout,
 * two plans that say `done` and one that says `ready` — and runs the
 * runner's own `archiveDone` over it with `realDeps`. Only `gh` is faked:
 * the forge is the one part that cannot be real without a network, so it
 * answers `pr create` with a number and performs `pr merge --squash` as the
 * git commands GitHub would run.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createRunner, realDeps } from '../../src/mc/run.js';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const plan = (status, next, doc = null) => [
  '---',
  `status: ${status}`,
  `next: "${next}"`,
  'budget: 150k',
  '---',
  '# A project',
  '',
  doc ? `Its note is \`${doc}\`.` : 'It has no note.',
  '',
].join('\n');

const LOG = [
  '# Project log',
  '',
  '## Log',
  '',
  '| date | programme | project | outcome | summary | doc | pointer |',
  '|---|---|---|---|---|---|---|',
  '| 2026-08-01 | mc | closed-out | delivered | Its close-out wrote this row itself. | [docs/technical/closed-out.md](../technical/closed-out.md) | [#1](https://github.com/o/r/pull/1) |',
  '',
].join('\n');

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'mc-archive-live-'));
  const bare = join(root, 'origin.git');
  const repo = join(root, 'memoro-cli');
  const work = join(root, 'work');
  git(root, ['init', '-q', '--bare', bare]);
  git(root, ['clone', '-q', bare, repo]);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'mc-test']);

  const write = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  write('docs/project/project_log.md', LOG);
  write('docs/project/mc/documented/PLAN.md', plan('done', 'Step 3 — close-out: the note and the row', 'docs/technical/documented.md'));
  write('docs/project/mc/closed-out/PLAN.md', plan('done', 'Step 2 — the last step it ran'));
  write('docs/project/mc/still-going/PLAN.md', plan('ready', 'Step 1 — not finished'));
  write('docs/project/prog-two/alone/PLAN.md', plan('done', 'Step 1 — the only project of its programme'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'the projects']);
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  git(repo, ['fetch', '-q', 'origin']);

  // The forge: a PR number on `create`, and a squash onto main on `merge` —
  // which is `mc merge --docs` asking, since 2026-09-02: it reads the pull
  // request as JSON, checks GitHub's own file list is all under `docs/`, and
  // reads the state back after merging rather than trusting the exit code.
  const ghCalls = [];
  let merged = false;
  const gh = (cwd, args) => {
    ghCalls.push(args);
    const json = (value) => ({ ok: true, status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' });
    if (args[1] === 'list') return { ok: true, status: 0, stdout: '', stderr: '' };
    if (args[1] === 'create') return { ok: true, status: 0, stdout: 'https://github.com/o/r/pull/77\n', stderr: '' };
    if (args[1] === 'view') {
      const fields = args[args.indexOf('--json') + 1] || '';
      if (fields.includes('files')) {
        const create = ghCalls.find((call) => call[1] === 'create');
        const branch = create[create.indexOf('--head') + 1];
        const files = git(repo, ['diff', '--name-only', 'origin/main', `origin/${branch}`]).split('\n').filter(Boolean);
        return json({ number: 77, title: 'Archive', state: merged ? 'MERGED' : 'OPEN', isDraft: false, baseRefName: 'main', files: files.map((path) => ({ path })) });
      }
      if (fields.includes('mergeable')) return json({ mergeable: 'MERGEABLE' });
      return json({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: merged ? { oid: 'deadbeefdeadbeef' } : null });
    }
    if (args[1] === 'merge') {
      const forge = join(root, 'forge');
      rmSync(forge, { recursive: true, force: true });
      git(root, ['clone', '-q', bare, forge]);
      git(forge, ['config', 'user.email', 'forge@example.invalid']);
      git(forge, ['config', 'user.name', 'forge']);
      const create = ghCalls.find((call) => call[1] === 'create');
      const branch = create[create.indexOf('--head') + 1];
      git(forge, ['merge', '--squash', `origin/${branch}`]);
      git(forge, ['commit', '-q', '-m', 'Archive done projects (#77)']);
      git(forge, ['push', '-q', 'origin', 'main']);
      merged = true;
      return { ok: true, status: 0, stdout: '', stderr: '' };
    }
    return { ok: true, status: 0, stdout: '', stderr: '' };
  };
  const env = { ...process.env, MC_WORK_ROOT: work, MC_REPOS_HOME: root };
  const deps = { ...realDeps(env), gh, log: () => {} };
  return {
    root, repo, bare, work, deps, ghCalls,
    mainTree: () => git(repo, ['ls-tree', '-r', '--name-only', 'origin/main']).split('\n').filter(Boolean),
    mainFile: (path) => git(repo, ['show', `origin/main:${path}`]),
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('archiving a done plan, for real', () => {
  const fx = repository();
  after(() => fx.cleanup());

  it('removes the directories, writes the rows and lands them on main', async () => {
    const runner = createRunner({ deps: fx.deps });
    const { plans } = runner.queue();
    assert.deepEqual(plans.map((p) => `${p.project}:${p.status}`).sort(),
      ['alone:done', 'closed-out:done', 'documented:done', 'still-going:ready']);

    // The branch the runner pushes is named in the PR it opens; the fake
    // forge squashes exactly that branch onto main.
    const { archived, landed } = await runner.archiveDone({ name: 'memoro-cli', path: fx.repo }, plans);
    assert.deepEqual(archived.sort(), ['alone', 'closed-out', 'documented']);
    assert.deepEqual(landed.sort(), ['alone', 'closed-out', 'documented'],
      'the PR merged, so the workareas these plans explain may go later in the round');

    const tree = fx.mainTree();
    assert.deepEqual(tree.filter((path) => path.startsWith('docs/project/')).sort(), [
      'docs/project/mc/still-going/PLAN.md',
      'docs/project/project_log.md',
    ], 'the three done projects are gone from main, the ready one and the log are not');
    assert.ok(!tree.some((path) => path.startsWith('docs/project/prog-two/')),
      'a programme left empty by its last project goes with it');

    const log = fx.mainFile('docs/project/project_log.md');
    const rows = log.split('\n').filter((line) => /^\| \d{4}-/u.test(line));
    assert.equal(rows.length, 3, 'one row per archived project — and closed-out keeps the one it had');
    assert.equal(rows.filter((row) => row.includes('| closed-out |')).length, 1);
    assert.match(rows.find((row) => row.includes('| closed-out |')), /Its close-out wrote this row itself/u);
    const documented = rows.find((row) => row.includes('| documented |'));
    assert.match(documented, /\| delivered \| Step 3 — close-out: the note and the row \|/u);
    assert.match(documented, /\[docs\/technical\/documented\.md\]\(\.\.\/technical\/documented\.md\)/u);
    assert.match(rows.find((row) => row.includes('| alone |')), /\| none \|/u, 'a project with no note says so');

    // The history is the record: the removed directory is still there behind main.
    assert.match(git(fx.repo, ['log', '--all', '--oneline', '--', 'docs/project/mc/documented']), /\S/u);

    // And the worktree the runner archived in is taken down again.
    assert.equal(existsSync(join(fx.work, 'runner', 'archive', 'memoro-cli')), false);
    assert.doesNotMatch(git(fx.repo, ['branch', '--list', 'mc-archive-*']), /mc-archive-/u);
  });

  it('records the project with no docs/technical note in ~/mc/runner/', () => {
    const table = join(fx.work, 'runner', 'undocumented-closures.md');
    assert.equal(existsSync(table), true);
    const text = execFileSync('cat', [table], { encoding: 'utf8' });
    assert.match(text, /\| memoro-cli \| prog-two \| alone \|/u);
    assert.doesNotMatch(text, /\| documented \|/u);
  });

  it('leaves the next round alone while its PR is open', async () => {
    // `gh pr list` answers with a number now, as it would while the PR is open.
    const deps = { ...fx.deps, gh: (cwd, args) => (args[1] === 'list' ? { ok: true, status: 0, stdout: '812\n', stderr: '' } : fx.deps.gh(cwd, args)) };
    const runner = createRunner({ deps });
    const { archived, landed } = await runner.archiveDone({ name: 'memoro-cli', path: fx.repo }, [{ repo: 'memoro-cli', programme: 'mc', project: 'still-there', status: 'done' }]);
    assert.deepEqual(archived, []);
    assert.deepEqual(landed, []);
    assert.equal(existsSync(join(fx.work, 'runner', 'archive', 'memoro-cli')), false);
  });
});
