import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { listRepoPlans } from '../../../src/mc/brief-collect.js';
import { run } from '../../../src/mc/commands/project.js';
import { PLAN_SCHEMA, PLAN_VERSION, readPlanText } from '../../../src/mc/plan-schema.js';
import { draftProblems } from '../../../src/mc/plan-write.js';
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
  assert.equal(await run(['criterion', 'frobnicate'], f.deps), 2);
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

/**
 * A temp home with one repository, `memoro-cli`, and no plans or closeouts on
 * its origin/main unless a case says otherwise. `draft` is where a project's
 * DRAFT.json lands under `mc/`.
 */
function draftFixture({ listPlans = () => [], listArchived = () => [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mc-draft-'));
  const out = []; const err = [];
  const deps = {
    env: {}, home, repos: [{ name: 'memoro-cli', path: join(home, 'memoro-cli') }], listPlans, listArchived,
    stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) },
  };
  return {
    deps, out, err, home,
    draft: (project) => join(home, 'mc', project, 'DRAFT.json'),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const NEW = ['new', 'mc/alpha', '--repo', 'memoro-cli', '--goal', 'It runs.', '--contract', 'First.', '--contract', 'Second.', '--out-of-scope', 'Else.'];

test('new writes a draft that draftProblems accepts, with its paragraphs in order', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    assert.deepEqual(draftProblems(plan), []);
    assert.deepEqual(plan, {
      schema: PLAN_SCHEMA, version: PLAN_VERSION, repo: 'memoro-cli', goal: ['It runs.'],
      contract: ['First.', 'Second.'], out_of_scope: ['Else.'], success_criteria: [], documents: [], steps: [],
    });
    assert.equal(existsSync(join(f.home, 'mc', 'alpha', 'PLAN.json')), false);
    assert.deepEqual(f.out, [
      `mc: mc/alpha drafted — ${f.draft('alpha')}\n`,
      'next: mc project criterion add alpha "…" --check "<command>"\n',
    ]);
    assert.equal(f.err.length, 0);
  } finally { f.cleanup(); }
});

test('new twice refuses the second, exit 1, and leaves the draft as it was', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(NEW, f.deps), 1);
    assert.equal(f.err.join(''), `mc: alpha exists — ${f.draft('alpha')}\n`);
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('new refuses a name a repository already holds as a plan, exit 1', async () => {
  const f = draftFixture({ listPlans: () => [{ project: 'alpha', programme: 'mc' }] });
  try {
    assert.equal(await run(NEW, f.deps), 1);
    assert.equal(f.err.join(''), 'mc: alpha is a project of memoro-cli already\n');
    assert.equal(existsSync(f.draft('alpha')), false);
  } finally { f.cleanup(); }
});

test('new refuses a name a repository has closed out, exit 1', async () => {
  const f = draftFixture({ listArchived: () => ['alpha'] });
  try {
    assert.equal(await run(NEW, f.deps), 1);
    assert.equal(f.err.join(''), 'mc: alpha is a project of memoro-cli already\n');
    assert.equal(existsSync(f.draft('alpha')), false);
  } finally { f.cleanup(); }
});

test('new refuses a bad name, a missing flag and an unknown repo, exit 2', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(['new', 'mc/Bad_Name', '--repo', 'memoro-cli', '--goal', 'x', '--contract', 'x', '--out-of-scope', 'x'], f.deps), 2);
    assert.match(f.err.join(''), /mc\/Bad_Name is not <programme>\/<project>/u);

    assert.equal(await run(['new', 'mc/alpha', '--repo', 'memoro-cli', '--contract', 'x', '--out-of-scope', 'x'], f.deps), 2);
    assert.match(f.err.join(''), /mc: new needs --goal/u);

    assert.equal(await run(['new', 'mc/alpha', '--repo', 'nowhere', '--goal', 'x', '--contract', 'x', '--out-of-scope', 'x'], f.deps), 2);
    assert.match(f.err.join(''), /mc: nowhere is not a repository mc knows — memoro-cli/u);

    assert.equal(await run([...NEW, '--apply'], f.deps), 2);
    assert.equal(existsSync(f.draft('alpha')), false);
  } finally { f.cleanup(); }
});

test('edit changes the goal of a draft and keeps the rest', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    assert.equal(await run(['edit', 'alpha', '--goal', 'Changed.'], f.deps), 0);
    assert.equal(f.out.at(-1), 'mc: alpha — goal\n');
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    assert.deepEqual(plan.goal, ['Changed.']);
    assert.deepEqual(plan.contract, ['First.', 'Second.']);
    assert.deepEqual(plan.out_of_scope, ['Else.']);
    assert.equal(plan.repo, 'memoro-cli');
    assert.deepEqual(draftProblems(plan), []);
  } finally { f.cleanup(); }
});

test('edit on a directory holding PLAN.json is refused, exit 1, and the plan is untouched', async () => {
  const f = draftFixture();
  try {
    const dir = join(f.home, 'mc', 'sent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PLAN.json'), repoPlan('sent'));
    assert.equal(await run(['edit', 'sent', '--goal', 'Changed.'], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: sent is sent — its goal, contract and out of scope are frozen\n');
    assert.equal(readFileSync(join(dir, 'PLAN.json'), 'utf8'), repoPlan('sent'));
  } finally { f.cleanup(); }
});

test('edit with no field flag is usage, exit 2; a project mc does not hold is exit 1', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    assert.equal(await run(['edit', 'alpha'], f.deps), 2);
    assert.match(f.err.join(''), /mc: edit needs --goal, --contract or --out-of-scope/u);
    assert.equal(await run(['edit', 'nope', '--goal', 'x'], f.deps), 1);
    assert.equal(f.err.at(-1), `mc: no project nope under ${f.home}\n`);
  } finally { f.cleanup(); }
});

test('criterion met given a flag it does not take is refused, exit 2, and the register is untouched', async () => {
  const f = fixture();
  assert.equal(await run(['criterion', 'met', 'p', '2', '--goal', 'x'], f.deps), 2);
  assert.match(f.err.join(''), /mc: criterion met takes no --goal/u);
  assert.equal(f.entry().criteria[1].met, false);
});

test('import given a flag it does not take is refused, exit 2', async () => {
  const f = importFixture();
  try {
    assert.equal(await run(['import', '--goal', 'x'], f.deps), 2);
    assert.equal(f.err.join(''), 'mc: import takes no --goal\n');
  } finally { f.cleanup(); }
});

test('criterion add appends to a draft, in order, unmet, and names the next verb after the first', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    f.out.length = 0;
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.', '--check', 'npm test'], f.deps), 0);
    assert.equal(await run(['criterion', 'add', 'alpha', 'It is tested.', '--check', 'node --test'], f.deps), 0);
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    assert.deepEqual(plan.success_criteria, [
      { met: false, criterion: 'It runs.', check: 'npm test' },
      { met: false, criterion: 'It is tested.', check: 'node --test' },
    ]);
    assert.deepEqual(draftProblems(plan), []);
    assert.deepEqual(f.out, [
      'mc: alpha criterion 1 — It runs.\n',
      'next: mc project step add alpha "<title>" --model haiku|opus --done-when "…" --instruction-file <md>\n',
      'mc: alpha criterion 2 — It is tested.\n',
    ]);
    assert.equal(f.err.length, 0);
  } finally { f.cleanup(); }
});

test('criterion add to a sent plan keeps it valid, and prints no next line', async () => {
  const f = draftFixture();
  try {
    const dir = join(f.home, 'mc', 'sent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PLAN.json'), `${JSON.stringify({ ...JSON.parse(repoPlan('sent')), repo: 'memoro-cli' }, null, 2)}\n`);
    assert.equal(await run(['criterion', 'add', 'sent', 'Another one.', '--check', 'npm test'], f.deps), 0);
    const text = readFileSync(join(dir, 'PLAN.json'), 'utf8');
    assert.deepEqual(readPlanText(text).problems, []);
    const written = JSON.parse(text);
    assert.equal(written.success_criteria.length, 2);
    assert.deepEqual(written.success_criteria[1], { met: false, criterion: 'Another one.', check: 'npm test' });
    assert.deepEqual(f.out, ['mc: sent criterion 2 — Another one.\n']);
  } finally { f.cleanup(); }
});

test('criterion add without --check is usage, exit 2, and the draft is untouched', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.'], f.deps), 2);
    assert.equal(f.err.join(''), 'mc: a criterion needs --check "<command>" — the command that shows it holds\n');
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('criterion add whose check names a person or says a check by hand is refused, exit 1, and the file is unchanged', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.', '--check', 'Martin checks it'], f.deps), 1);
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.', '--check', 'run it by hand'], f.deps), 1);
    assert.deepEqual(f.err, [
      'mc: the check names Martin — a check is a command the last step runs, never a person\n',
      'mc: the check names by hand — a check is a command the last step runs, never a person\n',
    ]);
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('criterion add with a dependency in prose is refused, exit 1, in the text or the check', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs --on-project x', '--check', 'npm test'], f.deps), 1);
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.', '--check', 'npm test --on-project x'], f.deps), 1);
    assert.deepEqual(f.err, [
      'mc: a dependency goes in mc project step add … --after <repo>:<project>\n',
      'mc: a dependency goes in mc project step add … --after <repo>:<project>\n',
    ]);
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('criterion add with the same text twice is refused, exit 1, and names the first', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.', '--check', 'npm test'], f.deps), 0);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.', '--check', 'node --test'], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: alpha has that criterion already (1)\n');
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('criterion add to a project mc does not hold is refused, exit 1', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(['criterion', 'add', 'nope', 'It runs.', '--check', 'npm test'], f.deps), 1);
    assert.equal(f.err.join(''), `mc: no project nope under ${f.home}\n`);
  } finally { f.cleanup(); }
});

test('criterion add given a flag it does not take, or without its text, is usage, exit 2', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.', '--check', 'npm test', '--goal', 'x'], f.deps), 2);
    assert.equal(f.err.at(-1), 'mc: criterion add takes no --goal\n');
    assert.equal(await run(['criterion', 'add', 'alpha', '--check', 'npm test'], f.deps), 2);
    assert.match(f.err.at(-1), /^usage/u);
    assert.deepEqual(JSON.parse(readFileSync(f.draft('alpha'), 'utf8')).success_criteria, []);
  } finally { f.cleanup(); }
});

/** A draft with one criterion, so the next verb a step add names is `mc project send`. */
async function draftWithCriterion(f) {
  assert.equal(await run(NEW, f.deps), 0);
  assert.equal(await run(['criterion', 'add', 'alpha', 'It runs.', '--check', 'npm test'], f.deps), 0);
  f.out.length = 0;
}

/** A markdown instruction file in the temp home, written with the text given. */
function instructionFile(f, text = 'Do the thing.\n\nThen test it.\n') {
  const path = join(f.home, 'instruction.md');
  writeFileSync(path, text);
  return path;
}

const STEP = ['step', 'add', 'alpha', 'One', '--model', 'haiku', '--done-when', 'It runs.'];

test('step add appends a ready step to a draft, its paragraphs from the file, and names the send next', async () => {
  const f = draftFixture();
  try {
    await draftWithCriterion(f);
    assert.equal(await run([...STEP, '--instruction-file', instructionFile(f)], f.deps), 0);
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    assert.deepEqual(plan.steps, [{
      title: 'One', status: 'ready', done_when: 'It runs.', instruction: ['Do the thing.', 'Then test it.'], runner: { model: 'haiku' },
    }]);
    assert.deepEqual(draftProblems(plan), []);
    assert.deepEqual(f.out, ['mc: alpha step 1 — One (haiku)\n', 'next: mc project send alpha\n']);
    assert.equal(f.err.length, 0);
  } finally { f.cleanup(); }
});

test('step add to a draft with no criterion yet prints no send line', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    f.out.length = 0;
    assert.equal(await run([...STEP, '--instruction-file', instructionFile(f)], f.deps), 0);
    assert.deepEqual(f.out, ['mc: alpha step 1 — One (haiku)\n']);
  } finally { f.cleanup(); }
});

test('step add --effort lands in the step\'s runner, beside its model', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    f.out.length = 0;
    assert.equal(await run([...STEP, '--effort', 'high', '--instruction-file', instructionFile(f)], f.deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(f.draft('alpha'), 'utf8')).steps[0].runner, { model: 'haiku', effort: 'high' });
    assert.deepEqual(f.out, ['mc: alpha step 1 — One (haiku, high)\n']);
  } finally { f.cleanup(); }
});

test('step add without --model, with a model that is not haiku or opus, or missing a flag, is refused, exit 2, and the draft is untouched', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    const md = instructionFile(f);
    const cases = [
      [['step', 'add', 'alpha', 'One', '--done-when', 'It runs.', '--instruction-file', md], /a step names --model haiku or opus \(ruling 42\) — no default/u],
      [['step', 'add', 'alpha', 'One', '--model', 'sonnet', '--done-when', 'It runs.', '--instruction-file', md], /a step names --model haiku or opus/u],
      [['step', 'add', 'alpha', 'One', '--model', 'haiku', '--instruction-file', md], /a step needs --done-when/u],
      [['step', 'add', 'alpha', 'One', '--model', 'haiku', '--done-when', 'It runs.'], /a step needs --instruction-file/u],
      [[...STEP, '--instruction-file', join(f.home, 'missing.md')], /cannot read /u],
      [[...STEP, '--effort', 'extreme', '--instruction-file', md], /--effort extreme is not one of low, medium, high, xhigh, max/u],
      [[...STEP, '--after', 'other', '--instruction-file', md], /--after is <repo>:<project> — other is not/u],
      [[...STEP, '--after', 'memoro:other', '--instruction-file', md], /memoro is not a repository mc knows/u],
      [[...STEP, '--after', 'memoro-cli:Bad_Name', '--instruction-file', md], /Bad_Name is not a project name/u],
      [[...STEP, '--check', 'npm test', '--instruction-file', md], /step add takes no --check/u],
    ];
    for (const [argv, message] of cases) {
      assert.equal(await run(argv, f.deps), 2, argv.join(' '));
      assert.match(f.err.at(-1), message);
    }
    assert.deepEqual(JSON.parse(readFileSync(f.draft('alpha'), 'utf8')).steps, []);
  } finally { f.cleanup(); }
});

test('step add whose done-when names a person, or whose instruction or done-when names a dependency, is refused, exit 1', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    const md = instructionFile(f);
    assert.equal(await run(['step', 'add', 'alpha', 'One', '--model', 'haiku', '--done-when', 'Martin approves', '--instruction-file', md], f.deps), 1);
    assert.equal(await run(['step', 'add', 'alpha', 'One', '--model', 'haiku', '--done-when', 'mc step blocked --on-project x', '--instruction-file', md], f.deps), 1);
    assert.equal(await run([...STEP, '--instruction-file', instructionFile(f, 'Do it.\n\nmc step blocked --on-project x\n')], f.deps), 1);
    assert.deepEqual(f.err, [
      'mc: --done-when names Martin — a step ends on a check, never on a person\n',
      'mc: a dependency goes in --after <repo>:<project>\n',
      'mc: a dependency goes in --after <repo>:<project>\n',
    ]);
    assert.deepEqual(JSON.parse(readFileSync(f.draft('alpha'), 'utf8')).steps, []);
  } finally { f.cleanup(); }
});

test('step add from an instruction file with no paragraph is refused, exit 1', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    const path = instructionFile(f, '\n\n   \n');
    assert.equal(await run([...STEP, '--instruction-file', path], f.deps), 1);
    assert.equal(f.err.join(''), `mc: ${path} has no paragraph\n`);
  } finally { f.cleanup(); }
});

test('step add --after a project deps.programs holds blocks the step on it, as a project blocker', async () => {
  const f = draftFixture();
  try {
    f.deps.programs = () => [{ project: 'other', repo: 'memoro-cli' }];
    await draftWithCriterion(f);
    assert.equal(await run([...STEP, '--after', 'memoro-cli:other', '--instruction-file', instructionFile(f)], f.deps), 0);
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    assert.equal(plan.steps[0].status, 'blocked');
    assert.deepEqual(plan.steps[0].blocked_by, { kind: 'project', name: 'other' });
    assert.deepEqual(draftProblems(plan), []);
    assert.deepEqual(f.out, ['mc: alpha step 1 — One (haiku)\n', '  waits for memoro-cli:other\n', 'next: mc project send alpha\n']);
  } finally { f.cleanup(); }
});

test('step add --after a project only deps.listArchived holds blocks the step on it', async () => {
  const f = draftFixture({ listArchived: () => ['other'] });
  try {
    assert.equal(await run(NEW, f.deps), 0);
    assert.equal(await run([...STEP, '--after', 'memoro-cli:other', '--instruction-file', instructionFile(f)], f.deps), 0);
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    assert.equal(plan.steps[0].status, 'blocked');
    assert.deepEqual(plan.steps[0].blocked_by, { kind: 'project', name: 'other' });
  } finally { f.cleanup(); }
});

test('step add --after a project mc does not know is refused, exit 1, and the draft is untouched', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    assert.equal(await run([...STEP, '--after', 'memoro-cli:other', '--instruction-file', instructionFile(f)], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: memoro-cli:other is not a project mc knows — not under ~/mc/programs/, not on memoro-cli\'s origin/main, not archived\n');
    assert.deepEqual(JSON.parse(readFileSync(f.draft('alpha'), 'utf8')).steps, []);
  } finally { f.cleanup(); }
});

test('step add --after this project is refused, exit 1', async () => {
  const f = draftFixture();
  try {
    assert.equal(await run(NEW, f.deps), 0);
    assert.equal(await run([...STEP, '--after', 'memoro-cli:alpha', '--instruction-file', instructionFile(f)], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: alpha cannot wait on itself\n');
  } finally { f.cleanup(); }
});

test('step add with a title whose key another step has is refused, exit 1, and names that step', async () => {
  const f = draftFixture();
  try {
    await draftWithCriterion(f);
    const md = instructionFile(f);
    assert.equal(await run([...STEP, '--instruction-file', md], f.deps), 0);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run([...STEP, '--instruction-file', md], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: step 1 is called that already\n');
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('step add to a sent plan appends after the others, and the plan still reads', async () => {
  const f = draftFixture();
  try {
    const dir = join(f.home, 'mc', 'sent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PLAN.json'), `${JSON.stringify({ ...JSON.parse(repoPlan('sent')), repo: 'memoro-cli' }, null, 2)}\n`);
    assert.equal(await run(['step', 'add', 'sent', 'Two', '--model', 'opus', '--done-when', 'It runs.', '--instruction-file', instructionFile(f)], f.deps), 0);
    const text = readFileSync(join(dir, 'PLAN.json'), 'utf8');
    assert.deepEqual(readPlanText(text).problems, []);
    const written = JSON.parse(text);
    assert.deepEqual(written.steps.map((step) => step.title), ['One', 'Two']);
    assert.deepEqual(written.steps[1], {
      title: 'Two', status: 'ready', done_when: 'It runs.', instruction: ['Do the thing.', 'Then test it.'], runner: { model: 'opus' },
    });
    assert.deepEqual(f.out, ['mc: sent step 2 — Two (opus)\n']);
  } finally { f.cleanup(); }
});

/** A draft with one criterion and one step, `One`, so a step edit has a step to change. */
async function draftWithStep(f) {
  await draftWithCriterion(f);
  assert.equal(await run([...STEP, '--instruction-file', instructionFile(f)], f.deps), 0);
  f.out.length = 0;
}

/**
 * A sent plan, `sent`, in the temp home with one step, `One`, and the register
 * at `f.deps.root` holding `steps` for it. `steps` null is no register entry at
 * all, which is a plan the runner has not seen. Returns the plan file's path.
 */
function sentStep(f, steps) {
  const dir = join(f.home, 'mc', 'sent');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'PLAN.json');
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(repoPlan('sent')), repo: 'memoro-cli' }, null, 2)}\n`);
  const root = join(f.home, 'work');
  const path = registerPath(root, 'sent');
  const text = steps === null ? null : JSON.stringify({ project: 'sent', repo: 'memoro-cli', steps, criteria: [] });
  Object.assign(f.deps, { root, read: (p) => (p === path ? text : null) });
  return file;
}

test('step edit changes a draft step\'s model and done-when, keeps the rest of its runner, and names the fields', async () => {
  const f = draftFixture();
  try {
    await draftWithCriterion(f);
    assert.equal(await run([...STEP, '--effort', 'high', '--instruction-file', instructionFile(f)], f.deps), 0);
    f.out.length = 0;
    assert.equal(await run(['step', 'edit', 'alpha', '1', '--model', 'opus', '--done-when', 'It is tested.'], f.deps), 0);
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    assert.deepEqual(plan.steps, [{
      title: 'One', status: 'ready', done_when: 'It is tested.', instruction: ['Do the thing.', 'Then test it.'], runner: { model: 'opus', effort: 'high' },
    }]);
    assert.deepEqual(draftProblems(plan), []);
    assert.deepEqual(f.out, ['mc: alpha step 1 — model, done_when\n']);
    assert.equal(f.err.length, 0);
  } finally { f.cleanup(); }
});

test('step edit changes a draft step\'s title and instruction, and leaves its runner', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    const md = instructionFile(f, 'Rewrite it.\n\nThen run it.\n');
    assert.equal(await run(['step', 'edit', 'alpha', '1', '--title', 'Renamed', '--instruction-file', md], f.deps), 0);
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    assert.equal(plan.steps[0].title, 'Renamed');
    assert.deepEqual(plan.steps[0].instruction, ['Rewrite it.', 'Then run it.']);
    assert.deepEqual(plan.steps[0].runner, { model: 'haiku' });
    assert.deepEqual(f.out, ['mc: alpha step 1 — title, instruction\n']);
  } finally { f.cleanup(); }
});

test('step edit with a title whose key another step has is refused, exit 1, and the draft is untouched', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    assert.equal(await run(['step', 'add', 'alpha', 'Two', '--model', 'opus', '--done-when', 'It runs.', '--instruction-file', instructionFile(f)], f.deps), 0);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['step', 'edit', 'alpha', '2', '--title', 'One'], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: step 1 is called that already\n');
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('step edit on a sent plan\'s step the register holds as ready changes it, and the plan still reads', async () => {
  const f = draftFixture();
  try {
    const file = sentStep(f, [{ key: 'One', status: 'ready' }]);
    assert.equal(await run(['step', 'edit', 'sent', '1', '--done-when', 'It is tested.'], f.deps), 0);
    const text = readFileSync(file, 'utf8');
    assert.deepEqual(readPlanText(text).problems, []);
    assert.equal(JSON.parse(text).steps[0].done_when, 'It is tested.');
    assert.deepEqual(f.out, ['mc: sent step 1 — done_when\n']);
  } finally { f.cleanup(); }
});

test('step edit on a sent plan with no register entry is a plan the runner has not seen, and is editable', async () => {
  const f = draftFixture();
  try {
    const file = sentStep(f, null);
    assert.equal(await run(['step', 'edit', 'sent', '1', '--model', 'opus'], f.deps), 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).steps[0].runner.model, 'opus');
  } finally { f.cleanup(); }
});

test('step edit on a sent plan\'s step that has started is refused, exit 1, and the plan is untouched', async () => {
  const f = draftFixture();
  try {
    for (const state of [{ key: 'One', status: 'running' }, { key: 'One', status: 'done', pr: 7 }, { key: 'One', status: 'ready', pr: 12 }]) {
      const file = sentStep(f, [state]);
      const before = readFileSync(file, 'utf8');
      f.err.length = 0;
      assert.equal(await run(['step', 'edit', 'sent', '1', '--model', 'opus'], f.deps), 1);
      assert.match(f.err.join(''), /^mc: step 1 of sent is (running|done \(PR #7\)|ready \(PR #12\)) — a step that has started is frozen\n$/u);
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  } finally { f.cleanup(); }
});

test('step edit with a step number out of range, no field, or a model that is not haiku or opus is usage, exit 2', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['step', 'edit', 'alpha', '0', '--model', 'opus'], f.deps), 2);
    assert.match(f.err.at(-1), /^mc: 0 is not a step number — 1 is the plan's first\n$/u);
    assert.equal(await run(['step', 'edit', 'alpha', '2', '--model', 'opus'], f.deps), 2);
    assert.equal(f.err.at(-1), 'mc: alpha has 1 step — step 2 is not one\n');
    assert.equal(await run(['step', 'edit', 'alpha', '1'], f.deps), 2);
    assert.match(f.err.at(-1), /^mc: step edit needs --title, --model, --effort, --done-when or --instruction-file\n$/u);
    assert.equal(await run(['step', 'edit', 'alpha', '1', '--model', 'sonnet'], f.deps), 2);
    assert.match(f.err.at(-1), /a step names --model haiku or opus \(ruling 42\) — no default/u);
    assert.equal(await run(['step', 'edit', 'alpha', '1', '--after', 'memoro-cli:other', '--model', 'opus'], f.deps), 2);
    assert.equal(f.err.at(-1), 'mc: step edit takes no --after\n');
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('step edit whose done-when names a person or a dependency, or whose instruction file is missing, is refused and the draft is untouched', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    const before = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['step', 'edit', 'alpha', '1', '--done-when', 'by hand'], f.deps), 1);
    assert.equal(await run(['step', 'edit', 'alpha', '1', '--done-when', 'mc step blocked --on-project x'], f.deps), 1);
    assert.equal(await run(['step', 'edit', 'alpha', '1', '--done-when', '   '], f.deps), 2);
    assert.equal(await run(['step', 'edit', 'alpha', '1', '--instruction-file', join(f.home, 'missing.md')], f.deps), 2);
    assert.deepEqual(f.err, [
      'mc: --done-when names by hand — a step ends on a check, never on a person\n',
      'mc: a dependency goes in --after <repo>:<project>\n',
      'mc: a step needs --done-when "<check>" — when it is finished\n',
      `mc: cannot read ${join(f.home, 'missing.md')}\n`,
    ]);
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('send renames a complete draft to PLAN.json byte for byte, and says the runner takes step 1', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    const draft = readFileSync(f.draft('alpha'), 'utf8');
    const plan = join(f.home, 'mc', 'alpha', 'PLAN.json');
    assert.equal(await run(['send', 'alpha'], f.deps), 0);
    assert.equal(existsSync(f.draft('alpha')), false);
    assert.equal(readFileSync(plan, 'utf8'), draft);
    assert.deepEqual(f.out, [`mc: alpha sent — ${plan}\n`, 'the runner takes step 1 on its next pass\n']);
  } finally { f.cleanup(); }
});

test('send of a draft whose first step waits on a project says what it waits for, and moves the draft', async () => {
  const f = draftFixture();
  try {
    f.deps.programs = () => [{ project: 'other', repo: 'memoro-cli' }];
    await draftWithCriterion(f);
    assert.equal(await run([...STEP, '--after', 'memoro-cli:other', '--instruction-file', instructionFile(f)], f.deps), 0);
    f.out.length = 0;
    assert.equal(await run(['send', 'alpha'], f.deps), 0);
    assert.deepEqual(f.out, [`mc: alpha sent — ${join(f.home, 'mc', 'alpha', 'PLAN.json')}\n`, 'step 1 waits: project other\n']);
    assert.equal(existsSync(f.draft('alpha')), false);
  } finally { f.cleanup(); }
});

test('send refuses a draft with no step, names the problem, and moves nothing, exit 1', async () => {
  const f = draftFixture();
  try {
    await draftWithCriterion(f);
    const draft = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['send', 'alpha'], f.deps), 1);
    assert.match(f.err.join(''), /^mc: alpha is not sent:\n {2}steps: [^\n]+\n$/u);
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), draft);
    assert.equal(existsSync(join(f.home, 'mc', 'alpha', 'PLAN.json')), false);
    assert.equal(f.out.length, 0);
  } finally { f.cleanup(); }
});

test('send refuses a plan that names a model for itself, or a step model that is not haiku or opus, exit 1', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    const plan = JSON.parse(readFileSync(f.draft('alpha'), 'utf8'));
    plan.runner = { model: 'haiku' };
    writeFileSync(f.draft('alpha'), `${JSON.stringify(plan, null, 2)}\n`);
    assert.equal(await run(['send', 'alpha'], f.deps), 1);
    assert.match(f.err.join(''), /runner\.model: a plan names no model/u);
    f.err.length = 0;
    delete plan.runner;
    plan.steps[0].runner.model = 'sonnet';
    writeFileSync(f.draft('alpha'), `${JSON.stringify(plan, null, 2)}\n`);
    assert.equal(await run(['send', 'alpha'], f.deps), 1);
    assert.match(f.err.join(''), /steps\[1\]\.runner\.model: haiku or opus/u);
    assert.equal(existsSync(join(f.home, 'mc', 'alpha', 'PLAN.json')), false);
  } finally { f.cleanup(); }
});

test('send of a project already sent, or of a name mc does not hold, is refused, exit 1, and writes nothing', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    assert.equal(await run(['send', 'alpha'], f.deps), 0);
    f.out.length = 0;
    assert.equal(await run(['send', 'alpha'], f.deps), 1);
    assert.equal(f.err.at(-1), `mc: alpha is sent already — ${join(f.home, 'mc', 'alpha', 'PLAN.json')}\n`);
    assert.equal(await run(['send', 'nope'], f.deps), 1);
    assert.equal(f.err.at(-1), `mc: no project nope under ${f.home}\n`);
    assert.equal(f.out.length, 0);
  } finally { f.cleanup(); }
});

test('send given a flag, or with no project, is usage, exit 2, and the draft is untouched', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    const draft = readFileSync(f.draft('alpha'), 'utf8');
    assert.equal(await run(['send', 'alpha', '--json'], f.deps), 2);
    assert.equal(f.err.join(''), 'mc: send takes no --json\n');
    assert.equal(await run(['send'], f.deps), 2);
    assert.match(f.err.at(-1), /^usage/u);
    assert.equal(readFileSync(f.draft('alpha'), 'utf8'), draft);
  } finally { f.cleanup(); }
});

test('mc project <draft> prints the draft as it stands, and the send that would take it, exit 0', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    assert.equal(await run(['alpha'], f.deps), 0);
    assert.deepEqual(f.out, [
      'alpha — draft · memoro-cli · mc\n',
      `  file   ${f.draft('alpha')}\n`,
      '\n',
      'It runs.\n',
      '\n',
      'CRITERIA\n',
      '  1  It runs.\n',
      '\n',
      'STEPS\n',
      '  1  One  haiku\n',
      '\n',
      'send: mc project send alpha\n',
    ]);
  } finally { f.cleanup(); }
});

test('mc project <draft> that send would refuse says what, and names no send, exit 0', async () => {
  const f = draftFixture();
  try {
    await draftWithCriterion(f);
    assert.equal(await run(['alpha'], f.deps), 0);
    const text = f.out.join('');
    assert.match(text, /\nsend would refuse:\n {2}steps: [^\n]+\n$/u);
    assert.doesNotMatch(text, /send: mc project send/u);
  } finally { f.cleanup(); }
});

test('mc project <draft> shows a step waiting on another project, and send names the same wait', async () => {
  const f = draftFixture();
  try {
    f.deps.programs = () => [{ project: 'other', repo: 'memoro-cli' }];
    await draftWithCriterion(f);
    assert.equal(await run([...STEP, '--after', 'memoro-cli:other', '--instruction-file', instructionFile(f)], f.deps), 0);
    f.out.length = 0;
    assert.equal(await run(['alpha'], f.deps), 0);
    assert.match(f.out.join(''), /\n {2}1 {2}One {2}haiku\n {2}waits for other\n/u);
    assert.equal(f.out.at(-1), 'send: mc project send alpha\n');
  } finally { f.cleanup(); }
});

test('mc project <draft> given --json or --offline, or a flag of its own, is refused, exit 2; with no name it is usage', async () => {
  const f = draftFixture();
  try {
    await draftWithStep(f);
    assert.equal(await run(['alpha', '--json'], f.deps), 2);
    assert.equal(f.err.at(-1), 'mc: alpha is a draft — it has no --json\n');
    assert.equal(await run(['alpha', '--offline'], f.deps), 2);
    assert.equal(f.err.at(-1), 'mc: alpha is a draft — it has no --offline\n');
    assert.equal(await run(['alpha', '--repo', 'memoro-cli'], f.deps), 2);
    assert.equal(f.err.at(-1), 'mc: alpha takes no --repo\n');
    assert.equal(await run([], f.deps), 2);
    assert.match(f.err.at(-1), /^usage/u);
    assert.equal(f.out.length, 0);
  } finally { f.cleanup(); }
});

test('mc project <name> for a sent plan, or a name with no plan here, is mc status <name>, with --json and --offline passed on, and its exit code returned', async () => {
  const f = draftFixture();
  try {
    sentStep(f, [{ key: 'One', status: 'ready' }]);
    const calls = [];
    const deps = { ...f.deps, statusProject: async (argv) => { calls.push(argv); return 3; } };
    assert.equal(await run(['sent'], deps), 3);
    assert.equal(await run(['sent', '--json', '--offline'], deps), 3);
    assert.equal(await run(['mc-status'], deps), 3);
    assert.deepEqual(calls, [['sent'], ['sent', '--json', '--offline'], ['mc-status']]);
    assert.equal(f.out.length, 0);
  } finally { f.cleanup(); }
});

/** The project log as origin/main holds it: its header, and no row for any project. */
const ARCHIVE_LOG = '# Project log\n\n| date | programme | project | outcome | summary | doc | pointer |\n|---|---|---|---|---|---|---|\n';
const ARCHIVE_DONE = [{ key: 'One', status: 'done' }];
const ARCHIVE_MET = [{ criterion: 'It runs.', met: true, at: '2026-10-19T10:00:00Z' }];

/**
 * A temp home for `archive`: `alpha` under `mc/` as `file` (PLAN.json unless a
 * case says DRAFT.json), its register at `work/` when `steps` is given, and a
 * step area under `work/step/alpha/` when `area` is set. git, gh and the docs
 * merge are fakes that record their calls; the file system is real.
 */
function archiveFixture({ file = 'PLAN.json', steps = null, criteria = [], closeout = false, area = false, dirty = '' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mc-archive-'));
  const work = join(home, 'work');
  const dir = join(home, 'mc', 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `${JSON.stringify({ ...JSON.parse(repoPlan('alpha')), repo: 'memoro-cli' }, null, 2)}\n`);
  if (closeout) writeFileSync(join(dir, 'CLOSEOUT.json'), '{}\n');
  if (steps) {
    mkdirSync(join(registerPath(work, 'alpha'), '..'), { recursive: true });
    writeFileSync(registerPath(work, 'alpha'), JSON.stringify({ project: 'alpha', repo: 'memoro-cli', steps, criteria }));
  }
  if (area) {
    mkdirSync(join(work, 'step', 'alpha', 'memoro-cli', '.git'), { recursive: true });
    writeFileSync(join(work, 'step', 'alpha', 'notes.txt'), 'kept\n');
  }
  const calls = []; const landed = []; const out = []; const err = [];
  const git = (cwd, args) => {
    calls.push([cwd, ...args]);
    if (args[0] === 'show') return { ok: true, stdout: ARCHIVE_LOG, stderr: '' };
    if (args[0] === 'status') return { ok: true, stdout: dirty, stderr: '' };
    if (args[0] === 'remote') return { ok: false, stdout: '', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'add') {
      mkdirSync(join(args[4], 'docs', 'project'), { recursive: true });
      writeFileSync(join(args[4], 'docs', 'project', 'project_log.md'), ARCHIVE_LOG);
    }
    if (args[0] === 'worktree' && args[1] === 'remove') rmSync(args.at(-1), { recursive: true, force: true });
    return { ok: true, stdout: '', stderr: '' };
  };
  const gh = (_cwd, args) => ({
    ok: true, stderr: '', stdout: args[1] === 'create' ? 'https://github.com/memoro/memoro-cli/pull/7\n' : '',
  });
  const docsMerge = async ({ repoPath, pr }) => {
    landed.push({ pr, text: readFileSync(join(repoPath, 'docs', 'project', 'project_log.md'), 'utf8') });
    return { ok: true, merged: true, merged_into: 'main', stopped_at: null, reason: null };
  };
  const deps = {
    env: { MC_WORK_ROOT: work }, root: work, home, repos: [{ name: 'memoro-cli', path: join(home, 'memoro-cli') }],
    now: () => new Date('2026-10-20T10:00:00Z'), git, gh, docsMerge, tmuxHas: () => false,
    stopServers: () => ({ stopped: [], failed: [] }),
    stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) },
  };
  return {
    deps, out, err, calls, landed, work, dir,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('archive refuses a draft, saying discard removes it, and writes nothing', async () => {
  const f = archiveFixture({ file: 'DRAFT.json' });
  try {
    assert.equal(await run(['archive', 'alpha'], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: alpha is a draft — mc project discard alpha removes it\n');
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(join(f.dir, 'CLOSEOUT.json')), false);
  } finally { f.cleanup(); }
});

test('archive refuses a project mc does not hold, and writes nothing', async () => {
  const f = archiveFixture();
  try {
    assert.equal(await run(['archive', 'nope'], f.deps), 1);
    assert.match(f.err.join(''), /^mc: nope is not a project under ~\/mc\/programs\/\n$/u);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('archive refuses a project already archived, and leaves its closeout as it was', async () => {
  const f = archiveFixture({ steps: ARCHIVE_DONE, criteria: ARCHIVE_MET, closeout: true });
  try {
    assert.equal(await run(['archive', 'alpha'], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: alpha is already archived\n');
    assert.equal(readFileSync(join(f.dir, 'CLOSEOUT.json'), 'utf8'), '{}\n');
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('archive refuses a project whose register is not done, and writes nothing', async () => {
  const f = archiveFixture({ steps: [{ key: 'One', status: 'running' }], criteria: [{ criterion: 'It runs.', met: false, at: null }] });
  try {
    assert.equal(await run(['archive', 'alpha'], f.deps), 1);
    assert.match(f.err.join(''), /^mc: alpha is \w+ — only a done project is archived; mc project discard alpha removes it\n$/u);
    assert.equal(existsSync(join(f.dir, 'CLOSEOUT.json')), false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.landed.length, 0);
  } finally { f.cleanup(); }
});

test('archive of a done project writes its row through a docs-only pull request, its CLOSEOUT.json, and closes its step area', async () => {
  const f = archiveFixture({ steps: ARCHIVE_DONE, criteria: ARCHIVE_MET, area: true });
  try {
    assert.equal(await run(['archive', 'alpha'], f.deps), 0);
    assert.equal(f.landed.length, 1);
    assert.equal(f.landed[0].pr, 7);
    assert.match(f.landed[0].text, /^\|\s*2026-10-20\s*\|\s*mc\s*\|\s*alpha\s*\|\s*delivered\s*\|/mu);
    assert.ok(existsSync(join(f.dir, 'CLOSEOUT.json')));
    assert.match(f.out.join(''), /^mc: alpha archived\n/mu);
    assert.equal(existsSync(join(f.work, 'step', 'alpha')), false);
    assert.equal(readFileSync(join(f.work, 'runner', 'log', 'closed', 'alpha', 'notes.txt'), 'utf8'), 'kept\n');
    assert.ok(f.calls.some((c) => c[1] === 'worktree' && c[2] === 'remove' && c.at(-1) === join(f.work, 'step', 'alpha', 'memoro-cli')));
    assert.ok(f.calls.some((c) => c[1] === 'branch' && c.at(-1) === 'alpha'));
  } finally { f.cleanup(); }
});

test('archive of a done project with a dirty step area archives it, keeps the area, and says why', async () => {
  const f = archiveFixture({ steps: ARCHIVE_DONE, criteria: ARCHIVE_MET, area: true, dirty: ' M notes.txt\n' });
  try {
    assert.equal(await run(['archive', 'alpha'], f.deps), 0);
    assert.ok(existsSync(join(f.dir, 'CLOSEOUT.json')));
    assert.match(f.out.join(''), /mc: alpha archived; its step area stays — an uncommitted change\n$/u);
    assert.ok(existsSync(join(f.work, 'step', 'alpha', 'memoro-cli', '.git')));
    assert.ok(existsSync(join(f.work, 'step', 'alpha', 'notes.txt')));
    assert.equal(f.calls.some((c) => c[1] === 'worktree' && c[2] === 'remove' && c.at(-1) === join(f.work, 'step', 'alpha', 'memoro-cli')), false);
  } finally { f.cleanup(); }
});

/**
 * A scratch work root for `discard`: `alpha` under `programs/mc/` as DRAFT.json or
 * PLAN.json, its register when `steps` is given, its step area when `area` is set.
 * gh, the area's discard and tmux are fakes that record their calls; the file
 * system is real.
 */
function discardFixture({ file = 'PLAN.json', steps = null, closeout = false, area = false, pulls = [], closeFails = null, live = false, inUse = false, waiting = [] } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'mc-discard-'));
  const home = join(work, 'programs');
  const dir = join(home, 'mc', 'alpha');
  const repo = join(work, 'memoro-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `${JSON.stringify({ ...JSON.parse(repoPlan('alpha')), repo: 'memoro-cli' }, null, 2)}\n`);
  if (closeout) writeFileSync(join(dir, 'CLOSEOUT.json'), '{}\n');
  if (steps) {
    mkdirSync(join(registerPath(work, 'alpha'), '..'), { recursive: true });
    writeFileSync(registerPath(work, 'alpha'), JSON.stringify({ project: 'alpha', repo: 'memoro-cli', steps, criteria: [] }));
  }
  const worktree = join(work, 'step', 'alpha', 'memoro-cli');
  if (area) mkdirSync(worktree, { recursive: true });
  const calls = []; const out = []; const err = [];
  const gh = (cwd, args) => {
    calls.push(['gh', cwd, ...args]);
    if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(pulls), stderr: '' };
    const failed = args[2] === closeFails;
    return { ok: !failed, stdout: '', stderr: failed ? 'no such pull request\n' : '' };
  };
  const discardArea = (name, { dryRun }) => {
    calls.push(['area', name, dryRun]);
    if (!dryRun) rmSync(join(work, name), { recursive: true, force: true });
    const kept = inUse ? [{ path: worktree, branch: 'alpha', why: 'in use by node' }] : [];
    return { discarded: inUse ? [] : [{ path: worktree, branch: 'alpha' }], kept, removes_area: kept.length === 0, dry_run: dryRun };
  };
  const deps = {
    env: { MC_WORK_ROOT: work }, root: work, home, repos: [{ name: 'memoro-cli', path: repo }],
    gh, discardArea, tmuxHas: () => live, programs: () => waiting,
    stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) },
  };
  return {
    deps, out, err, calls, work, dir, repo,
    register: registerPath(work, 'alpha'), area: join(work, 'step', 'alpha'),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

test('discard of a draft lists its directory and writes nothing without --apply', async () => {
  const f = discardFixture({ file: 'DRAFT.json' });
  try {
    assert.equal(await run(['discard', 'alpha'], f.deps), 0);
    assert.equal(f.out.join(''), `  would remove ${f.dir}\nmc project discard alpha --apply to remove them\n`);
    assert.equal(existsSync(join(f.dir, 'DRAFT.json')), true);
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});

test('discard --apply of a draft removes its directory, and runs no gh', async () => {
  const f = discardFixture({ file: 'DRAFT.json' });
  try {
    assert.equal(await run(['discard', 'alpha', '--apply'], f.deps), 0);
    assert.equal(existsSync(f.dir), false);
    assert.deepEqual(f.calls, []);
    assert.equal(f.out.join(''), `  removed ${f.dir}\nmc: alpha discarded\n`);
  } finally { f.cleanup(); }
});

test('discard --apply of a sent plan closes its pull request named <project>-2, then discards its area, register file and directory', async () => {
  const f = discardFixture({
    steps: [{ key: 'One', status: 'done', pr: 2 }],
    area: true,
    pulls: [{ number: 2, headRefName: 'alpha-2' }, { number: 5, headRefName: 'alpha-extra' }, { number: 9, headRefName: 'other' }],
  });
  try {
    assert.equal(await run(['discard', 'alpha', '--apply'], f.deps), 0);
    assert.deepEqual(f.calls, [
      ['gh', f.repo, 'pr', 'list', '--state', 'open', '--json', 'number,headRefName'],
      ['area', 'step/alpha', true],
      ['gh', f.repo, 'pr', 'close', '2', '--delete-branch', '--comment', 'Discarded with mc project discard.'],
      ['area', 'step/alpha', false],
    ]);
    assert.equal(existsSync(f.register), false);
    assert.equal(existsSync(f.area), false);
    assert.equal(existsSync(f.dir), false);
    assert.deepEqual(f.out, [
      '  removed pull request #2 (branch alpha-2)\n',
      `  removed ${join(f.work, 'step', 'alpha', 'memoro-cli')} (branch alpha)\n`,
      `  removed ${f.area}\n`,
      `  removed ${f.register}\n`,
      `  removed ${f.dir}\n`,
      'mc: alpha discarded\n',
    ]);
    assert.equal(f.err.length, 0);
  } finally { f.cleanup(); }
});

test('a pull request that will not close is printed to stderr, and the rest is still discarded', async () => {
  const f = discardFixture({ steps: [{ key: 'One', status: 'done', pr: 2 }], pulls: [{ number: 2, headRefName: 'alpha-2' }], closeFails: '2' });
  try {
    assert.equal(await run(['discard', 'alpha', '--apply'], f.deps), 0);
    assert.equal(f.err.join(''), 'mc: could not close pull request #2 — no such pull request\n');
    assert.equal(existsSync(f.register), false);
    assert.equal(existsSync(f.dir), false);
  } finally { f.cleanup(); }
});

test('discard --apply of a sent plan whose step is running is refused, exit 1, and removes nothing', async () => {
  const f = discardFixture({ steps: [{ key: 'One', status: 'running' }], area: true, pulls: [{ number: 2, headRefName: 'alpha-2' }] });
  try {
    assert.equal(await run(['discard', 'alpha', '--apply'], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: alpha step 1 is running — wait for it, or mc step failed it first\n');
    assert.equal(f.out.length, 0);
    assert.equal(existsSync(f.dir), true);
    assert.equal(existsSync(f.register), true);
    assert.equal(existsSync(f.area), true);
    assert.equal(f.calls.some((c) => c[0] === 'gh' && c[3] === 'close'), false);
    assert.equal(f.calls.some((c) => c[0] === 'area' && c[2] === false), false);
  } finally { f.cleanup(); }
});

test('discard --apply with a live session, or a worktree in use, is refused, exit 1, and removes nothing', async () => {
  const live = discardFixture({ steps: [{ key: 'One', status: 'done', pr: 2 }], area: true, live: true });
  const inUse = discardFixture({ steps: [{ key: 'One', status: 'done', pr: 2 }], area: true, inUse: true });
  try {
    assert.equal(await run(['discard', 'alpha', '--apply'], live.deps), 1);
    assert.equal(live.err.join(''), 'mc: alpha has a live session mc-alpha — stop it first\n');
    assert.equal(await run(['discard', 'alpha', '--apply'], inUse.deps), 1);
    assert.equal(inUse.err.join(''), `mc: alpha has a worktree in use — ${join(inUse.work, 'step', 'alpha', 'memoro-cli')} (in use by node)\n`);
    for (const f of [live, inUse]) {
      assert.equal(existsSync(f.dir), true);
      assert.equal(existsSync(f.register), true);
      assert.equal(existsSync(f.area), true);
      assert.equal(f.calls.some((c) => c[0] === 'gh' && c[3] === 'close'), false);
    }
  } finally { live.cleanup(); inUse.cleanup(); }
});

test('discard of an archived project is refused, exit 1, and removes nothing', async () => {
  const f = discardFixture({ steps: [{ key: 'One', status: 'done', pr: 7 }], closeout: true });
  try {
    assert.equal(await run(['discard', 'alpha', '--apply'], f.deps), 1);
    assert.equal(f.err.join(''), 'mc: alpha is archived — archive is the way out it took\n');
    assert.equal(existsSync(f.dir), true);
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});

test('discard names a step of another plan that waits on the project, and does not refuse it', async () => {
  const waiting = [{ project: 'beta', text: JSON.stringify({ steps: [{ title: 'One', blocked_by: { kind: 'project', name: 'alpha' } }, { title: 'Two', blocked_by: { kind: 'project', name: 'gamma' } }] }) }];
  const f = discardFixture({ waiting });
  try {
    assert.equal(await run(['discard', 'alpha'], f.deps), 0);
    assert.ok(f.out.includes('  note: beta step 1 waits on alpha and will wait for ever\n'));
    assert.equal(f.out.some((line) => line.includes('gamma')), false);
    assert.equal(f.err.length, 0);
  } finally { f.cleanup(); }
});

test('discard with no project, or a flag other than --apply, is usage, exit 2; a name mc does not hold is exit 1', async () => {
  const f = discardFixture();
  try {
    assert.equal(await run(['discard'], f.deps), 2);
    assert.match(f.err.at(-1), /^usage/u);
    assert.equal(await run(['discard', 'alpha', '--json'], f.deps), 2);
    assert.match(f.err.at(-1), /^usage/u);
    assert.equal(await run(['discard', 'nope'], f.deps), 1);
    assert.equal(f.err.at(-1), 'mc: nope is not a project under ~/mc/programs/\n');
    assert.equal(existsSync(f.dir), true);
  } finally { f.cleanup(); }
});
