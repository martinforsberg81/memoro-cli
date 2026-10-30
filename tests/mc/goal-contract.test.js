import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProject } from '../../src/mc/plan-schema.js';
import { AUTONOMOUS_EXECUTION_ENABLED, autonomousRevisionProblems, evidenceForRevision, validateAutonomousProject } from '../../src/mc/autonomous-project.js';
import { validateProgrammeMetadata } from '../../src/mc/programme-metadata.js';
import {
  applyProgrammeProjectOperation, autonomousPaths, createAutonomousDraft, currentAutonomousEvidence, GOAL_STATE_VERSION, mutateAutonomousProject, mutateProgramme,
  readAutonomousState, readProgrammeState, reserveProjectRun, sendAutonomousProject, updateProgrammeRegister,
} from '../../src/mc/autonomous-state.js';

function assignment(patch = {}) {
  return {
    schema: 'mc-plan', version: 2, project_id: 'goal-one', repo: 'memoro-cli',
    execution: { kind: 'autonomous' }, programme: { id: 'goals' },
    programme_phase: 1, work_class: 'fast', goal_revision: 1,
    goal: ['Build goal assignments.'], instruction: ['Preserve ownership and evidence.'],
    contract: ['Leave fixed-step projects unchanged.'], out_of_scope: ['Live activation.'],
    success_criteria: [
      { id: 'contract', criterion: 'The contract is explicit.', instruction: ['Check the schema.'], check: 'mc gate tests/mc/goal-contract.test.js', verification: 'premerge' },
      { id: 'integration', criterion: 'The integrated result is measured.', instruction: ['Measure after landing.'], check: 'Read integrated evidence.', verification: 'after-integration' },
    ], documents: [], ...patch,
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-goal-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programme = 'goals'; const project = 'goal-one';
  const paths = autonomousPaths(root, programme, project);
  const metadata = { id: programme, brief: 'docs/project/goals/' };
  const options = { env: {}, revision: 0 };
  const init = () => mutateProgramme(root, programme, 'metadata', metadata, options);
  const create = (input = assignment(), extra = {}) => createAutonomousDraft(root, programme, project, input, { ...options, revision: 1, ...extra });
  const state = () => readAutonomousState(root, programme, project);
  const revise = (input, revision = state().revision, extra = {}) => mutateAutonomousProject(root, programme, project, 'revise', input, { ...options, revision, ...extra });
  const json = file => JSON.parse(readFileSync(file, 'utf8'));
  const patchState = patch => writeFileSync(paths.project, JSON.stringify({ ...state(), ...patch }));
  return { root, programme, project, paths, metadata, options, init, create, state, revise, json, patchState };
}

test('a goal assignment has an explicit v2 discriminator, work class and programme phase, without approval', () => {
  for (const work_class of ['fast', 'large']) {
    const goal = assignment({ work_class });
    const before = structuredClone(goal);
    assert.deepEqual(validateAutonomousProject(goal), { ok: true, problems: [] });
    assert.equal(validateProject(goal).ok, true);
    assert.equal(validateAutonomousProject(goal, { programme: { id: 'goals' } }).ok, true);
    assert.equal(validateAutonomousProject(goal, { programme: { id: 'foreign' } }).ok, false);
    assert.deepEqual(goal, before);
    assert.equal('steps' in goal, false);
    assert.equal('revision' in goal.programme, false);
    assert.equal(AUTONOMOUS_EXECUTION_ENABLED, false);
  }
});

test('invalid classes, phase/runtime confusion and old contracts cannot masquerade as assignments', () => {
  for (const patch of [
    { schema: undefined }, { version: 1 }, { version: '2' }, { execution: { kind: 'fixed' } },
    { work_class: undefined }, { work_class: 'small' }, { work_class: 'review' }, { work_class: null },
    { programme_phase: undefined }, { programme_phase: 0 }, { programme_phase: -1 }, { programme_phase: 1.5 },
    { programme_phase: '1' }, { programme_phase: 'running' }, { programme_phase: Number.MAX_SAFE_INTEGER + 1 },
    { phase: 'ready' }, { steps: [] }, { programme: { id: 'goals', revision: 1 } },
    { approval: { by: 'Martin' } }, { goal_revision: 0 }, { repo: '../other' },
  ]) assert.equal(validateAutonomousProject(assignment(patch)).ok, false, JSON.stringify(patch));
});

test('criterion IDs are explicit, unique and independent of prose or position', () => {
  for (const patch of [{ id: '' }, { id: 1 }, { id: '../other' }, { check: '' }, { instruction: [] }, { verification: 'ready' }, { met: true }]) {
    const goal = assignment(); Object.assign(goal.success_criteria[0], patch);
    assert.equal(validateAutonomousProject(goal).ok, false, JSON.stringify(patch));
  }
  const goal = assignment(); goal.success_criteria[1].id = 'contract';
  assert.match(validateAutonomousProject(goal).problems.join('; '), /duplicate criterion ID/u);
  const next = assignment({ goal_revision: 2, work_class: 'large', programme_phase: 2 });
  next.success_criteria.reverse(); next.success_criteria[1].criterion = 'Reworded, same identity.';
  assert.deepEqual(autonomousRevisionProblems(assignment(), next), []);
});

test('programme metadata is minimal context, without draft, approval or assignment authority', t => {
  const f = fixture(t);
  assert.equal(validateProgrammeMetadata(f.metadata).ok, true);
  for (const patch of [{ id: '../escape' }, { brief: '' }, { status: 'approved' }, { approval: {} }, { revision: 1 }]) {
    assert.equal(validateProgrammeMetadata({ ...f.metadata, ...patch }).ok, false);
  }
  const state = f.init();
  assert.equal(state.version, GOAL_STATE_VERSION);
  assert.deepEqual(state.metadata, f.metadata);
  for (const key of ['approved', 'draft', 'programme_revision']) assert.equal(key in state, false);
  for (const operation of ['draft', 'approve']) {
    assert.throws(() => mutateProgramme(f.root, f.programme, operation, {}, { ...f.options, revision: 1 }), /draft\/approve/u);
  }
  assert.throws(() => mutateProgramme(f.root, f.programme, 'metadata', { ...f.metadata, id: 'other' }, { ...f.options, revision: 1 }), /identity cannot change/u);
  assert.deepEqual(readProgrammeState(f.root, f.programme), state);
});

test('foreground creation and revision obtain internal operation actors, with no reservation or lease', t => {
  const f = fixture(t); f.init();
  const created = f.create();
  assert.equal(created.active_run, null);
  assert.deepEqual(created.runs, []);
  assert.equal(created.planning_operations[0].actor.role, 'foreground-plan');
  assert.match(created.planning_operations[0].actor.run_id, /^foreground-/u);
  assert.equal(created.contract.programme_phase, 1);
  assert.equal(created.phase, 'plan_pending');
  const revised = f.revise(assignment({ goal_revision: 2 }));
  assert.notEqual(revised.planning_operations[1].actor.run_id, created.planning_operations[0].actor.run_id);
  const programme = readProgrammeState(f.root, f.programme);
  assert.equal(programme.active_run, null);
  assert.equal('planner_jobs' in programme, false);
  assert.equal(programme.execution_enabled, false);
});

test('CAS fences both programme authoring and goal writes, leaving bytes untouched on refusal', t => {
  const f = fixture(t); f.init();
  assert.throws(() => f.create(assignment(), { revision: 0 }), /stale state revision/u);
  assert.equal(existsSync(f.paths.project), false);
  const original = f.create();
  const next = f.revise(assignment({ goal_revision: 2 }));
  const bytes = readFileSync(f.paths.project, 'utf8');
  assert.throws(() => f.revise(assignment({ goal_revision: 3 }), original.revision), /stale state revision/u);
  assert.equal(readFileSync(f.paths.project, 'utf8'), bytes);
  assert.equal(next.goal_revision, 2);
  assert.throws(() => mutateProgramme(f.root, f.programme, 'metadata', f.metadata, f.options), /stale state revision/u);
});

test('goal revisions preserve repository, project and programme identity and advance exactly once', t => {
  const f = fixture(t); f.init(); f.create();
  for (const patch of [
    { goal_revision: 1 }, { goal_revision: 3 }, { goal_revision: Number.MAX_SAFE_INTEGER + 1 },
    { repo: 'memoro' }, { project_id: 'other' }, { programme: { id: 'other' } },
  ]) {
    const before = readFileSync(f.paths.project, 'utf8');
    assert.throws(() => f.revise(assignment({ goal_revision: 2, ...patch })));
    assert.equal(readFileSync(f.paths.project, 'utf8'), before);
  }
  const revised = f.revise(assignment({ goal_revision: 2, work_class: 'large', programme_phase: 3 }));
  assert.equal(revised.contract.work_class, 'large');
  assert.equal(revised.contract.programme_phase, 3);
  assert.equal(revised.phase, 'plan_pending');
});

test('retired criterion IDs cannot be recycled, while rewording and reordering retain history', t => {
  const f = fixture(t); f.init(); f.create();
  const second = assignment({ goal_revision: 2 });
  second.success_criteria.reverse(); second.success_criteria[1].criterion = 'New wording.';
  f.revise(second);
  const third = structuredClone(second); third.goal_revision = 3;
  third.success_criteria = third.success_criteria.filter(item => item.id !== 'contract');
  f.revise(third);
  const fourth = assignment({ goal_revision: 4 });
  assert.throws(() => f.revise(fourth), /retired criterion IDs/u);
  fourth.success_criteria[0].id = 'replacement';
  const state = f.revise(fourth);
  assert.deepEqual(state.contracts.slice(0, 3), [assignment(), second, third]);
  assert.equal(state.contracts[0].success_criteria[0].id, 'contract');
});

test('sent revisions stay on the same branch and PR and invalidate current execution projections, not history', t => {
  const f = fixture(t); f.init(); f.create();
  sendAutonomousProject(f.root, f.programme, f.project, { ...f.options, revision: f.state().revision });
  const history = [{ id: 'old-review', reference: 'immutable/report.json' }];
  f.patchState({ ownership: { branch: 'goal-owned', pr: 42 }, commits: ['a'.repeat(40)], review_reports: history,
    publication: { head: 'a'.repeat(40) }, merge_handoff: { old: true }, session_control: { old: true } });
  const state = f.revise(assignment({ goal_revision: 2 }));
  assert.deepEqual(state.ownership, { branch: 'goal-owned', pr: 42 });
  assert.deepEqual(state.commits, ['a'.repeat(40)]);
  assert.deepEqual(state.review_reports, history);
  for (const key of ['publication', 'merge_handoff', 'session_control']) assert.equal(key in state, false);
  assert.deepEqual(f.json(join(f.paths.projectDir, 'PLAN.json')), state.contract);
  assert.deepEqual(f.json(f.paths.draft), state.contract);
});

test('active build, review and merge phases refuse revision even without a recorded owner', t => {
  const f = fixture(t); f.init(); const original = f.create();
  for (const phase of ['running', 'handoff_requested', 'closing', 'publishing', 'reviewing', 'landing']) {
    writeFileSync(f.paths.project, JSON.stringify({ ...original, phase }));
    const before = readFileSync(f.paths.project, 'utf8');
    assert.throws(() => f.revise(assignment({ goal_revision: 2 })), /safe boundary/u);
    assert.equal(readFileSync(f.paths.project, 'utf8'), before);
  }
  writeFileSync(f.paths.project, JSON.stringify({ ...original, phase: 'landed' }));
  assert.throws(() => f.revise(assignment({ goal_revision: 2 })), /immutable/u);
  writeFileSync(f.paths.project, JSON.stringify({ ...original, phase: 'confirmed' }));
  const obsolete = readFileSync(f.paths.project, 'utf8');
  assert.throws(() => f.revise(assignment({ goal_revision: 2 })), /invalid autonomous state/u);
  assert.equal(readFileSync(f.paths.project, 'utf8'), obsolete, 'obsolete execution states fail closed, never migrate');
});

test('a live project owner cannot be replaced by a foreground operation', t => {
  const f = fixture(t); f.init(); const original = f.create();
  reserveProjectRun(f.root, f.programme, f.project, { run_id: 'builder', role: 'step' }, original.revision);
  assert.throws(() => f.revise(assignment({ goal_revision: 2 })), /safe boundary/u);
  assert.equal(f.state().active_run.run_id, 'builder');
});

test('builder and reviewer roles cannot author goals, including attempts to omit the actor', t => {
  const f = fixture(t); f.init(); f.create();
  for (const role of ['step', 'review']) {
    const env = { MC_AUTONOMOUS_ROLE: role };
    assert.throws(() => f.revise(assignment({ goal_revision: 2 }), 1, { env }), /planning roles/u);
    assert.throws(() => f.create(assignment(), { env }), /planning roles/u);
    assert.throws(() => f.revise(assignment({ goal_revision: 2 }), 1, { actor: { role, run_id: role } }), /foreground planning/u);
  }
  assert.equal(f.state().goal_revision, 1);
});

test('leased planning requires the exact current owner, token and unexpired lease; no lease is fabricated', t => {
  const f = fixture(t); f.init();
  const actor = { role: 'plan', run_id: 'headless-one' };
  updateProgrammeRegister(f.root, f.programme, state => ({ ...state, active_run: actor, runs: [actor],
    planner_jobs: { lease: { actor, token: 'lease-one', expires_at: 200 } } }));
  const options = { actor, revision: 2, token: 'lease-one', now: () => 100 };
  assert.throws(() => f.create(assignment(), { revision: 2 }), /active run/u);
  assert.throws(() => f.create(assignment(), { ...options, token: 'wrong' }), /lease ownership/u);
  assert.throws(() => f.create(assignment(), { ...options, now: () => 200 }), /expired/u);
  assert.throws(() => f.create(assignment(), { ...options, actor: { ...actor, run_id: 'foreign' } }), /ownership/u);
  const state = f.create(assignment(), options);
  assert.deepEqual(state.planning_operations[0].actor, actor);
  assert.equal(state.active_run, null);
  assert.equal(readProgrammeState(f.root, f.programme).planner_jobs.lease.token, 'lease-one');
});

test('an unleased plan reservation is not authoring authority', t => {
  const f = fixture(t); f.init();
  const actor = { role: 'plan', run_id: 'unleased' };
  updateProgrammeRegister(f.root, f.programme, state => ({ ...state, active_run: actor, runs: [actor] }));
  assert.throws(() => f.create(assignment(), { revision: 2, actor }), /lease ownership/u);
});

test('old programme state, even relabelled as version 2, is explicitly unsupported and preserved byte for byte', t => {
  const f = fixture(t);
  mkdirSync(f.paths.dir, { recursive: true });
  for (const version of [1, GOAL_STATE_VERSION]) {
    const old = { schema: 'mc-programme-state', version, revision: 7, approved: [], draft: null, runs: [], active_run: null, execution_enabled: false, metadata: f.metadata };
    const bytes = JSON.stringify(old, null, 2) + '\n'; writeFileSync(f.paths.programme, bytes);
    for (const action of [() => readProgrammeState(f.root, f.programme), () => f.init(), () => f.create()]) {
      assert.throws(action, /unsupported pre-ruling-60 format.*preserve.*automatic migration is not supported/u);
      assert.equal(readFileSync(f.paths.programme, 'utf8'), bytes);
    }
    assert.equal(existsSync(f.paths.project), false);
  }
});

test('old goal state cannot masquerade as assignments by changing only the state version', t => {
  const f = fixture(t); f.init(); const original = f.create();
  for (const patch of [{ version: 1 }, { programme_revision: 1 }, { contract: { ...assignment(), programme: { id: 'goals', revision: 1 } } }]) {
    const bytes = JSON.stringify({ ...original, ...patch }, null, 2) + '\n';
    writeFileSync(f.paths.project, bytes);
    const draft = readFileSync(f.paths.draft, 'utf8');
    for (const action of [f.state, () => f.revise(assignment({ goal_revision: 2 }), 1), () => f.create()]) {
      assert.throws(action, /unsupported pre-ruling-60 format/u);
      assert.equal(readFileSync(f.paths.project, 'utf8'), bytes);
      assert.equal(readFileSync(f.paths.draft, 'utf8'), draft);
    }
  }
});

test('v1 project files are not overwritten or translated into goals', t => {
  const f = fixture(t); f.init();
  mkdirSync(f.paths.projectDir, { recursive: true });
  const file = join(f.paths.projectDir, 'PLAN.json');
  const bytes = JSON.stringify({ version: 1, steps: [{ title: 'Keep fixed steps.' }] }) + '\n';
  writeFileSync(file, bytes);
  assert.throws(() => f.create(), /already exists/u);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(existsSync(f.paths.project), false);
});

test('authoring keeps programme, goal and strict register locking around the effect', t => {
  const f = fixture(t); f.init();
  const calls = [];
  f.create(assignment(), {
    planLock: (dir, effect) => { calls.push(`enter:${dir}`); const result = effect(); calls.push(`exit:${dir}`); return result; },
    lock: (root, effect) => { calls.push(`register:${root}`); return effect(); },
  });
  assert.deepEqual(calls, [`enter:${f.paths.dir}`, `enter:${f.paths.projectDir}`, `register:${f.root}`, `exit:${f.paths.projectDir}`, `exit:${f.paths.dir}`]);
});

test('projection failure preserves the authoritative revision and supports explicit recovery', t => {
  const f = fixture(t); f.init(); f.create();
  sendAutonomousProject(f.root, f.programme, f.project, { ...f.options, revision: 1 });
  assert.throws(() => f.revise(assignment({ goal_revision: 2 }), 2, { writePlan: () => { throw new Error('projection failed'); } }), /projection failed/u);
  assert.equal(f.state().goal_revision, 2);
  assert.equal(f.json(join(f.paths.projectDir, 'PLAN.json')).goal_revision, 1);
  const state = mutateAutonomousProject(f.root, f.programme, f.project, 'recover', null, { ...f.options, revision: 3 });
  assert.deepEqual(f.json(join(f.paths.projectDir, 'PLAN.json')), state.contract);
  assert.deepEqual(f.json(f.paths.draft), state.contract);
  assert.equal(state.revision, 3);
});

test('a durable leased operation receipt survives projection failure and replays without applying a revision twice', t => {
  const f = fixture(t); f.init(); f.create();
  const actor = { role: 'plan', run_id: 'journal-planner' };
  const intent = { id: 'revise-once', kind: 'revise-project', project: f.project,
    expected_revision: 1, input: assignment({ goal_revision: 2 }) };
  updateProgrammeRegister(f.root, f.programme, state => ({ ...state, active_run: actor, runs: [actor],
    planner_jobs: { mode: 'inactive', lease: { actor, token: 'lease-once', expires_at: 200 },
      operations: [{ intent, status: 'pending' }] } }));
  const options = { actor, revision: 2, token: 'lease-once', now: () => 100 };
  assert.throws(() => applyProgrammeProjectOperation(f.root, f.programme, intent, { ...options,
    writeDraft: () => { throw new Error('projection failed'); } }), /projection failed/u);
  const afterEffect = f.state();
  assert.equal(afterEffect.goal_revision, 2);
  assert.equal(afterEffect.operation_receipts.length, 1);
  const result = applyProgrammeProjectOperation(f.root, f.programme, intent, options);
  assert.deepEqual(result, { project: f.project, revision: afterEffect.revision });
  assert.deepEqual(f.state(), afterEffect);
  assert.deepEqual(f.json(f.paths.draft), afterEffect.contract);
  assert.throws(() => applyProgrammeProjectOperation(f.root, f.programme, { ...intent, input: assignment({ goal_revision: 3 }) }, options), /persisted planner intent/u);
  assert.throws(() => applyProgrammeProjectOperation(f.root, f.programme, intent, { ...options, token: 'foreign' }), /lease ownership/u);
});

test('a retained unknown build claim fences foreground revision rather than being erased', t => {
  const f = fixture(t); f.init(); f.create();
  const dir = join(f.root, 'runner', 'autonomous-builds', f.programme);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${f.project}.claim`);
  const bytes = 'unknown ownership\n'; writeFileSync(file, bytes);
  assert.throws(() => f.revise(assignment({ goal_revision: 2 })), /safe boundary/u);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(f.state().goal_revision, 1);
});

test('evidence selection isolates goal identity and revision even with shared criterion IDs', () => {
  const goal = assignment();
  const observations = [
    { project_id: goal.project_id, programme_id: goal.programme.id, goal_revision: 1 },
    { project_id: 'goal-two', programme_id: goal.programme.id, goal_revision: 1 },
    { project_id: goal.project_id, programme_id: 'another-programme', goal_revision: 1 },
    { project_id: goal.project_id, programme_id: goal.programme.id, goal_revision: 2 },
  ];
  const evidence = { builder: [], reviews: [], confirmation: null };
  observations.forEach((binding, index) => {
    evidence.builder.push({ ...binding, id: `build-${index}`, run_id: `builder-${index}`,
      criterion_id: 'contract', status: 'verified', reference: `proof/${index}` });
    evidence.reviews.push({ ...binding, id: `review-${index}`, run_id: `reviewer-${index}`,
      reference: `report/${index}`, findings: [], criteria: [{ criterion_id: 'contract', status: 'verified', reference: `proof/${index}` }] });
  });
  const before = structuredClone(evidence);
  for (const [project, index] of [[goal, 0], [assignment({ project_id: 'goal-two' }), 1],
    [assignment({ programme: { id: 'another-programme' } }), 2], [assignment({ goal_revision: 2 }), 3]]) {
    assert.deepEqual(evidenceForRevision(project, evidence), {
      builder: [evidence.builder[index]], reviews: [evidence.reviews[index]], confirmation: null,
    });
  }
  assert.deepEqual(evidence, before, 'selecting current evidence never rewrites history');
});

test('revising another goal or programme context preserves evidence; revising this goal invalidates it without deleting history', t => {
  const f = fixture(t); f.init(); f.create();
  const actor = { role: 'step', run_id: 'goal-one-builder' };
  reserveProjectRun(f.root, f.programme, f.project, actor, f.state().revision);
  mutateAutonomousProject(f.root, f.programme, f.project, 'progress', {
    id: 'contract-proof', criterion_id: 'contract', status: 'verified', reference: 'evidence/contract.json',
  }, { actor, revision: f.state().revision });
  const before = f.state(); const bytes = readFileSync(f.paths.project, 'utf8');
  const other = assignment({ project_id: 'goal-two' });
  const created = createAutonomousDraft(f.root, f.programme, other.project_id, other,
    { ...f.options, revision: readProgrammeState(f.root, f.programme).revision });
  mutateAutonomousProject(f.root, f.programme, other.project_id, 'revise', { ...other, goal_revision: 2 },
    { ...f.options, revision: created.revision });
  mutateProgramme(f.root, f.programme, 'metadata', { ...f.metadata, brief: 'docs/project/new-context/' },
    { ...f.options, revision: readProgrammeState(f.root, f.programme).revision });
  assert.equal(readFileSync(f.paths.project, 'utf8'), bytes);
  assert.deepEqual(currentAutonomousEvidence(f.state()), currentAutonomousEvidence(before));
  mutateAutonomousProject(f.root, f.programme, f.project, 'release', null, { actor, revision: before.revision });
  const revised = f.revise(assignment({ goal_revision: 2 }));
  assert.deepEqual(revised.evidence, before.evidence);
  assert.deepEqual(currentAutonomousEvidence(revised), { builder: [], reviews: [], confirmation: null });
  const revisedBytes = readFileSync(f.paths.project, 'utf8');
  assert.throws(() => mutateAutonomousProject(f.root, f.programme, f.project, 'progress', {
    id: 'stale-proof', criterion_id: 'contract', status: 'verified', reference: 'evidence/contract.json',
  }, { actor, revision: before.revision }), /stale state revision/u);
  assert.equal(readFileSync(f.paths.project, 'utf8'), revisedBytes);
});
