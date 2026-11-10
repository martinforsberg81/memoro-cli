/**
 * `mc plan <programme> --archive` — against a repository and a bare origin in
 * the repository model (`tests/_fake-git-default.mjs`), with GitHub, the docs
 * merge and the area release stubbed. Real git here was some twenty processes
 * a test, 2.2 s under load (2026-11-03); the model answers the same commands
 * (`git grep -l -F` and pathspec globs included) in process.
 *
 * What is asserted is the order and the refusals: nothing is touched while a
 * plan is on main or release would keep something; main goes first, and the
 * planning session is released only once the archive PR has merged.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import {
  PROGRAMME_ARCHIVE_PREFIX, archiveProgramme, archiveVerdict, programmeRow, removedKind, shelveProgramme,
} from '../../src/mc/archive-programme.js';
import { formatRow, logRows } from '../../src/mc/archive-plan.js';
import { run } from '../../src/mc/commands/plan.js';
import { renderGoal } from '../../src/mc/goals.js';

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sink() {
  const out = { text: '' };
  return { out, write: (s) => { out.text += s; } };
}

const LOG = [
  '# Project log', '', '## Log', '',
  '| date | programme | project | outcome | summary | doc | pointer |',
  '|---|---|---|---|---|---|---|',
  formatRow({ date: '2026-09-01', programme: 'old', project: 'p1', outcome: 'delivered', summary: 's', doc: 'none', pointer: '#1' }),
  '',
].join('\n');

const EXTRA = {
  'docs/project/gone/skills/a.md': '# a skill a test reads\n',
  'docs/project/gone/skills/b.md': '# a skill nothing reads\n',
  'tests/x.test.js': "import { readFileSync } from 'node:fs';\n\nreadFileSync('docs/project/gone/skills/a.md', 'utf8');\n",
};

/**
 * A bare origin and a clone whose main holds `docs/project/gone/`, with `files`
 * beside it. A repository home is one such pair.
 */
function home(root, name, files) {
  const origin = join(root, `${name}-origin.git`);
  const repo = join(root, name);
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, repo]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git(repo, ['config', k, v]);
  mkdirSync(join(repo, 'docs', 'project', 'gone'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'project', 'gone', 'README.md'), '# programme\n');
  writeFileSync(join(repo, 'docs', 'project', 'project_log.md'), LOG);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  return { name, origin, repo };
}

/**
 * The consumer fixture: `repos[0]` is memoro-cli with `extra` beside the
 * programme's directory when asked; `second` adds a second repository home,
 * its own origin and clone holding the same directory, as `repos[1]`.
 * `origins` lists every bare origin, for the no-archive-branch check.
 */
function fixture({ goal = null, extra = false, second = false } = {}) {
  const programme = 'gone';
  const root = mkdtempSync(join(tmpdir(), 'mc-archive-programme-'));
  const homes = [home(root, 'memoro-cli', extra ? EXTRA : {})];
  if (second) homes.push(home(root, 'second', {}));
  // A goal lives under the work root's programs/, never in the repository.
  const env = { MC_WORK_ROOT: join(root, 'work') };
  if (goal) {
    mkdirSync(join(root, 'work', 'programs', programme, 'goals', 'g'), { recursive: true });
    writeFileSync(join(root, 'work', 'programs', programme, 'goals', 'g', 'GOAL.json'), renderGoal({
      stage: goal, status: 'ready', repos: ['memoro-cli'], class: 'large', title: 'G', goal: ['g'],
      success_criteria: [{ met: false, criterion: 'x', check: 'y' }],
    }));
  }
  return {
    root,
    origin: homes[0].origin,
    origins: homes.map((h) => h.origin),
    repo: homes[0].repo,
    env,
    repos: homes.map((h) => ({ name: h.name, path: h.repo })),
  };
}

/**
 * `merged` is what docsMerge answers; `mergedBy` overrides it for a repository
 * path, since both archive PRs are #42 from the gh stub and the path is what
 * tells them apart. `area` is what the final release removes; `dry` is what the
 * dry-run forecast keeps and holds.
 */
function stubs({ merged = true, mergedBy = {}, area = null, dry = { kept: [], held_by: [] } } = {}) {
  const calls = { release: [], merges: [], mergeRepos: [], prs: [] };
  return {
    calls,
    deps: {
      git,
      gh: (cwd, args) => {
        if (args[1] === 'list') return { ok: true, stdout: '', stderr: '' };
        calls.prs.push(args);
        return { ok: true, stdout: 'https://github.com/o/r/pull/42\n', stderr: '' };
      },
      docsMerge: async (options) => {
        calls.merges.push(options.pr);
        calls.mergeRepos.push(options.repoPath);
        const landed = options.repoPath in mergedBy ? mergedBy[options.repoPath] : merged;
        return landed ? { merged: true, merged_into: 'main' } : { merged: false, stopped_at: 'checks', reason: 'checks failed' };
      },
      release: (name, { dryRun }) => {
        calls.release.push(dryRun);
        if (dryRun) return { removed: [], kept: dry.kept, held_by: dry.held_by, conversations: [] };
        if (area) rmSync(area, { recursive: true, force: true });
        return { removed: [], kept: [], held_by: [], conversations: [] };
      },
    },
  };
}

/** Every file under `dir` with its text, by path under `dir`; empty when there is no directory. */
function snapshot(dir) {
  const files = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(dir, path)] = readFileSync(path, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

/**
 * What a refused or stopped archive must not have done: no archive PR, no docs
 * merge, no final release, no archive branch on any origin, the area as it was,
 * and nothing shelved. The exit code alone does not show any of this.
 */
function assertNoDestructiveEffect(fx, calls, area, before) {
  assert.deepEqual(calls.prs, []);
  assert.deepEqual(calls.merges, []);
  assert.deepEqual(calls.release.filter((dryRun) => !dryRun), [], 'a final release ran');
  for (const origin of fx.origins) {
    const refs = git(origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).stdout.split('\n');
    assert.deepEqual(refs.filter((name) => name.startsWith(PROGRAMME_ARCHIVE_PREFIX)), [], `an archive branch on ${origin}`);
  }
  assert.ok(existsSync(area), 'the area is gone');
  assert.deepEqual(snapshot(area), before, 'the area changed');
  assert.equal(existsSync(join(fx.root, 'work', 'archive', 'programs', 'gone')), false, 'the programme was shelved');
}

function args(fx, deps, extra = {}) {
  return {
    repos: fx.repos,
    env: fx.env,
    areaName: 'plan/gone',
    areaPath: join(fx.root, 'no-area'),
    stdout: sink(),
    stderr: sink(),
    deps,
    now: () => new Date('2026-10-06T12:00:00Z'),
    ...extra,
  };
}

describe('archiveVerdict', () => {
  it('refuses while a goal of the programme is not finished', () => {
    const v = archiveVerdict({ programme: 'x', goals: [{ goal: 'g', stage: 'build' }], homes: [{}] });
    assert.equal(v.ok, false);
    assert.match(v.lines[0], /goal x\/g is build — it is finished or dropped first/u);
  });

  it('refuses what release would keep, and anything somebody put in the area', () => {
    const v = archiveVerdict({
      programme: 'x', homes: [{}], areaExists: true, area: '~/mc/programs/x',
      forecast: { kept: [{ path: '/a/memoro', why: '2 uncommitted' }], held_by: ['notes.md'] },
    });
    assert.deepEqual(v.lines, ['/a/memoro would be kept: 2 uncommitted', '~/mc/programs/x/notes.md is not mc\'s to remove']);
  });

  it('refuses a programme that is nowhere', () => {
    assert.match(archiveVerdict({ programme: 'x' }).lines[0], /no programme named x/u);
  });

  it('lets a programme with only its own documents go', () => {
    assert.deepEqual(archiveVerdict({ programme: 'x', homes: [{}], areaExists: true, forecast: { kept: [], held_by: [] } }), { ok: true });
  });
});

describe('removedKind', () => {
  const dir = 'docs/project/gone';
  const before = ['docs/project/gone/README.md', 'docs/project/gone/closeout/a.md', 'docs/project/gone/skills/k.md'];
  const isGone = removedKind(dir, before, ['docs/project/gone/skills/k.md']);

  it('names a removed file a blob and a directory it emptied a tree', () => {
    assert.equal(isGone('docs/project/gone/README.md'), 'blob');
    assert.equal(isGone('docs/project/gone/closeout'), 'tree');
  });

  it('leaves a directory with a kept file, and every directory above the programme\'s', () => {
    assert.equal(isGone('docs/project/gone/skills/k.md'), null);
    assert.equal(isGone('docs/project/gone'), null);
    assert.equal(isGone('docs'), null);
    assert.equal(isGone('docs/project'), null);
  });

  it('names the programme\'s own directory a tree when nothing under it is left', () => {
    const all = removedKind(dir, before, []);
    assert.equal(all('docs/project/gone'), 'tree');
    assert.equal(all('docs'), null);
    assert.equal(all('docs/project/gone-two'), null);
  });
});

describe('archiveProgramme', () => {
  it('removes the directory on main with one closed row, then releases the planning session', async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, 'area'));
    const { deps, calls } = stubs({ area: join(fx.root, 'area') });
    const code = await archiveProgramme('gone', args(fx, deps, { areaPath: join(fx.root, 'area') }));
    assert.equal(code, 0);
    assert.deepEqual(calls.merges, [42]);
    assert.deepEqual(calls.release, [true, false]);

    const branches = git(fx.origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).stdout.split('\n');
    const branch = branches.find((name) => name.startsWith(`${PROGRAMME_ARCHIVE_PREFIX}gone-`));
    assert.ok(branch, branches.join(','));
    assert.equal(git(fx.origin, ['ls-tree', '-d', branch, 'docs/project/gone']).stdout, '');
    const rows = logRows(git(fx.origin, ['show', `${branch}:docs/project/project_log.md`]).stdout);
    assert.deepEqual(rows.map((row) => [row.programme, row.project, row.outcome]), [['old', 'p1', 'delivered'], ['gone', '-', 'closed']]);
    // The temporary worktree and its local branch are gone again.
    assert.equal(git(fx.repo, ['branch', '--list', branch]).stdout, '');
    assert.equal(git(fx.repo, ['worktree', 'list']).stdout.trim().split('\n').length, 1);
  });

  it('in layout 2 the planning session\'s worktrees go, the programme\'s directory moves whole to archive/programs/, and the archive exits 0', async () => {
    const fx = fixture();
    const area = join(fx.root, 'work', 'programs', 'gone');
    mkdirSync(join(area, 'proj'), { recursive: true });
    writeFileSync(join(area, 'rulings.md'), '# rulings\n');
    writeFileSync(join(area, 'proj', 'CLOSEOUT.json'), '{}\n');
    const { deps, calls } = stubs();
    const a = args(fx, deps, { areaName: 'programs/gone', areaPath: area });
    assert.equal(await archiveProgramme('gone', a), 0);
    assert.deepEqual(calls.release, [true, false]);
    const moved = join(fx.root, 'work', 'archive', 'programs', 'gone');
    assert.ok(a.stdout.out.text.endsWith(`mc: ${area} — the planning session's worktrees released; the programme's directory moved to ${moved}\nmc: gone archived\n`), a.stdout.out.text);
    assert.equal(existsSync(area), false);
    assert.ok(existsSync(join(moved, 'rulings.md')));
    assert.ok(existsSync(join(moved, 'proj', 'CLOSEOUT.json')));
  });

  it('removes the programme\'s restricted evidence and keeps each entry\'s README in the archived programme', async () => {
    const fx = fixture();
    const area = join(fx.root, 'work', 'programs', 'gone');
    mkdirSync(area, { recursive: true });
    const entry = join(fx.root, 'work', 'restricted', 'gone', '2026-11-08-capture');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'README.md'), '# capture\nDelete when: the programme closes.\n');
    writeFileSync(join(entry, 'original.png'), 'bytes');
    mkdirSync(join(fx.root, 'work', 'restricted', 'other', 'keep'), { recursive: true });
    const { deps } = stubs();
    const a = args(fx, deps, { areaName: 'programs/gone', areaPath: area });
    assert.equal(await archiveProgramme('gone', a), 0, a.stderr.out.text);
    assert.equal(existsSync(join(fx.root, 'work', 'restricted', 'gone')), false);
    assert.ok(existsSync(join(fx.root, 'work', 'restricted', 'other', 'keep')), 'another programme\'s entry was removed');
    const kept = join(fx.root, 'work', 'archive', 'programs', 'gone', 'evidence', '2026-11-08-capture');
    assert.equal(readFileSync(join(kept, 'RESTRICTED-README.md'), 'utf8'), '# capture\nDelete when: the programme closes.\n');
    assert.equal(existsSync(join(kept, 'original.png')), false, 'restricted bytes were carried into the archive');
  });

  it('touches nothing while a restricted entry has no README', async () => {
    const fx = fixture();
    const area = join(fx.root, 'work', 'programs', 'gone');
    mkdirSync(area, { recursive: true });
    const entry = join(fx.root, 'work', 'restricted', 'gone', 'unlabelled');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'original.png'), 'bytes');
    const { deps, calls } = stubs();
    const a = args(fx, deps, { areaName: 'programs/gone', areaPath: area });
    assert.equal(await archiveProgramme('gone', a), 1);
    assert.match(a.stderr.out.text, /restricted\/gone\/unlabelled has no README\.md/u);
    assert.deepEqual(calls.prs, []);
    assert.ok(existsSync(join(entry, 'original.png')));
    assert.ok(existsSync(area));
  });

  it('a programme archived under a name archived before goes beside it, never over it', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-shelve-'));
    const env = { MC_WORK_ROOT: root };
    mkdirSync(join(root, 'archive', 'programs', 'gone'), { recursive: true });
    writeFileSync(join(root, 'archive', 'programs', 'gone', 'old.md'), 'old\n');
    mkdirSync(join(root, 'programs', 'gone'), { recursive: true });
    writeFileSync(join(root, 'programs', 'gone', 'new.md'), 'new\n');
    const to = shelveProgramme(join(root, 'programs', 'gone'), 'gone', env);
    assert.equal(to, join(root, 'archive', 'programs', 'gone-2'));
    assert.ok(existsSync(join(to, 'new.md')));
    assert.ok(existsSync(join(root, 'archive', 'programs', 'gone', 'old.md')));
  });

  it('keeps a file a test reads, removes the rest, and names it in the PR body', async () => {
    const fx = fixture({ extra: true });
    const { deps, calls } = stubs();
    const a = args(fx, deps);
    assert.equal(await archiveProgramme('gone', a), 0, a.stderr.out.text + a.stdout.out.text);
    const branch = git(fx.origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).stdout.split('\n')
      .find((name) => name.startsWith(`${PROGRAMME_ARCHIVE_PREFIX}gone-`));
    assert.deepEqual(git(fx.origin, ['ls-tree', '-r', '--name-only', branch, 'docs/project/gone']).stdout.trim().split('\n'),
      ['docs/project/gone/skills/a.md'], 'a.md is kept in place; README.md and b.md are gone');
    const body = calls.prs[0][calls.prs[0].indexOf('--body') + 1];
    assert.match(body, /- kept: docs\/project\/gone\/skills\/a\.md — named by tests\/x\.test\.js:3/u);
    assert.match(a.stdout.out.text, /docs\/project\/gone\/skills\/a\.md kept — named by tests\/x\.test\.js:3/u);
  });

  it('touches nothing while a goal of the programme is not finished', async () => {
    const fx = fixture({ goal: 'build' });
    const area = join(fx.root, 'area');
    mkdirSync(area);
    writeFileSync(join(area, 'notes.md'), 'notes\n');
    const before = snapshot(area);
    const { deps, calls } = stubs();
    const a = args(fx, deps, { areaPath: area });
    const code = await archiveProgramme('gone', a);
    assertNoDestructiveEffect(fx, calls, area, before);
    assert.deepEqual(calls.release, [true], 'only the forecast ran');
    assert.equal(code, 1, a.stderr.out.text);
    assert.match(a.stderr.out.text, /goal gone\/g is build/u);
  });

  it('touches nothing when the forecast keeps a file and holds a stray in a layout 2 programme', async () => {
    const fx = fixture();
    const area = join(fx.root, 'work', 'programs', 'gone');
    mkdirSync(area, { recursive: true });
    writeFileSync(join(area, 'rulings.md'), '# rulings\n');
    writeFileSync(join(area, 'stray'), 'stray\n');
    const before = snapshot(area);
    const { deps, calls } = stubs({ dry: { kept: [{ path: fx.repo, why: '2 uncommitted' }], held_by: ['stray'] } });
    const a = args(fx, deps, { areaName: 'programs/gone', areaPath: area });
    const code = await archiveProgramme('gone', a);
    assertNoDestructiveEffect(fx, calls, area, before);
    assert.equal(code, 1, a.stderr.out.text);
    assert.ok(a.stderr.out.text.includes(`${fx.repo} would be kept: 2 uncommitted\n`), a.stderr.out.text);
    assert.ok(a.stderr.out.text.includes(`${area}/stray is not mc's to remove\n`), a.stderr.out.text);
  });

  it('a second home that does not merge stops the archive there, and the planning session is kept, not released', async () => {
    const fx = fixture({ second: true });
    const area = join(fx.root, 'area');
    mkdirSync(area);
    writeFileSync(join(area, 'notes.md'), 'notes\n');
    const before = snapshot(area);
    const [first, second] = fx.repos.map((repo) => repo.path);
    const { deps, calls } = stubs({ mergedBy: { [second]: false } });
    const a = args(fx, deps, { areaPath: area });
    const code = await archiveProgramme('gone', a);
    assert.deepEqual(calls.mergeRepos, [first, second]);
    assert.deepEqual(calls.release, [true]);
    assert.deepEqual(snapshot(area), before, 'the planning session changed');
    assert.ok(existsSync(area));
    assert.equal(code, 1, a.stderr.out.text);
    assert.match(a.stderr.out.text, /second #42 did not merge — checks failed; the planning session is kept/u);
  });

  it('keeps the planning session when the archive PR does not merge', async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, 'area'));
    const { deps, calls } = stubs({ merged: false });
    const a = args(fx, deps, { areaPath: join(fx.root, 'area') });
    assert.equal(await archiveProgramme('gone', a), 1);
    assert.deepEqual(calls.release, [true]);
    assert.match(a.stderr.out.text, /#42 did not merge — checks failed; the planning session is kept/u);
    assert.ok(existsSync(join(fx.root, 'area')));
  });

  it('lands an archive PR still open from an earlier attempt instead of opening another', async () => {
    const fx = fixture();
    const { deps, calls } = stubs();
    deps.gh = (cwd, a) => (a[1] === 'list' ? { ok: true, stdout: '17\n', stderr: '' } : assert.fail('opened a second PR'));
    assert.equal(await archiveProgramme('gone', args(fx, deps)), 0);
    assert.deepEqual(calls.merges, [17]);
  });
});

describe('mc plan --archive arguments', () => {
  it('needs a name and takes none of the session flags', async () => {
    for (const [argv, message] of [
      [['--archive'], /archive which programme\?/u],
      [['x', '--archive', '--new'], /--archive starts no session/u],
      [['x', '--archive', '--codex'], /--archive starts no session/u],
    ]) {
      const stderr = sink();
      assert.equal(await run(argv, { stdout: sink(), stderr, repos: [] }), 2);
      assert.match(stderr.out.text, message);
    }
  });

  it('a programme row is the programme, with no project', () => {
    const row = programmeRow({ programme: 'x', date: '2026-10-06', pointer: 'abc1234' });
    assert.equal(row.project, '-');
    assert.equal(row.outcome, 'closed');
    assert.equal(row.pointer, 'abc1234');
  });
});
