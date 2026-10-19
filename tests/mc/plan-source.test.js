/**
 * `plan-source.js` — the plan layout in one module: the paths, the listing of a
 * repository's plans, and the two finders that read a plan by its place.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  LEGACY_PLAN_FILE, PLAN_FILE, PROJECT_DIR, findPlan, lsTreeArgs, parsePlanPath, planIn, planPath, plansInTree, programsPlans, projectNames,
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

/** `git` as the tests need it: `ls-tree` answers from `trees` by repository, `show` from `texts` by `ref:path`. */
function fakeGit(trees, texts = {}) {
  const calls = [];
  const git = (cwd, args) => {
    calls.push([cwd, args]);
    if (args[0] === 'ls-tree') return trees[cwd] ?? null;
    if (args[0] === 'show') return texts[args[1]] ?? null;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}

/** Directory reads over a map of file path → text, as `planIn` is handed them. */
function filesOf(files) {
  return {
    list: (dir) => [...new Set(Object.keys(files)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => path.slice(dir.length + 1).split('/')[0]))],
    exists: (path) => path in files,
    read: (path) => files[path] ?? null,
  };
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

  it('projectNames keeps only the projects with a PLAN.json', () => {
    assert.deepEqual(projectNames(null), []);
    assert.deepEqual(projectNames(TREE), ['x']);
    assert.deepEqual(projectNames('docs/project/mc/x/PLAN.json\ndocs/project/mc/y/PLAN.md\ndocs/project/ops/z/PLAN.json\n'), ['x', 'z']);
  });
});

describe('findPlan', () => {
  it('finds the plan in the first repository that has it, with the siblings of its repository', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      const cli = join(root, 'memoro-cli');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      const repos = [{ name: 'memoro', path: memoro }, { name: 'memoro-cli', path: cli }];
      const trees = {
        [memoro]: 'docs/project/mc/mc-status/PLAN.json\ndocs/project/mc/mc-cut-2/PLAN.json\ndocs/project/mc/old/PLAN.md\n',
      };
      const texts = { 'origin/main:docs/project/mc/mc-status/PLAN.json': '{"plan":1}' };
      const { git, calls } = fakeGit(trees, texts);
      assert.deepEqual(findPlan(repos, 'mc-status', { git }), {
        repo: 'memoro',
        path: memoro,
        programme: 'mc',
        plan: 'docs/project/mc/mc-status/PLAN.json',
        text: '{"plan":1}',
        names: ['mc-status', 'mc-cut-2'],
      });
      // The repository without a `.git` is never asked.
      assert.ok(calls.every(([cwd]) => cwd === memoro));
    });
  });

  it('reads the listing and the text from the ref it is given', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      const { git, calls } = fakeGit({ [memoro]: 'docs/project/mc/x/PLAN.json\n' }, { 'origin/feature:docs/project/mc/x/PLAN.json': 'feature' });
      const found = findPlan([{ name: 'memoro', path: memoro }], 'x', { ref: 'origin/feature', git });
      assert.equal(found.text, 'feature');
      assert.deepEqual(calls[0], [memoro, ['ls-tree', '-r', '--name-only', 'origin/feature', '--', 'docs/project']]);
    });
  });

  it('is null for an unknown name', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      const { git } = fakeGit({ [memoro]: 'docs/project/mc/x/PLAN.json\n' });
      assert.equal(findPlan([{ name: 'memoro', path: memoro }], 'nothing-here', { git }), null);
    });
  });

  it('is null for a repository without a `.git`, which is never asked', () => {
    scratch((root) => {
      const cli = join(root, 'memoro-cli');
      mkdirSync(cli);
      const { git, calls } = fakeGit({ [cli]: 'docs/project/mc/x/PLAN.json\n' });
      assert.equal(findPlan([{ name: 'memoro-cli', path: cli }], 'x', { git }), null);
      assert.deepEqual(calls, []);
    });
  });

  it('a plan under ~/mc/programs/ comes before the repository\'s, with its own path and text, and the names of both', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      const trees = { [memoro]: 'docs/project/mc/mc-status/PLAN.json\ndocs/project/mc/mc-cut-2/PLAN.json\n' };
      const texts = { 'origin/main:docs/project/mc/mc-status/PLAN.json': 'repository' };
      const { git, calls } = fakeGit(trees, texts);
      const programs = () => [
        { path: '/p/mc/mc-status/PLAN.json', programme: 'mc', project: 'mc-status', file: PLAN_FILE, text: 'programs', repo: 'memoro' },
        { path: '/p/mc/mc-new/PLAN.json', programme: 'mc', project: 'mc-new', file: PLAN_FILE, text: '{}', repo: 'memoro' },
      ];
      assert.deepEqual(findPlan([{ name: 'memoro', path: memoro }], 'mc-status', { git, programs }), {
        repo: 'memoro',
        path: memoro,
        programme: 'mc',
        plan: '/p/mc/mc-status/PLAN.json',
        text: 'programs',
        names: ['mc-status', 'mc-cut-2', 'mc-new'],
      });
      assert.ok(calls.every(([, args]) => args[0] !== 'show'), 'the repository copy is not read');
    });
  });

  it('is null when the programs plan names a repository that is not among the repositories', () => {
    scratch((root) => {
      const cli = join(root, 'memoro-cli');
      mkdirSync(join(cli, '.git'), { recursive: true });
      const { git } = fakeGit({ [cli]: 'docs/project/mc/mc-status/PLAN.json\n' });
      const programs = () => [
        { path: '/p/mc/mc-status/PLAN.json', programme: 'mc', project: 'mc-status', file: PLAN_FILE, text: '{}', repo: 'memoro' },
      ];
      assert.equal(findPlan([{ name: 'memoro-cli', path: cli }], 'mc-status', { git, programs }), null);
    });
  });

  it('is today\'s record when no programs plan is held', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      const { git } = fakeGit({ [memoro]: 'docs/project/mc/x/PLAN.json\n' }, { 'origin/main:docs/project/mc/x/PLAN.json': 'main' });
      assert.deepEqual(findPlan([{ name: 'memoro', path: memoro }], 'x', { git, programs: () => [] }), {
        repo: 'memoro',
        path: memoro,
        programme: 'mc',
        plan: 'docs/project/mc/x/PLAN.json',
        text: 'main',
        names: ['x'],
      });
    });
  });

  it('a repository\'s names include the projects its programs plans give it, which are not on main yet', () => {
    scratch((root) => {
      const memoro = join(root, 'memoro');
      mkdirSync(join(memoro, '.git'), { recursive: true });
      const { git } = fakeGit({ [memoro]: 'docs/project/mc/x/PLAN.json\n' }, { 'origin/main:docs/project/mc/x/PLAN.json': 'main' });
      const programs = () => [
        { path: '/p/mc/new/PLAN.json', programme: 'mc', project: 'new', file: PLAN_FILE, text: '{}', repo: 'memoro' },
      ];
      assert.deepEqual(findPlan([{ name: 'memoro', path: memoro }], 'x', { git, programs }).names, ['x', 'new']);
    });
  });
});

describe('planIn', () => {
  const at = (...parts) => join('/w', PROJECT_DIR, ...parts);
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

  it('reads the parsed plan from the PLAN.json of the programme that has the project', () => {
    const files = { [at('mc', 'x', PLAN_FILE)]: text };
    assert.deepEqual(planIn('/w', 'x', filesOf(files)), {
      path: at('mc', 'x', PLAN_FILE),
      programme: 'mc',
      text,
      plan,
      problems: [],
      legacy: false,
    });
  });

  it('reports a project still on PLAN.md as legacy, with no plan to read', () => {
    const files = { [at('ops', 'y', LEGACY_PLAN_FILE)]: '# old' };
    assert.deepEqual(planIn('/w', 'y', filesOf(files)), {
      path: at('ops', 'y', LEGACY_PLAN_FILE),
      programme: 'ops',
      text: '',
      plan: null,
      problems: [],
      legacy: true,
    });
  });

  it('is null for a project with no plan in any programme', () => {
    assert.equal(planIn('/w', 'nothing-here', filesOf({ [at('mc', 'x', PLAN_FILE)]: text })), null);
  });

  it('a plan under ~/mc/programs/ comes before the worktree\'s, read from its own path', () => {
    const files = { [at('mc', 'x', PLAN_FILE)]: '{}' };
    const programs = () => [{ path: '/p/mc/x/PLAN.json', programme: 'mc', project: 'x', file: PLAN_FILE, text, repo: 'memoro-cli' }];
    assert.deepEqual(planIn('/w', 'x', { ...filesOf(files), programs }), {
      path: '/p/mc/x/PLAN.json',
      programme: 'mc',
      text,
      plan,
      problems: [],
      legacy: false,
    });
  });

  it('is the worktree\'s plan when no programs plan is held', () => {
    const files = { [at('mc', 'x', PLAN_FILE)]: text };
    assert.deepEqual(planIn('/w', 'x', { ...filesOf(files), programs: () => [] }), {
      path: at('mc', 'x', PLAN_FILE),
      programme: 'mc',
      text,
      plan,
      problems: [],
      legacy: false,
    });
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
});
