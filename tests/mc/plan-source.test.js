/**
 * `plan-source.js` — the plan layout in one module: the repository paths it
 * refuses, the plans under `~/mc/programs/`, and the two finders that read one.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CLOSEOUT_FILE, LEGACY_PLAN_FILE, PLAN_FILE, PROJECT_DIR, findPlan, isRepoPlanPath, lsTreeArgs, parsePlanPath, planIn, planPath, plansInTree,
  programsArchived, programsPlans,
} from '../../src/mc/plan-source.js';

/** A listing as `git ls-tree` prints it: one path a line, a newline at the end. */
const TREE = [
  'docs/project/README.md',
  'docs/project/mc/closeout/x.json',
  'docs/project/mc/x/notes/PLAN.json',
  'docs/project/mc/x/PLAN.json',
  'docs/project/mc/x/PLAN.md',
  'other/project/mc/x/PLAN.json',
].join('\n') + '\n';

/** A scratch directory, removed when `body` returns. */
function scratch(body) {
  const root = mkdtempSync(join(tmpdir(), 'plan-source-'));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the layout', () => {
  it('names the directory and the two plan files', () => {
    assert.equal(PROJECT_DIR, 'docs/project');
    assert.equal(PLAN_FILE, 'PLAN.json');
    assert.equal(LEGACY_PLAN_FILE, 'PLAN.md');
  });

  it('planPath builds the repository path, the JSON file by default', () => {
    assert.equal(planPath('mc', 'x'), 'docs/project/mc/x/PLAN.json');
    assert.equal(planPath('mc', 'x', 'PLAN.md'), 'docs/project/mc/x/PLAN.md');
  });

  it('parsePlanPath reads a plan path and nothing else', () => {
    assert.deepEqual(parsePlanPath('docs/project/mc/x/PLAN.json'), { path: 'docs/project/mc/x/PLAN.json', programme: 'mc', project: 'x', file: 'PLAN.json' });
    assert.deepEqual(parsePlanPath('docs/project/mc/x/PLAN.md'), { path: 'docs/project/mc/x/PLAN.md', programme: 'mc', project: 'x', file: 'PLAN.md' });
    assert.equal(parsePlanPath('docs/project/README.md'), null);
    assert.equal(parsePlanPath('docs/project/mc/closeout/x.json'), null);
    assert.equal(parsePlanPath('docs/project/mc/x/notes/PLAN.json'), null);
    assert.equal(parsePlanPath('other/project/mc/x/PLAN.json'), null);
  });

  it('isRepoPlanPath is true for a plan file in a repository and nothing else under docs/project', () => {
    assert.equal(isRepoPlanPath('docs/project/mc/x/PLAN.json'), true);
    assert.equal(isRepoPlanPath('docs/project/mc/x/PLAN.md'), true);
    assert.equal(isRepoPlanPath('docs/project/mc/closeout/x.json'), false);
    assert.equal(isRepoPlanPath('docs/project/mc/x/notes/PLAN.json'), false);
    assert.equal(isRepoPlanPath('docs/project/project_log.md'), false);
  });

  it('lsTreeArgs lists the plans directory on origin/main unless told another ref', () => {
    assert.deepEqual(lsTreeArgs(), ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'docs/project']);
    assert.deepEqual(lsTreeArgs('origin/feature'), ['ls-tree', '-r', '--name-only', 'origin/feature', '--', 'docs/project']);
  });

  it('plansInTree keeps the two plan entries of a mixed listing, in order', () => {
    assert.deepEqual(plansInTree(null), []);
    assert.deepEqual(plansInTree(TREE), [
      { path: 'docs/project/mc/x/PLAN.json', programme: 'mc', project: 'x', file: 'PLAN.json' },
      { path: 'docs/project/mc/x/PLAN.md', programme: 'mc', project: 'x', file: 'PLAN.md' },
    ]);
  });
});

describe('findPlan', () => {
  /** A programs plan record as `programsPlans` gives it. */
  const held = (project, repo, text = '{}') => ({ path: `/p/mc/${project}/PLAN.json`, programme: 'mc', project, file: PLAN_FILE, text, repo });

  it('finds the plan under ~/mc/programs/, with its repository and the names of that repository\'s plans', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      const programs = () => [held('mc-status', 'memoro', 'programs'), held('mc-other', 'memoro-cli'), held('mc-cut-2', 'memoro')];
      assert.deepEqual(findPlan([{ name: 'memoro', path: memoro }, { name: 'memoro-cli', path: join(root, 'memoro-cli') }], 'mc-status', { programs }), {
        repo: 'memoro',
        path: memoro,
        programme: 'mc',
        plan: '/p/mc/mc-status/PLAN.json',
        text: 'programs',
        names: ['mc-status', 'mc-cut-2'],
      });
    });
  });

  it('asks no git, and takes the old options without reading them', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      const git = () => { throw new Error('findPlan asked git'); };
      const found = findPlan([{ name: 'memoro', path: memoro }], 'x', { ref: 'origin/feature', git, programs: () => [held('x', 'memoro', 'held')] });
      assert.equal(found.text, 'held');
    });
  });

  it('is null for a name no programs plan holds', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      assert.equal(findPlan([{ name: 'memoro', path: memoro }], 'nothing-here', { programs: () => [held('x', 'memoro')] }), null);
      assert.equal(findPlan([{ name: 'memoro', path: memoro }], 'x', { programs: () => [] }), null);
    });
  });

  it('is null when the plan\'s repository has no `.git` here', () => {
    scratch((root) => {
      const cli = join(root, 'memoro-cli');
      mkdirSync(cli);
      assert.equal(findPlan([{ name: 'memoro-cli', path: cli }], 'x', { programs: () => [held('x', 'memoro-cli')] }), null);
    });
  });

  it('is null when the programs plan names a repository that is not among the repositories', () => {
    scratch((root) => {
      const cli = join(root, 'memoro-cli');
      mkdirSync(join(cli, '.git'), { recursive: true });
      assert.equal(findPlan([{ name: 'memoro-cli', path: cli }], 'mc-status', { programs: () => [held('mc-status', 'memoro')] }), null);
    });
  });
});

describe('planIn', () => {
  // A valid plan, as `step-release.test.js` builds its records: a done step, then one to do.
  const plan = {
    schema: 'mc-plan',
    version: 1,
    goal: ['g'],
    contract: ['c'],
    out_of_scope: ['o'],
    success_criteria: [{ met: false, criterion: 'x', check: 'y' }],
    documents: [],
    steps: [
      { title: 'S1 — one', status: 'done', done_when: 'one', instruction: [], pr: null, blocked_by: null },
      { title: 'S2 — two', status: 'ready', done_when: 'two', instruction: ['Do it.'], pr: null, blocked_by: null },
    ],
  };
  const text = `${JSON.stringify(plan, null, 2)}\n`;

  it('reads the parsed plan under ~/mc/programs/, from its own path', () => {
    const programs = () => [{ path: '/p/mc/x/PLAN.json', programme: 'mc', project: 'x', file: PLAN_FILE, text, repo: 'memoro-cli' }];
    assert.deepEqual(planIn('/w', 'x', { programs }), {
      path: '/p/mc/x/PLAN.json',
      programme: 'mc',
      text,
      plan,
      problems: [],
      legacy: false,
    });
  });

  it('is null when no programs plan is held, and reads nothing in the worktree', () => {
    const read = () => { throw new Error('planIn read the worktree'); };
    const list = () => { throw new Error('planIn listed the worktree'); };
    assert.equal(planIn('/w', 'x', { list, exists: read, read, programs: () => [] }), null);
  });
});

describe('programsPlans', () => {
  it('lists the plans under ~/mc/programs/ with their text and the repository each names', () => {
    scratch((root) => {
      const home = join(root, 'programs');
      const put = (rel, body) => {
        mkdirSync(join(home, dirname(rel)), { recursive: true });
        writeFileSync(join(home, rel), body);
      };
      put('mc/x/PLAN.json', '{"repo":"memoro-cli"}');
      put('mc/y/PLAN.json', 'not json');
      put('mc/memoro/README.md', '# a worktree');
      put('.hidden/z/PLAN.json', '{"repo":"memoro"}');
      put('mc/notes.md', 'notes');
      assert.deepEqual(programsPlans({ home }), [
        { path: join(home, 'mc', 'x', PLAN_FILE), programme: 'mc', project: 'x', file: 'PLAN.json', text: '{"repo":"memoro-cli"}', repo: 'memoro-cli' },
        { path: join(home, 'mc', 'y', PLAN_FILE), programme: 'mc', project: 'y', file: 'PLAN.json', text: 'not json', repo: null },
      ]);
    });
  });

  it('is empty for a home that does not exist', () => {
    scratch((root) => {
      assert.deepEqual(programsPlans({ home: join(root, 'programs') }), []);
    });
  });

  it('takes the directory listing and the reads it is handed', () => {
    const files = { '/p/mc/x/PLAN.json': '{"repo":"memoro"}', '/p/mc/y/PLAN.json': '{"repo":3}' };
    const dirs = { '/p': ['mc'], '/p/mc': ['x', 'y', 'z'] };
    assert.deepEqual(programsPlans({
      home: '/p',
      list: (path) => dirs[path] ?? [],
      read: (path) => files[path] ?? null,
    }), [
      { path: '/p/mc/x/PLAN.json', programme: 'mc', project: 'x', file: 'PLAN.json', text: '{"repo":"memoro"}', repo: 'memoro' },
      { path: '/p/mc/y/PLAN.json', programme: 'mc', project: 'y', file: 'PLAN.json', text: '{"repo":3}', repo: null },
    ]);
  });

  it('skips a project with a CLOSEOUT.json beside its plan: an archived project is not a plan any reader lists', () => {
    const files = {
      '/p/mc/x/PLAN.json': '{"repo":"memoro"}', '/p/mc/x/CLOSEOUT.json': '{}',
      '/p/mc/y/PLAN.json': '{"repo":"memoro-cli"}',
    };
    const dirs = { '/p': ['mc'], '/p/mc': ['x', 'y'] };
    assert.deepEqual(programsPlans({
      home: '/p',
      list: (path) => dirs[path] ?? [],
      read: (path) => files[path] ?? null,
    }).map((p) => p.project), ['y']);
  });

  it('skips an archived project on the real directories too', () => {
    scratch((root) => {
      const home = join(root, 'programs');
      mkdirSync(join(home, 'mc', 'x'), { recursive: true });
      writeFileSync(join(home, 'mc', 'x', PLAN_FILE), '{"repo":"memoro-cli"}');
      writeFileSync(join(home, 'mc', 'x', CLOSEOUT_FILE), '{}');
      assert.deepEqual(programsPlans({ home }), []);
    });
  });
});

describe('programsArchived', () => {
  it('lists the projects that hold a PLAN.json and a CLOSEOUT.json, with the repository each names', () => {
    const files = {
      '/p/mc/x/PLAN.json': '{"repo":"memoro-cli"}', '/p/mc/x/CLOSEOUT.json': '{}',
      '/p/mc/y/PLAN.json': '{}', '/p/mc/y/CLOSEOUT.json': '{}',
      '/p/mc/z/PLAN.json': '{"repo":"memoro"}',
      '/p/ops/w/CLOSEOUT.json': '{}',
    };
    const dirs = { '/p': ['mc', 'ops'], '/p/mc': ['x', 'y', 'z'], '/p/ops': ['w'] };
    assert.deepEqual(programsArchived({
      home: '/p',
      list: (path) => dirs[path] ?? [],
      read: (path) => files[path] ?? null,
    }), [
      { path: '/p/mc/x/PLAN.json', programme: 'mc', project: 'x', repo: 'memoro-cli', closeoutPath: '/p/mc/x/CLOSEOUT.json' },
      { path: '/p/mc/y/PLAN.json', programme: 'mc', project: 'y', repo: null, closeoutPath: '/p/mc/y/CLOSEOUT.json' },
    ]);
  });

  it('reads the real directories: a CLOSEOUT.json with no PLAN.json beside it is not an archived project', () => {
    scratch((root) => {
      const home = join(root, 'programs');
      const put = (rel, body) => {
        mkdirSync(join(home, dirname(rel)), { recursive: true });
        writeFileSync(join(home, rel), body);
      };
      put('mc/x/PLAN.json', '{"repo":"memoro-cli"}');
      put('mc/x/CLOSEOUT.json', '{}');
      put('mc/y/CLOSEOUT.json', '{}');
      assert.deepEqual(programsArchived({ home }), [
        { path: join(home, 'mc', 'x', PLAN_FILE), programme: 'mc', project: 'x', repo: 'memoro-cli', closeoutPath: join(home, 'mc', 'x', CLOSEOUT_FILE) },
      ]);
    });
  });
});
