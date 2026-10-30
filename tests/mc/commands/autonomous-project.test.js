import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../../../src/mc/commands/autonomous-project.js';
import { autonomousProject } from '../autonomy-fixtures.js';
import { stateFixture, planner, builder, reviewer, foreground } from '../autonomous-state-fixture.js';
import { currentAutonomousEvidence, readAutonomousState, reserveProjectRun, mutateAutonomousProject, releaseProgrammeRun, reserveProgrammeRun } from '../../../src/mc/autonomous-state.js';
import { run as projectCommand } from '../../../src/mc/commands/project.js';
import { runMcCli } from '../_helpers/mc-cli.js';
import { collectProject, renderProject } from '../../../src/mc/status-project.js';
import { programsPlans } from '../../../src/mc/plan-source.js';
import { applyEntry, overlayPlans } from '../../../src/mc/register.js';
import { kindFor } from '../../../src/mc/run-plan.js';
import { withReviewStep } from '../../../src/mc/plan-write.js';

const invoke = (f, operation, revision, input, deps = {}) => run([operation, `${f.programme}/${f.project}`, '--expected-revision', String(revision),
  ...(input === undefined ? [] : ['--input-file', f.file(input)])], { ...f.deps, ...deps });
const stateOf = f => f.json(f.paths.project);
const progress = { id: 'schema-proof', criterion_id: 'schema', status: 'verified', reference: 'evidence/schema-proof.json' };
const report = { id: 'review-proof', reference: 'reports/review-proof.json', findings: ['One gap.'], criteria: [
  { criterion_id: 'schema', status: 'finding', reference: 'reports/review-proof.json#schema' },
  { criterion_id: 'integration', status: 'deferred', reference: 'Requires integration before verification.' },
] };
const sha = 'a'.repeat(40);

test('real CLI routes programme and ordinary goal commands without launching sessions', () => {
  const f = stateFixture();
  try {
    const env = { MC_WORK_ROOT: f.root, MC_HOME: f.root, MC_REPOS_HOME: join(f.root, 'repos'),
      MC_STEP: '', MC_AUTONOMOUS_RUN: foreground.run_id, MC_AUTONOMOUS_ROLE: foreground.role };
    const cli = (args, actor = foreground) => runMcCli(args, { ...env, MC_AUTONOMOUS_RUN: actor.run_id, MC_AUTONOMOUS_ROLE: actor.role }, { cwd: f.root });
    for (const verb of ['programme', 'goal']) {
      const help = cli([verb, '--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /^usage/u);
    }
    releaseProgrammeRun(f.root, f.programme, foreground, 1);
    let result = cli(['programme', 'metadata', f.programme, '--expected-revision', '2', '--input-file', f.file(f.draft)]);
    assert.equal(result.status, 0, result.stderr);
    result = cli(['programme', 'show', f.programme]);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).execution_enabled, false);
    result = cli(['goal', 'new', `${f.programme}/${f.project}`, '--phase', '1', '--repo', 'memoro-cli', '--class', 'fast', '--goal', 'Implement explicit contracts.', '--contract', 'Preserve v1.', '--out-of-scope', 'Live activation.']);
    assert.equal(result.status, 0, result.stderr);
    result = cli(['goal', 'criterion', 'add', `${f.programme}/${f.project}`, '--id', 'schema', '--criterion', 'The schema validates.', '--instruction', 'Validate the opt-in contract.', '--check', 'mc gate tests/mc/goal-contract.test.js', '--verify', 'premerge', '--expected-revision', '1']);
    assert.equal(result.status, 0, result.stderr);
    result = cli(['project', f.project, '--json', '--offline']);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).goal_revision, 2);
    result = cli(['goal', 'send', `${f.programme}/${f.project}`, '--expected-revision', '2']);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).execution_enabled, false);
    const sentGoal = f.json(join(f.paths.projectDir, 'PLAN.json'));
    assert.equal(sentGoal.goal_revision, 2); assert.deepEqual(sentGoal.goal, ['Implement explicit contracts.']);
    assert.deepEqual(sentGoal.success_criteria.map(item => item.id), ['schema']);
    assert.equal('steps' in sentGoal, false);
    const repo = join(env.MC_REPOS_HOME, 'memoro-cli'); mkdirSync(join(repo, '.git'), { recursive: true });
    const before = readFileSync(f.paths.project, 'utf8');
    result = cli(['status', f.project, '--json', '--offline']);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout); assert.equal(status.machine.runnable, false);
    assert.ok(status.autonomous, JSON.stringify(status));
    assert.equal(status.autonomous.phase, 'plan_pending'); assert.deepEqual(status.problems, []);
    result = cli(['project', f.project, '--offline']);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /execution disabled/u); assert.doesNotMatch(result.stdout, /STEPS/u);
    assert.equal(readFileSync(f.paths.project, 'utf8'), before, 'status cannot mutate autonomous state');
    assert.equal(cli(['programme', 'start', f.programme]).status, 2);
    assert.equal(cli(['autonomous-project', 'start', `${f.programme}/${f.project}`]).status, 2);
    assert.deepEqual(readdirSync(f.paths.projectDir).sort(), ['AUTONOMOUS_STATE.json', 'DRAFT.json', 'PLAN.json']);
    assert.equal(existsSync(join(f.root, 'runner', 'projects', `${f.project}.json`)), false);
    assert.equal(existsSync(join(f.root, 'runner', 'log', 'runs.tsv')), false);
  } finally { f.cleanup(); }
});

test('the legacy project route refuses v2 send; assignments use mc goal send', async () => {
  const f = stateFixture();
  try {
    f.setupProject(); const sent = join(f.paths.projectDir, 'PLAN.json');
    assert.equal(await projectCommand(['send', f.project, '--expected-revision', '1'], { ...f.deps, home: join(f.root, 'programs') }), 1);
    assert.equal(existsSync(sent), false);
    assert.match(f.err.join(''), /mc goal send/u);
  } finally { f.cleanup(); }
});

test('v2 status exposes revisioned observations read-only without seeding or applying a v1 register', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    assert.equal(await invoke(f, 'send', 1), 0);
    const repo = join(f.root, 'repos', 'memoro-cli'); mkdirSync(join(repo, '.git'), { recursive: true });
    const options = { env: { MC_WORK_ROOT: f.root }, repos: [{ name: 'memoro-cli', path: repo }], offline: true,
      programs: () => programsPlans({ home: join(f.root, 'programs') }), merges: () => null };
    const before = readFileSync(f.paths.project, 'utf8');
    const status = await collectProject(f.project, options);
    assert.deepEqual(status.plan, autonomousProject()); assert.equal(status.autonomous.done, false);
    assert.equal(status.machine.runnable, false); assert.equal(status.machine.reason, 'inactive');
    assert.deepEqual(overlayPlans([{ plan: status.plan }], { root: f.root, write: () => assert.fail('v1 write') }), [{ plan: status.plan }]);
    assert.deepEqual(applyEntry({ plan: status.plan }, { steps: [] }), { plan: status.plan });
    assert.match(renderProject(status), /schema  unknown · premerge/u);
    assert.equal(kindFor(f.project, { plans: [{ project: f.project, plan: status.plan }] }), 'skip:inactive');
    assert.equal(readFileSync(f.paths.project, 'utf8'), before);
    writeFileSync(f.paths.project, '{');
    const broken = await collectProject(f.project, options);
    assert.equal(broken.autonomous, null); assert.match(broken.problems.join(''), /autonomous state/u);
    assert.equal(broken.machine.runnable, false);
  } finally { f.cleanup(); }
});

test('legacy mutation and cleanup commands refuse v2 and unknown versions without side effects', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    const deps = { ...f.deps, home: join(f.root, 'programs'), repos: [], rm: () => assert.fail('must not remove'), gh: () => assert.fail('must not call GitHub') };
    writeFileSync(f.input, 'Build the assigned goal.');
    for (const version of [2, 99, '2']) {
      writeFileSync(f.paths.draft, JSON.stringify(autonomousProject({ version })));
      const before = readFileSync(f.paths.draft, 'utf8');
      for (const args of [['edit', f.project, '--goal', 'Changed'], ['criterion', 'add', f.project, 'Changed', '--check', 'check'],
        ['criterion', 'edit', f.project, '1', '--check', 'check'], ['criterion', 'drop', f.project, '1', '--reason', 'no'],
        ['step', 'add', f.project, 'Build', '--model', 'fast', '--done-when', 'Tests pass.', '--instruction-file', f.input],
        ['step', 'edit', f.project, '1', '--title', 'Changed'],
        ['criterion', 'met', f.project, '1'], ['archive', f.project], ['discard', f.project, '--apply']]) {
        assert.equal(await projectCommand(args, deps), 1, args.join(' '));
        assert.equal(readFileSync(f.paths.draft, 'utf8'), before);
      }
    }
    rmSync(f.paths.project);
    for (const version of [99, '2']) {
      writeFileSync(f.paths.draft, JSON.stringify(autonomousProject({ version })));
      assert.equal(await projectCommand(['send', f.project], deps), 1);
      assert.equal(await projectCommand(['discard', f.project, '--apply'], deps), 1);
      assert.equal(existsSync(join(f.paths.projectDir, 'PLAN.json')), false);
      assert.match(f.err.join(''), /unsupported/u);
    }
  } finally { f.cleanup(); }
});

test('v2 creation is planner-owned, validates an approved programme and creates only a draft', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    const state = stateOf(f);
    assert.deepEqual(state.contract, autonomousProject());
    assert.deepEqual(f.json(f.paths.draft), state.contract);
    assert.equal(existsSync(join(f.paths.projectDir, 'PLAN.json')), false);
    assert.equal(existsSync(join(f.paths.projectDir, 'STATE.json')), false, 'no v1 register is seeded');
    assert.equal(state.active_run, null); assert.equal(state.phase, 'plan_pending'); assert.equal(state.confirmed, false);
    assert.deepEqual(state.ownership, { branch: null, pr: null });
    assert.equal(await invoke(f, 'create', 5, autonomousProject()), 1, 'cannot overwrite a project');
    assert.equal(await run(['show', `${f.programme}/${f.project}`], f.deps), 0);
    const created = autonomousProject({ project_id: 'command-project' });
    assert.equal(await run(['create', `${f.programme}/command-project`, '--expected-revision', '5', '--input-file', f.file(created)], f.deps), 0, f.err.join(''));
    assert.deepEqual(f.json(join(f.paths.dir, 'command-project', 'AUTONOMOUS_STATE.json')).contract, created);
    assert.equal(existsSync(join(f.paths.dir, 'command-project', 'PLAN.json')), false);
  } finally { f.cleanup(); }
});

test('denied roles, stale writers and mismatched programme references preserve state exactly', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    const before = readFileSync(f.paths.project, 'utf8');
    const next = autonomousProject({ goal_revision: 2 });
    for (const actor of [builder, reviewer, foreground, { ...planner, run_id: 'other-plan' }, undefined]) {
      assert.equal(await invoke(f, 'revise', 1, next, { actor }), 1);
      assert.equal(readFileSync(f.paths.project, 'utf8'), before);
    }
    for (const input of [autonomousProject(), { ...next, project_id: 'other-project' }, { ...next, repo: 'memoro' }, { ...next, programme: { id: f.programme, revision: 9 } }, { ...next, programme: { id: 'other-programme', revision: 1 } }]) {
      assert.equal(await invoke(f, 'revise', 1, input), 1);
      assert.equal(readFileSync(f.paths.project, 'utf8'), before);
    }
    assert.equal(await invoke(f, 'revise', 0, next), 1);
    assert.equal(await invoke(f, 'revise', 1, next), 0, f.err.join(''));
    assert.equal(await invoke(f, 'revise', 1, autonomousProject({ goal_revision: 3 })), 1);
    assert.equal(stateOf(f).goal_revision, 2);
  } finally { f.cleanup(); }
});

test('revisions preserve run, attempt, commit, PR and report history while invalidating current evidence', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    let state = f.switchProject(builder); f.deps.actor = builder;
    assert.equal(await invoke(f, 'progress', state.revision, progress), 0, f.err.join(''));
    state = stateOf(f);
    assert.equal(await invoke(f, 'attempt', state.revision, { id: 'attempt-1', reason: 'Gate stayed red.', commits: [sha], branch: 'goal-branch', pr: 123, handoff: 'handoffs/attempt-1.json' }), 0);
    state = f.switchProject(reviewer); f.deps.actor = reviewer;
    assert.equal(await invoke(f, 'report', state.revision, report), 0, f.err.join(''));
    // A planner without the programme lease cannot author or claim the goal.
    const unowned = { ...planner, run_id: 'plan-2' };
    assert.throws(() => reserveProjectRun(f.root, f.programme, f.project, unowned, stateOf(f).revision), /ownership/u);
    assert.equal(await invoke(f, 'revise', stateOf(f).revision, autonomousProject({ goal_revision: 2 }), { actor: unowned }), 1);
    state = mutateAutonomousProject(f.root, f.programme, f.project, 'release', null, { actor: reviewer, revision: stateOf(f).revision });
    // Foreground planning resumes after the real headless reservation closes.
    f.releasePlanner(); f.deps.actor = undefined;
    const before = stateOf(f);
    const next = autonomousProject({ goal_revision: 2, success_criteria: autonomousProject().success_criteria.slice().reverse() });
    assert.equal(await invoke(f, 'revise', before.revision, next), 0, f.err.join(''));
    const after = stateOf(f);
    for (const key of ['ownership', 'commits', 'attempts', 'runs', 'confirmations']) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(after.evidence.builder, before.evidence.builder);
    assert.deepEqual(after.evidence.reviews, before.evidence.reviews);
    assert.equal(after.contracts.length, 2); assert.deepEqual(after.contracts[0], autonomousProject());
    assert.equal(after.current_handoff, null); assert.equal(after.confirmed, false);
    assert.deepEqual(currentAutonomousEvidence(after), { builder: [], reviews: [], confirmation: null });
    assert.equal(after.attempts[0].outcome, 'incomplete');
    assert.equal(after.attempts[0].goal_revision, 1); assert.equal(after.evidence.reviews[0].run_id, reviewer.run_id);
  } finally { f.cleanup(); }
});

test('step and review may record only their own observations, not scope or confirmation', async () => {
  const f = stateFixture();
  try {
    f.setupProject(); let state = f.switchProject(builder); f.deps.actor = builder;
    for (const [operation, input] of [['revise', autonomousProject({ goal_revision: 2 })], ['confirm', { id: 'not-plan', reference: 'no' }], ['report', report]]) {
      assert.equal(await invoke(f, operation, state.revision, input), 1);
    }
    assert.equal(await invoke(f, 'progress', state.revision, { ...progress, run_id: 'forged-run', goal_revision: 99 }), 0);
    state = stateOf(f);
    assert.equal(state.evidence.builder[0].run_id, builder.run_id); assert.equal(state.evidence.builder[0].goal_revision, 1);
    for (const input of [progress, { ...progress, id: 'other-proof', criterion_id: 'missing' }, { ...progress, id: 'other-proof', reference: null }, { ...progress, id: 'other-proof', branch: 'forged' }]) assert.equal(await invoke(f, 'progress', state.revision, input), 1);
    state = f.switchProject(reviewer); f.deps.actor = reviewer;
    for (const [operation, input] of [['revise', autonomousProject({ goal_revision: 2 })], ['confirm', { id: 'not-plan', reference: 'no' }], ['progress', progress]]) assert.equal(await invoke(f, operation, state.revision, input), 1);
    assert.equal(await invoke(f, 'report', state.revision, { ...report, criteria: report.criteria.slice(0, 1) }), 1, 'missing criterion observations are refused');
    assert.equal(await invoke(f, 'report', state.revision, report), 0);
    assert.equal(await invoke(f, 'report', stateOf(f).revision, report), 1, 'reports are immutable, not upserts');
    assert.equal(stateOf(f).confirmed, false);
  } finally { f.cleanup(); }
});

test('attempt history cannot be rewritten or switch branch/PR identity, and incomplete attempts never claim green', async () => {
  const f = stateFixture();
  try {
    f.setupProject(); let state = f.switchProject(builder); f.deps.actor = builder;
    const attempt = { id: 'attempt-1', reason: 'Unexpected exit.', commits: [sha], branch: 'goal-branch', pr: 123 };
    assert.equal(await invoke(f, 'attempt', state.revision, attempt), 0);
    state = stateOf(f);
    for (const input of [attempt, { ...attempt, id: 'attempt-2', branch: 'new' }, { ...attempt, id: 'attempt-2', pr: 999 }, { ...attempt, id: 'attempt-2', outcome: 'green' }, { ...attempt, id: 'attempt-2', commits: ['short'] }]) {
      assert.equal(await invoke(f, 'attempt', state.revision, input), 1);
      assert.deepEqual(stateOf(f), state);
    }
    assert.equal(await invoke(f, 'attempt', state.revision, { ...attempt, id: 'attempt-2', reason: 'Gate still red.' }), 0);
    assert.equal(stateOf(f).attempts.length, 2); assert.equal(stateOf(f).attempts[0].reason, 'Unexpected exit.');
    assert.ok(stateOf(f).attempts.every(item => item.outcome === 'incomplete'));
    assert.equal(stateOf(f).phase, 'plan_pending');
  } finally { f.cleanup(); }
});

test('atomic state is authoritative after a crash between state and draft projection; retry cannot duplicate history', async () => {
  const f = stateFixture();
  try {
    f.setupProject(); const before = readFileSync(f.paths.project, 'utf8');
    const next = autonomousProject({ goal_revision: 2 });
    assert.equal(await invoke(f, 'revise', 1, next, { write: () => { throw new Error('disk full before state rename'); } }), 1);
    assert.equal(readFileSync(f.paths.project, 'utf8'), before); assert.equal(f.json(f.paths.draft).goal_revision, 1);
    assert.equal(await invoke(f, 'revise', 1, next, { writeDraft: () => { throw new Error('crash after state commit'); } }), 1);
    assert.equal(stateOf(f).goal_revision, 2); assert.equal(f.json(f.paths.draft).goal_revision, 1);
    assert.equal(await invoke(f, 'revise', 1, next), 1, 'the committed revision is not applied twice');
    assert.equal(await run(['show', `${f.programme}/${f.project}`], f.deps), 0);
    assert.equal(f.json(f.paths.draft).goal_revision, 1, 'show is read-only even after a projection failure');
    assert.equal(await invoke(f, 'recover', stateOf(f).revision), 0);
    assert.deepEqual(f.json(f.paths.draft), next); assert.equal(stateOf(f).contracts.length, 2);
    writeFileSync(f.paths.draft, '{');
    assert.deepEqual(readAutonomousState(f.root, f.programme, f.project).contract, next);
    assert.equal(await invoke(f, 'recover', stateOf(f).revision), 0);
    assert.deepEqual(f.json(f.paths.draft), next, 'raw draft edits never change the contract');
  } finally { f.cleanup(); }
});

test('ownership and expected revision are rechecked under lock, and active builders prevent planner revision', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    const lock = (_root, fn) => {
      const state = stateOf(f); state.active_run = builder; state.runs.push(builder);
      writeFileSync(f.paths.project, JSON.stringify(state)); return fn();
    };
    assert.equal(await invoke(f, 'revise', 1, autonomousProject({ goal_revision: 2 }), { lock }), 1);
    assert.equal(stateOf(f).goal_revision, 1);
    assert.throws(() => reserveProjectRun(f.root, f.programme, f.project, planner, 1), /active run/);
    f.deps.actor = builder;
    assert.equal(await invoke(f, 'release', 1), 0);
    assert.throws(() => reserveProjectRun(f.root, f.programme, f.project, planner, 1), /stale/);
    assert.throws(() => reserveProjectRun(f.root, f.programme, f.project, builder, 2), /already used/);
  } finally { f.cleanup(); }
});

test('unsupported operations, malformed state and accidental v1 targets fail closed', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    for (const args of [['start', `${f.programme}/${f.project}`], ['revise', `${f.programme}/${f.project}`], ['show', '../escape'], ['show', `${f.programme}/${f.project}`, '--role', 'plan']]) assert.notEqual(await run(args, f.deps), 0);
    writeFileSync(f.paths.project, JSON.stringify({ schema: 'mc-register', version: 1, steps: [] }));
    assert.equal(await run(['show', `${f.programme}/${f.project}`], f.deps), 1);
    assert.match(f.err.join(''), /invalid mc-autonomous-state/);
  } finally { f.cleanup(); }
});

test('project creation denies unowned planners, stale programme state and unapproved references', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    const { createAutonomousDraft } = await import('../../../src/mc/autonomous-state.js');
    const input = autonomousProject({ project_id: 'second-project' });
    for (const options of [
      { actor: builder, revision: 5 }, { actor: reviewer, revision: 5 },
      { actor: { ...planner, run_id: 'other-plan' }, revision: 5 }, { actor: planner, token: 'fixture-lease', revision: 4 },
    ]) assert.throws(() => createAutonomousDraft(f.root, f.programme, 'second-project', input, options));
    for (const programme of [{ id: f.programme, revision: 2 }, { id: 'other-programme', revision: 1 }]) {
      assert.throws(() => createAutonomousDraft(f.root, f.programme, 'second-project', { ...input, programme }, { actor: planner, token: 'fixture-lease', revision: 5 }));
    }
    assert.equal(existsSync(join(f.paths.dir, 'second-project', 'AUTONOMOUS_STATE.json')), false);
    assert.equal(existsSync(join(f.paths.dir, 'second-project', 'DRAFT.json')), false);
  } finally { f.cleanup(); }
});

test('a process exiting after the atomic state commit leaves one recoverable revision, never half a draft contract', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    const { spawn } = await import('node:child_process');
    const module = new URL('../../../src/mc/autonomous-state.js', import.meta.url).href;
    const next = autonomousProject({ goal_revision: 2, goal: ['The revised goal.'] });
    const code = `import { mutateAutonomousProject } from ${JSON.stringify(module)};
      mutateAutonomousProject(process.argv[1], 'test-programme', 'test-project', 'revise', JSON.parse(process.argv[2]), {
        actor: ${JSON.stringify(planner)}, token: 'fixture-lease', revision: 1, writeDraft: () => process.exit(23)
      });`;
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.root, JSON.stringify(next)], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', reject); child.on('close', resolve);
    });
    assert.equal(status, 23);
    assert.deepEqual(stateOf(f).contract, next); assert.equal(stateOf(f).revision, 2);
    assert.equal(f.json(f.paths.draft).goal_revision, 1);
    // The dead writer's own locks are reclaimed by the existing mechanisms.
    assert.equal(await invoke(f, 'recover', 2), 0, f.err.join(''));
    assert.deepEqual(f.json(f.paths.draft), next); assert.equal(stateOf(f).contracts.length, 2);
    assert.equal(await invoke(f, 'revise', 1, next), 1);
  } finally { f.cleanup(); }
});

test('expected project revision is checked after acquiring the write lock', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    const lock = (_root, fn) => {
      const state = stateOf(f); state.revision++;
      writeFileSync(f.paths.project, JSON.stringify(state)); return fn();
    };
    assert.equal(await invoke(f, 'revise', 1, autonomousProject({ goal_revision: 2 }), { lock }), 1);
    assert.match(f.err.join(''), /stale state revision/);
    assert.equal(stateOf(f).goal_revision, 1); assert.equal(stateOf(f).contracts.length, 1);
  } finally { f.cleanup(); }
});

test('retired project criterion IDs cannot be recycled and old evidence remains attributable', async () => {
  const f = stateFixture();
  try {
    f.setupProject();
    const reduced = autonomousProject({ goal_revision: 2, success_criteria: [autonomousProject().success_criteria[0]] });
    assert.equal(await invoke(f, 'revise', 1, reduced), 0);
    const before = stateOf(f);
    assert.equal(await invoke(f, 'revise', before.revision, autonomousProject({ goal_revision: 3 })), 1);
    assert.match(f.err.join(''), /retired criterion IDs cannot be reused/);
    assert.deepEqual(stateOf(f), before);
    const replacement = autonomousProject({ goal_revision: 3 }); replacement.success_criteria[1].id = 'new-integration';
    assert.equal(await invoke(f, 'revise', before.revision, replacement), 0);
    assert.equal(stateOf(f).contracts[0].success_criteria[1].id, 'integration');
  } finally { f.cleanup(); }
});
