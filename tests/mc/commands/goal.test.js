import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stateFixture, planner, foreground } from '../autonomous-state-fixture.js';
import { autonomousProject } from '../autonomy-fixtures.js';
import { runMcCli } from '../_helpers/mc-cli.js';
import { autonomousPaths, readAutonomousState, releaseProgrammeRun, reserveProjectRun } from '../../../src/mc/autonomous-state.js';
import { VERB_MODULES } from '../../../src/mc-verbs.js';

function workspace(f) {
  const env = { MC_WORK_ROOT: f.root, MC_HOME: f.root, MC_REPOS_HOME: join(f.root, 'repos'), MC_STEP: '' };
  const cli = (args, additions = {}) => runMcCli(args, { ...env, ...additions }, { cwd: f.root });
  const newGoal = (name, overrides = {}) => cli(['goal', 'new', `${f.programme}/${name}`, '--phase', '1', '--repo', 'memoro-cli', '--class', 'fast',
    '--goal', 'Implement ordinary goal authoring.', '--contract', 'Preserve v1 projects.', '--out-of-scope', 'Live activation.', ...overrides.args || []], overrides.env || {});
  const criterion = (name, revision = null, additions = {}) => cli(['goal', 'criterion', 'add', `${f.programme}/${name}`, '--id', 'cli', '--criterion', 'The CLI is usable.', '--instruction', 'Exercise the goal verbs.', '--check', 'mc gate tests/mc/commands/goal.test.js', '--verify', 'premerge', ...(revision ? ['--expected-revision', revision] : [])], additions);
  return { cli, newGoal, criterion };
}

test('foreground goal authoring needs no lease and send makes an unblocked assignment ready', t => {
  const f = stateFixture(); t.after(f.cleanup); releaseProgrammeRun(f.root, f.programme, foreground, 1); const w = workspace(f);
  assert.equal(VERB_MODULES['autonomous-project'], undefined);
  assert.equal(VERB_MODULES.goal, './mc/commands/goal.js');
  let result = w.newGoal('ordinary');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).contract.goal_revision, 1);
  result = w.criterion('ordinary'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).goal_revision, 2);
  result = w.cli(['goal', 'send', `${f.programme}/ordinary`]);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).execution_enabled, false);
  assert.equal(readAutonomousState(f.root, f.programme, 'ordinary').phase, 'ready');
  result = w.cli(['goal', 'done', `${f.programme}/ordinary`]);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).done, false);
  const plan = join(autonomousPaths(f.root, f.programme, 'ordinary').projectDir, 'PLAN.json');
  assert.equal(existsSync(plan), true);
  assert.equal('steps' in JSON.parse(readFileSync(plan, 'utf8')), false);
});

test('leased planner uses ordinary goal verbs and cannot publish outside its programme lease', t => {
  const f = stateFixture(); t.after(f.cleanup);
  f.setupProject();
  const env = { MC_WORK_ROOT: f.root, MC_HOME: f.root, MC_REPOS_HOME: join(f.root, 'repos'), MC_AUTONOMOUS_ROLE: 'plan',
    MC_AUTONOMOUS_RUN: planner.run_id, MC_PROGRAMME: f.programme, MC_PROGRAMME_LEASE: 'fixture-lease' };
  const result = runMcCli(['goal', 'revise', `${f.programme}/${f.project}`, '--expected-revision', '1', '--input-file', f.file(autonomousProject({ goal_revision: 2 }))], env, { cwd: f.root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).goal_revision, 2);
});

test('goal role boundaries reject assignment changes by builder and reviewer; dependency names fail closed', t => {
  const f = stateFixture(); t.after(f.cleanup); releaseProgrammeRun(f.root, f.programme, foreground, 1); const w = workspace(f);
  assert.equal(w.newGoal('owner').status, 0);
  const reviewer = w.cli(['goal', 'revise', `${f.programme}/owner`, '--expected-revision', '1', '--input-file', f.file({})], { MC_AUTONOMOUS_ROLE: 'review' });
  assert.notEqual(reviewer.status, 0); assert.match(reviewer.stderr, /review/u);
  const builder = w.cli(['goal', 'send', `${f.programme}/owner`, '--expected-revision', '1'], { MC_AUTONOMOUS_ROLE: 'step', MC_AUTONOMOUS_RUN: 'build-1' });
  assert.notEqual(builder.status, 0); assert.match(builder.stderr, /planning roles|planning/u);
  assert.equal(w.criterion('owner').status, 0);
  const bad = w.cli(['goal', 'send', `${f.programme}/owner`, '--expected-revision', '2', '--after', 'missing-goal']);
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /unknown goal dependency: missing-goal/u);
  const self = w.cli(['goal', 'send', `${f.programme}/owner`, '--expected-revision', '2', '--after', 'owner']);
  assert.notEqual(self.status, 0); assert.match(self.stderr, /itself/u);
  const cross = w.cli(['goal', 'send', `${f.programme}/owner`, '--expected-revision', '2', '--after', 'other-programme/goal']);
  assert.notEqual(cross.status, 0); assert.match(cross.stderr, /goal names/u);
  assert.equal(w.newGoal('first').status, 0); assert.equal(w.criterion('first').status, 0);
  assert.equal(w.newGoal('second').status, 0); assert.equal(w.criterion('second').status, 0);
  const first = w.cli(['goal', 'send', `${f.programme}/first`, '--expected-revision', '2', '--after', 'second']);
  assert.equal(first.status, 0, first.stderr);
  const cycle = w.cli(['goal', 'send', `${f.programme}/second`, '--expected-revision', '2', '--after', 'first']);
  assert.notEqual(cycle.status, 0); assert.match(cycle.stderr, /cannot form a cycle/u);
  assert.equal(w.cli(['goal', 'send', `${f.programme}/owner`, '--expected-revision', '2']).status, 0);
  const actor = { run_id: 'builder-run', role: 'step' };
  reserveProjectRun(f.root, f.programme, 'owner', actor, 3);
  const evidence = w.cli(['goal', 'criterion', 'evidence', `${f.programme}/owner`, '--id', 'cli', '--reference', 'evidence/cli.json', '--expected-revision', '4'], {
    MC_AUTONOMOUS_ROLE: 'step', MC_AUTONOMOUS_RUN: actor.run_id,
  });
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.equal(readAutonomousState(f.root, f.programme, 'owner').evidence.builder[0].reference, 'evidence/cli.json');
});

