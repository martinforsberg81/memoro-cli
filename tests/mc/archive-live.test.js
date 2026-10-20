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
 * and the project directories of an older main — and runs the runner's own
 * `archiveDone` over it with `realDeps`. A plan in the repository is no
 * longer read (ruling 48), so what is left here is the round that waits on an
 * open archive PR and the closeout backfill. Only `gh` is faked:
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
  write('docs/project/mc/documented/README.md', '# Documented\n\n## Close\n\nIts plan: [plan](PLAN.json).\n');
  write('docs/technical/documented.md', '# Documented\n\nSee [the close](../project/mc/documented/README.md#close) and [the plan](../project/mc/documented/PLAN.json); [mc](https://example.invalid/mc/documented/README.md) stays.\n');
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
  const headOf = () => {
    const create = ghCalls.find((call) => call[1] === 'create');
    const branch = create[create.indexOf('--head') + 1];
    return git(repo, ['rev-parse', `origin/${branch}`]).trim();
  };
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
        return json({ number: 77, title: 'Archive', state: merged ? 'MERGED' : 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: headOf(), files: files.map((path) => ({ path })) });
      }
      if (fields === 'headRefOid') return json({ headRefOid: headOf() });
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

describe('a closeout for a project archived before closeouts existed', () => {
  const fx = repository();
  after(() => fx.cleanup());

  it('is written from the register and the plan in history, in a PR of its own', async () => {
    const plan = { goal: 'The goal it had.', success_criteria: [{ criterion: 'C.', check: 'K.', met: true }], steps: [{ title: '1. Only', done_when: 'Done.' }] };
    const planPath = 'docs/project/mc/gone/PLAN.json';
    mkdirSync(dirname(join(fx.repo, planPath)), { recursive: true });
    writeFileSync(join(fx.repo, planPath), `${JSON.stringify(plan, null, 2)}\n`);
    git(fx.repo, ['add', '-A']);
    git(fx.repo, ['commit', '-q', '-m', 'gone: plan']);
    git(fx.repo, ['rm', '-q', '-r', 'docs/project/mc/gone']);
    writeFileSync(join(fx.repo, 'docs/project/project_log.md'),
      `${LOG.trimEnd()}\n| 2026-09-30 | mc | gone | delivered | Gone. | none | [#5](https://github.com/o/r/pull/5) |\n`);
    git(fx.repo, ['add', '-A']);
    git(fx.repo, ['commit', '-q', '-m', 'Archive 1 done project: gone']);
    git(fx.repo, ['push', '-q', 'origin', 'HEAD:main']);
    git(fx.repo, ['fetch', '-q', 'origin']);

    const register = join(fx.work, 'runner', 'projects', 'gone.json');
    mkdirSync(dirname(register), { recursive: true });
    writeFileSync(register, JSON.stringify({
      project: 'gone', repo: 'memoro-cli', programme: 'mc', plan: planPath,
      steps: [{ status: 'done', pr: 5, landed: { sha: 'abc', into: 'main', at: '2026-09-30T10:00:00Z' } }],
    }));

    const runner = createRunner({ deps: fx.deps });
    const { archived } = await runner.archiveDone({ name: 'memoro-cli', path: fx.repo }, []);
    assert.deepEqual(archived, [], 'nothing was archived; one closeout was written');

    const create = fx.ghCalls.find((call) => call[1] === 'create');
    assert.equal(create[create.indexOf('--title') + 1], 'Closeout 1 archived project: gone');
    const closeout = JSON.parse(fx.mainFile('docs/project/mc/closeout/gone.json'));
    assert.equal(closeout.goal, 'The goal it had.');
    assert.equal('plan' in closeout, false);
    assert.equal(closeout.archived, '2026-09-30');
    assert.equal(closeout.steps[0].title, '1. Only');
    assert.equal(closeout.steps[0].pr, 5);

    // On main now, so the next round has nothing to backfill.
    const calls = fx.ghCalls.length;
    const again = await createRunner({ deps: fx.deps }).archiveDone({ name: 'memoro-cli', path: fx.repo }, []);
    assert.deepEqual(again, { archived: [], landed: [] });
    assert.equal(fx.ghCalls.length, calls, 'no PR opened');
  });
});
