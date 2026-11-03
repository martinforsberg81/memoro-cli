import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run } from '../../src/mc/commands/goal.js';
import { parseGoal, parseLog } from '../../src/mc/goals.js';
import { planGoals, projectSteps } from '../../src/mc/project-convert.js';

const HOME = '/work/programs';
const KNOWN = ['/home/m/memoro-cli.git'];
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const failed = (stderr = '') => ({ ok: false, stdout: '', stderr });

const step = (title, extra = {}) => ({ title, status: 'ready', done_when: `${title} passes`, instruction: [`Do ${title}.`], ...extra });

/** A project of four steps: done, built with #41, ready, blocked on a decision. */
const MIXED_PLAN = {
  schema: 'mc-plan', version: 1, repo: 'memoro-cli',
  goal: ['The queue is fair. And more.'], contract: ['Flags stay.'], out_of_scope: ['The pool.'],
  success_criteria: [{ criterion: 'No refusals', check: 'grep the log', met: false }, { criterion: 'Place told', check: 'a test', met: false }],
  documents: [{ label: 'protocol', path: 'docs/dev.md' }],
  runner: { model: 'large' },
  steps: [step('one'), step('two'), step('three', { runner: { model: 'fast' } }), step('four')],
};
const MIXED_STATE = {
  schema: 'mc-register', version: 1, project: 'mixed',
  steps: [
    { status: 'done', pr: 40, branch: 'mixed-1' },
    { status: 'built', pr: 41, branch: 'mixed-2' },
    { status: 'ready', pr: null, branch: null },
    { status: 'blocked', blocked_by: { kind: 'decision', name: 'which-cap' }, reason: 'Martin decides the cap' },
  ],
  criteria: [{ criterion: 'Place told', met: true }],
};

/** A branch-flow project: two built steps on one branch, its review step ready. */
const FLOW_PLAN = {
  schema: 'mc-plan', version: 1, repo: 'memoro-cli', goal: ['Main stays up. Always.'], contract: [], out_of_scope: [], documents: [],
  success_criteria: [{ criterion: 'Main never evicted', check: 'a test', met: false }],
  steps: [step('alpha'), step('beta'), step('Review the project against its goal', { kind: 'review' })],
};
const FLOW_STATE = {
  steps: [
    { status: 'built', pr: 77, branch: 'flow-2' },
    { status: 'built', pr: 77, branch: 'flow-2' },
    { status: 'ready', pr: null, branch: 'flow-2' },
  ],
};

function listUnder(store, path) {
  const prefix = `${path}/`;
  const names = new Set();
  for (const key of Object.keys(store)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length).split('/');
    if (rest.length > 1) names.add(rest[0]);
  }
  return [...names].sort();
}

/** A fixture programme `mc` under HOME with the projects given, and a git that knows the branches named. */
function fixture(projects, { branches = [], checkedOut = '' } = {}) {
  const store = { [`${HOME}/mc/README.md`]: '' };
  for (const [name, { plan, state }] of Object.entries(projects)) {
    store[`${HOME}/mc/${name}/PLAN.json`] = JSON.stringify(plan);
    if (state) store[`${HOME}/mc/${name}/STATE.json`] = JSON.stringify(state);
  }
  const calls = [];
  const out = [];
  const err = [];
  const git = (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === 'show-ref') {
      const ref = args.at(-1);
      return branches.some((branch) => ref === `refs/heads/${branch}`) ? ok() : failed();
    }
    if (args[0] === 'worktree' && args[1] === 'list') return ok(checkedOut);
    return ok();
  };
  const deps = {
    home: HOME, env: {}, now: () => new Date('2026-11-04T10:00:00Z'),
    stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) },
    read: (path) => store[path] ?? null, write: (path, text) => { store[path] = text; },
    list: (path) => listUnder(store, path), known: () => KNOWN, git,
  };
  const goal = (name) => { const text = store[`${HOME}/mc/goals/${name}/GOAL.json`]; return text ? parseGoal(text) : null; };
  const log = (name) => parseLog(store[`${HOME}/mc/goals/${name}/LOG.md`] ?? '');
  return { deps, store, calls, goal, log, out: () => out.join(''), err: () => err.join('') };
}

test('from-project: a project with done, built, ready and blocked steps becomes three goals chained by after', async () => {
  const f = fixture({ mixed: { plan: MIXED_PLAN, state: MIXED_STATE } }, { branches: ['mixed-2'] });
  const code = await run(['from-project', 'mc/mixed'], f.deps);
  assert.equal(code, 0, f.err());

  assert.equal(f.goal('mixed-1'), null, 'the done step makes no goal');
  const two = f.goal('mixed-2');
  const three = f.goal('mixed-3');
  const four = f.goal('mixed-4');

  assert.equal(two.status, 'review');
  assert.deepEqual(two.prs, [{ repo: 'memoro-cli', pr: 41 }]);
  assert.deepEqual(two.after, []);
  assert.equal(two.title, 'two');
  assert.deepEqual(two.goal, ['Do two.']);
  assert.deepEqual(two.success_criteria, [{ criterion: 'two', check: 'two passes', met: true }]);
  assert.deepEqual(two.contract, ['Flags stay.']);
  assert.deepEqual(two.documents, [{ label: 'protocol', path: 'docs/dev.md' }]);
  assert.equal(two.class, 'large');

  assert.equal(three.status, 'waiting');
  assert.deepEqual(three.after, ['mc/mixed-2']);
  assert.deepEqual(three.prs, []);
  assert.equal(three.class, 'fast');
  assert.deepEqual(three.success_criteria, [{ criterion: 'three', check: 'three passes', met: false }]);

  assert.equal(four.status, 'blocked');
  assert.deepEqual(four.after, ['mc/mixed-3']);
  assert.deepEqual(four.success_criteria, [
    { criterion: 'four', check: 'four passes', met: false },
    { criterion: 'No refusals', check: 'grep the log', met: false },
    { criterion: 'Place told', check: 'a test', met: true },
  ], 'the success criteria go to the last goal, met as the state held them');
  const [first] = f.log('mixed-4');
  assert.equal(first.status, 'blocked');
  assert.match(first.comment, /blocked on decision which-cap — Martin decides the cap/);

  // The built step's worktree takes over its branch; the others are goal/<name> from origin/main.
  const adds = f.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').map((call) => call.args);
  assert.deepEqual(adds[0], ['worktree', 'add', '-q', `${HOME}/mc/goals/mixed-2/memoro-cli`, 'mixed-2']);
  assert.deepEqual(adds[1], ['worktree', 'add', '-q', '-b', 'goal/mixed-3', `${HOME}/mc/goals/mixed-3/memoro-cli`, 'origin/main']);
  assert.match(f.out(), /mc\/mixed-2 · review · mixed-2 · carries memoro-cli#41/);
  assert.match(f.out(), /3 goals made from mc\/mixed/);

  // A second run is refused, and writes nothing.
  const before = JSON.stringify(f.store);
  const again = await run(['from-project', 'mc/mixed'], f.deps);
  assert.equal(again, 1);
  assert.match(f.err(), /is converted already — mc\/mixed-2, mc\/mixed-3, mc\/mixed-4 exist/);
  assert.equal(JSON.stringify(f.store), before);
});

test('from-project: a branch-flow project becomes one goal on the project branch, with every remaining step\'s criteria', async () => {
  const f = fixture({ flow: { plan: FLOW_PLAN, state: FLOW_STATE } }, { branches: ['flow-2'] });
  const code = await run(['from-project', 'mc/flow'], f.deps);
  assert.equal(code, 0, f.err());
  const goal = f.goal('flow');
  assert.equal(goal.status, 'review');
  assert.deepEqual(goal.prs, [{ repo: 'memoro-cli', pr: 77 }]);
  assert.equal(goal.title, 'Main stays up.');
  assert.deepEqual(goal.success_criteria.map((item) => [item.criterion, item.met]), [
    ['alpha', true], ['beta', true], ['Review the project against its goal', false], ['Main never evicted', false],
  ]);
  const add = f.calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  assert.deepEqual(add.args, ['worktree', 'add', '-q', `${HOME}/mc/goals/flow/memoro-cli`, 'flow-2']);
  assert.equal(await run(['from-project', 'mc/flow'], f.deps), 1);
  assert.match(f.err(), /converted already — mc\/flow exists/);
});

test('from-project: a project branch on origin only is checked out as a local branch of that name', async () => {
  const f = fixture({ flow: { plan: FLOW_PLAN, state: FLOW_STATE } });
  f.deps.git = (cwd, args) => {
    f.calls.push({ cwd, args });
    if (args[0] === 'show-ref') return args.at(-1) === 'refs/remotes/origin/flow-2' ? ok() : failed();
    return ok();
  };
  assert.equal(await run(['from-project', 'mc/flow'], f.deps), 0, f.err());
  const add = f.calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  assert.deepEqual(add.args, ['worktree', 'add', '-q', '-b', 'flow-2', `${HOME}/mc/goals/flow/memoro-cli`, 'origin/flow-2']);
});

test('from-project: a branch checked out in another worktree is refused before anything is written', async () => {
  const f = fixture({ flow: { plan: FLOW_PLAN, state: FLOW_STATE } }, { branches: ['flow-2'], checkedOut: 'worktree /x/step-area\nHEAD abc\nbranch refs/heads/flow-2\n' });
  assert.equal(await run(['from-project', 'mc/flow'], f.deps), 1);
  assert.match(f.err(), /flow-2 is checked out in \/x\/step-area/);
  assert.equal(f.goal('flow'), null);
});

test('from-project: a finished project is refused, and so is one that is not there', async () => {
  const done = { ...MIXED_STATE, steps: MIXED_STATE.steps.map((item) => ({ ...item, status: 'done' })) };
  const f = fixture({ finished: { plan: MIXED_PLAN, state: done } });
  assert.equal(await run(['from-project', 'mc/finished'], f.deps), 1);
  assert.match(f.err(), /every step of mc\/finished is done/);
  assert.equal(await run(['from-project', 'mc/nowhere'], f.deps), 1);
  assert.match(f.err(), /no project mc\/nowhere/);
  assert.equal(await run(['from-project', 'nowhere'], f.deps), 2);
});

test('from-project: a step blocked on another project waits on that project\'s last goal, or refuses until it is converted', () => {
  const plan = { ...MIXED_PLAN, steps: [step('one')] };
  const state = { steps: [{ status: 'blocked', blocked_by: { kind: 'project', name: 'other' } }] };
  const now = new Date('2026-11-04T10:00:00Z');
  const waits = planGoals({ programme: 'mc', project: 'p', plan, state, now, waitsOn: () => ({ after: ['mc/other-3'] }) });
  assert.equal(waits.goals[0].goal.status, 'waiting');
  assert.deepEqual(waits.goals[0].goal.after, ['mc/other-3']);
  const refused = planGoals({ programme: 'mc', project: 'p', plan, state, now, waitsOn: () => ({ refused: 'convert other first' }) });
  assert.equal(refused.refused, 'convert other first');
});

test('projectSteps: STATE.json is laid over PLAN.json step by step; a step it does not hold keeps the plan\'s', () => {
  const steps = projectSteps({ steps: [step('a'), step('b', { status: 'blocked', blocked_by: { kind: 'time', at: '2026-12-01T00:00:00Z' } })] }, { steps: [{ status: 'done' }] });
  assert.deepEqual(steps.map((item) => item.status), ['done', 'blocked']);
  assert.equal(steps[1].blocked_by.kind, 'time');
});
