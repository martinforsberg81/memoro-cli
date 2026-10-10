/**
 * `mc plan <programme> --archive` — against a real repository and a bare
 * origin, with GitHub, the docs merge and the area release stubbed.
 *
 * What is asserted is the order and the refusals: nothing is touched while a
 * plan is on main or release would keep something; main goes first, and the
 * planning session is released only once the archive PR has merged.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  PROGRAMME_ARCHIVE_PREFIX, archiveProgramme, archiveVerdict, programmeRow,
} from '../../src/mc/archive-programme.js';
import { formatRow, logRows } from '../../src/mc/archive-plan.js';
import { run } from '../../src/mc/commands/plan.js';

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

/** A bare origin and a clone whose main holds `docs/project/<programme>/`. */
function fixture({ programme = 'gone', plan = null, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-archive-programme-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'memoro-cli');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, repo]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git(repo, ['config', k, v]);
  mkdirSync(join(repo, 'docs', 'project', programme), { recursive: true });
  writeFileSync(join(repo, 'docs', 'project', programme, 'README.md'), '# programme\n');
  writeFileSync(join(repo, 'docs', 'project', 'project_log.md'), LOG);
  if (plan) {
    mkdirSync(join(repo, 'docs', 'project', programme, 'proj'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'project', programme, 'proj', 'PLAN.md'), `---\nstatus: ${plan}\n---\n`);
  }
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  return { root, origin, repo, repos: [{ name: 'memoro-cli', path: repo }] };
}

function stubs({ merged = true, area = null } = {}) {
  const calls = { release: [], merges: [], prs: [] };
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
        return merged ? { merged: true, merged_into: 'main' } : { merged: false, stopped_at: 'checks', reason: 'checks failed' };
      },
      release: (name, { dryRun }) => {
        calls.release.push(dryRun);
        if (!dryRun && area) rmSync(area, { recursive: true, force: true });
        return { removed: [], kept: [], held_by: [], conversations: [] };
      },
    },
  };
}

function args(fx, deps, extra = {}) {
  return {
    repos: fx.repos,
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
  it('refuses while a plan is on main, and says the runner goes first for a done one', () => {
    const v = archiveVerdict({ programme: 'x', plans: [{ repo: 'memoro', project: 'p', status: 'done' }], homes: [{}] });
    assert.equal(v.ok, false);
    assert.match(v.lines[0], /memoro x\/p is still on main \(done\) — mc run archives it first/u);
  });

  it('refuses what release would keep, and anything somebody put in the area', () => {
    const v = archiveVerdict({
      programme: 'x', homes: [{}], areaExists: true,
      forecast: { kept: [{ path: '/a/memoro', why: '2 uncommitted' }], held_by: ['notes.md'] },
    });
    assert.deepEqual(v.lines, ['/a/memoro would be kept: 2 uncommitted', '~/mc/plan/x/notes.md is not mc\'s to remove']);
  });

  it('refuses a programme that is nowhere', () => {
    assert.match(archiveVerdict({ programme: 'x' }).lines[0], /no programme named x/u);
  });

  it('lets a programme with only its own documents go', () => {
    assert.deepEqual(archiveVerdict({ programme: 'x', homes: [{}], areaExists: true, forecast: { kept: [], held_by: [] } }), { ok: true });
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

  it('keeps a file a test reads, removes the rest, and names it in the PR body', async () => {
    const fx = fixture({
      extra: {
        'docs/project/gone/skills/a.md': '# a skill a test reads\n',
        'docs/project/gone/skills/b.md': '# a skill nothing reads\n',
        'tests/x.test.js': "import { readFileSync } from 'node:fs';\n\nreadFileSync('docs/project/gone/skills/a.md', 'utf8');\n",
      },
    });
    const { deps, calls } = stubs();
    const a = args(fx, deps);
    assert.equal(await archiveProgramme('gone', a), 0);
    const branch = git(fx.origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).stdout.split('\n')
      .find((name) => name.startsWith(`${PROGRAMME_ARCHIVE_PREFIX}gone-`));
    assert.deepEqual(git(fx.origin, ['ls-tree', '-r', '--name-only', branch, 'docs/project/gone']).stdout.trim().split('\n'),
      ['docs/project/gone/skills/a.md'], 'a.md is kept in place; README.md and b.md are gone');
    const body = calls.prs[0][calls.prs[0].indexOf('--body') + 1];
    assert.match(body, /- kept: docs\/project\/gone\/skills\/a\.md — named by tests\/x\.test\.js:3/u);
    assert.match(a.stdout.out.text, /docs\/project\/gone\/skills\/a\.md kept — named by tests\/x\.test\.js:3/u);
  });

  it('touches nothing while a plan is still on main', async () => {
    const fx = fixture({ plan: 'active' });
    const { deps, calls } = stubs();
    const a = args(fx, deps);
    assert.equal(await archiveProgramme('gone', a), 1);
    assert.match(a.stderr.out.text, /memoro-cli gone\/proj is still on main \(active\)/u);
    assert.deepEqual(calls.prs, []);
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
