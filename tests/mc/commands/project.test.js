import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { listRepoPlans } from '../../../src/mc/brief-collect.js';
import { run } from '../../../src/mc/commands/project.js';
import { PLAN_SCHEMA, PLAN_VERSION, readPlanText } from '../../../src/mc/plan-schema.js';
import { parseEntry, registerPath } from '../../../src/mc/register.js';

const ROOT = '/work';

function fixture(env = {}) {
  const files = {
    [registerPath(ROOT, 'p')]: JSON.stringify({
      project: 'p', repo: 'memoro', steps: [{ key: 'A', status: 'running' }],
      criteria: [{ criterion: 'a', met: false, at: null }, { criterion: 'b', met: false, at: null }],
    }),
  };
  const out = []; const err = [];
  const deps = {
    root: ROOT, env, now: () => new Date('2026-09-18T10:00:00Z'),
    stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) },
    read: (path) => files[path] ?? null,
    write: (path, value) => { files[path] = JSON.stringify(value); },
    lock: (_root, fn) => fn(),
  };
  return { deps, out, err, entry: () => parseEntry(files[registerPath(ROOT, 'p')]) };
}

test('criterion met and unmet write the register through updateCriterion, at the injected now', async () => {
  const f = fixture();
  assert.equal(await run(['criterion', 'met', 'p', '2'], f.deps), 0);
  assert.equal(f.entry().criteria[1].met, true);
  assert.equal(f.entry().criteria[1].at, '2026-09-18T10:00:00Z');
  assert.equal(f.entry().criteria[0].met, false);
  assert.equal(f.out.join(''), 'mc: p criterion 2 — met\n');

  assert.equal(await run(['criterion', 'unmet', 'p', '2'], f.deps), 0);
  assert.equal(f.entry().criteria[1].met, false);
  assert.equal(f.out.join(''), 'mc: p criterion 2 — met\nmc: p criterion 2 — not met\n');
});

test('criterion with <n> alone takes its project from MC_STEP', async () => {
  const f = fixture({ MC_STEP: 'p:0' });
  assert.equal(await run(['criterion', 'met', '1'], f.deps), 0);
  assert.equal(f.entry().criteria[0].met, true);
});

test('criterion with <n> alone and no MC_STEP says which project, and writes nothing', async () => {
  const f = fixture({});
  assert.equal(await run(['criterion', 'met', '1'], f.deps), 2);
  assert.match(f.err.join(''), /which project\?/u);
  assert.equal(f.entry().criteria[0].met, false);
});

test('criterion refuses a number that is not one, and a criterion the register does not hold', async () => {
  const f = fixture();
  assert.equal(await run(['criterion', 'met', 'p', 'x'], f.deps), 2);
  assert.match(f.err.join(''), /x is not a criterion number — 1 is the plan's first/u);

  assert.equal(await run(['criterion', 'met', 'p', '3'], f.deps), 1);
  assert.match(f.err.join(''), /no success criterion 3/u);
  assert.equal(f.entry().criteria.every((c) => c.met === false), true);
});

test('criterion names a project the register does not hold, and exits 1', async () => {
  const f = fixture();
  assert.equal(await run(['criterion', 'met', 'nope', '1'], f.deps), 1);
  assert.match(f.err.join(''), /mc: nope is not in the register/u);
});

test('anything but criterion met or unmet is usage, exit 2', async () => {
  const f = fixture();
  assert.equal(await run(['frobnicate'], f.deps), 2);
  assert.equal(await run(['criterion'], f.deps), 2);
  assert.match(f.err.join(''), /^usage/u);
  assert.equal(f.out.length, 0);
});

/** A plan as a repository holds it on main: no `repo`, as every plan is written today. */
function repoPlan(project) {
  return `${JSON.stringify({
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    goal: [`${project} is done when it runs.`],
    contract: ['Nothing here changes without Martin.'],
    out_of_scope: ['Everything else.'],
    success_criteria: [{ met: false, criterion: 'It runs.', check: 'Run it.' }],
    documents: [],
    steps: [{ title: 'One', status: 'ready', done_when: 'It runs.', instruction: ['Run it.'], comments: [], pr: null, blocked_by: null }],
  }, null, 2)}\n`;
}

/**
 * Two repositories with a `.git` each and a temp home. `memoro` and `memoroCli`
 * map a repository path in the tree to its text, as origin/main holds it; the
 * listing is `listRepoPlans`'s own, fed by a fake git and batch reader.
 */
function importFixture({ memoro = {}, memoroCli = {}, programs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-import-'));
  const repos = [
    { name: 'memoro', path: join(root, 'memoro') },
    { name: 'memoro-cli', path: join(root, 'memoro-cli') },
  ];
  for (const repo of repos) mkdirSync(join(repo.path, '.git'), { recursive: true });
  const trees = new Map([[repos[0].path, memoro], [repos[1].path, memoroCli]]);
  const fetched = [];
  const out = []; const err = [];
  const home = join(root, 'programs');
  const deps = {
    env: {}, repos, home, stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) },
    fetch: (repo) => fetched.push(repo.name),
    programs: () => programs,
    listRepoPlans: (repo) => listRepoPlans(repo, {
      git: (path, args) => (args[0] === 'ls-tree' ? Object.keys(trees.get(path)).join('\n') : null),
      batch: (path, refs) => new Map(refs.map((ref) => [ref, trees.get(path)[ref.slice('origin/main:'.length)]])),
    }),
  };
  return { deps, out, err, fetched, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ALPHA = 'docs/project/memoro/alpha/PLAN.json';
const BETA = 'docs/project/mc/beta/PLAN.json';
const BROKEN = 'docs/project/memoro/broken/PLAN.json';
const LEGACY = 'docs/project/memoro/legacy/PLAN.md';

/** Memoro: one plan, one with problems, one legacy; memoro-cli: one plan. */
function twoRepos() {
  return importFixture({
    memoro: { [ALPHA]: repoPlan('alpha'), [BROKEN]: '{', [LEGACY]: '---\nstatus: ready\n---\n' },
    memoroCli: { [BETA]: repoPlan('beta') },
  });
}

test('import lists what would go, and writes nothing without --apply', async () => {
  const f = twoRepos();
  try {
    assert.equal(await run(['import'], f.deps), 0);
    assert.equal(f.out.length, 4);
    assert.match(f.out[0], /^skip memoro:memoro\/broken — does not read: the file is not JSON/u);
    assert.deepEqual(f.out.slice(1), [
      `would import memoro:memoro/alpha → ${join(f.home, 'memoro', 'alpha', 'PLAN.json')}\n`,
      `would import memoro-cli:mc/beta → ${join(f.home, 'mc', 'beta', 'PLAN.json')}\n`,
      'mc project import --apply to write them\n',
    ]);
    assert.deepEqual(f.fetched, ['memoro', 'memoro-cli']);
    assert.equal(existsSync(f.home), false);
  } finally { f.cleanup(); }
});

test('import --apply writes each plan with repo third, and otherwise the plan as it is on main', async () => {
  const f = twoRepos();
  try {
    assert.equal(await run(['import', '--apply'], f.deps), 0);
    for (const [path, repo, project, where] of [
      [join(f.home, 'memoro', 'alpha', 'PLAN.json'), 'memoro', 'alpha', 'memoro:memoro/alpha'],
      [join(f.home, 'mc', 'beta', 'PLAN.json'), 'memoro-cli', 'beta', 'memoro-cli:mc/beta'],
    ]) {
      assert.ok(f.out.includes(`imported ${where} → ${path}\n`));
      const text = readFileSync(path, 'utf8');
      const written = JSON.parse(text);
      assert.deepEqual(Object.keys(written).slice(0, 3), ['schema', 'version', 'repo']);
      assert.equal(written.repo, repo);
      delete written.repo;
      assert.deepEqual(written, JSON.parse(repoPlan(project)));
      assert.deepEqual(readPlanText(text).problems, []);
    }
  } finally { f.cleanup(); }
});

test('a project already under ~/mc/programs/ is not imported', async () => {
  const f = importFixture({
    memoro: { [ALPHA]: repoPlan('alpha') },
    memoroCli: { [BETA]: repoPlan('beta') },
    programs: [{ project: 'alpha', programme: 'memoro', repo: 'memoro' }],
  });
  try {
    assert.equal(await run(['import'], f.deps), 0);
    assert.deepEqual(f.out, [
      `would import memoro-cli:mc/beta → ${join(f.home, 'mc', 'beta', 'PLAN.json')}\n`,
      'mc project import --apply to write them\n',
    ]);
  } finally { f.cleanup(); }
});

test('the same project in both repositories is imported from the first, and the second is skipped', async () => {
  const f = importFixture({
    memoro: { 'docs/project/memoro/gamma/PLAN.json': repoPlan('gamma') },
    memoroCli: { 'docs/project/mc/gamma/PLAN.json': repoPlan('gamma') },
  });
  try {
    assert.equal(await run(['import', '--apply'], f.deps), 0);
    assert.deepEqual(f.out, [
      'skip memoro-cli:mc/gamma — gamma is memoro\'s\n',
      `imported memoro:memoro/gamma → ${join(f.home, 'memoro', 'gamma', 'PLAN.json')}\n`,
    ]);
    assert.equal(existsSync(join(f.home, 'mc', 'gamma')), false);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'memoro', 'gamma', 'PLAN.json'), 'utf8')).repo, 'memoro');
  } finally { f.cleanup(); }
});

test('nothing to import prints so and returns 0, with or without --apply', async () => {
  const f = importFixture({ memoro: { [LEGACY]: '---\nstatus: ready\n---\n' } });
  try {
    assert.equal(await run(['import'], f.deps), 0);
    assert.equal(await run(['import', '--apply'], f.deps), 0);
    assert.deepEqual(f.out, ['nothing to import\n', 'nothing to import\n']);
    assert.equal(existsSync(f.home), false);
  } finally { f.cleanup(); }
});

test('a target that already holds a file is never written', async () => {
  const f = importFixture({ memoro: { [ALPHA]: repoPlan('alpha') } });
  try {
    const target = join(f.home, 'memoro', 'alpha', 'PLAN.json');
    mkdirSync(join(f.home, 'memoro', 'alpha'), { recursive: true });
    writeFileSync(target, 'not a plan\n');
    assert.equal(await run(['import', '--apply'], f.deps), 0);
    assert.deepEqual(f.out, [`skip memoro:memoro/alpha — ${target} exists\n`, 'nothing to import\n']);
    assert.equal(readFileSync(target, 'utf8'), 'not a plan\n');
  } finally { f.cleanup(); }
});

test('a write that throws is reported, and the command exits 1', async () => {
  const f = importFixture({ memoro: { [ALPHA]: repoPlan('alpha') } });
  try {
    const deps = { ...f.deps, writeText: () => { throw new Error('disk full'); } };
    assert.equal(await run(['import', '--apply'], deps), 1);
    assert.equal(f.err.join(''), 'mc: disk full\n');
  } finally { f.cleanup(); }
});
