/** Shared isolated publication/recovery fixture; no model calls or nested test runs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateFixture, planner, builder } from './autonomous-state-fixture.js';
import { attribution } from './autonomy-fixtures.js';
import { readAutonomousState, sendAutonomousProject, mutateAutonomousProject, startAutonomousBuild,
  observeProjectSessionControl } from '../../src/mc/autonomous-state.js';
import { captureWorktree, gateReceipt, persistGateReceipt } from '../../src/mc/session-gate-evidence.js';
import { gateConfiguration } from '../../src/mc/gate-greens.js';
import { finishAutonomousPublication, completeAutonomousPublication } from '../../src/mc/autonomous-publish.js';
import { AUTONOMOUS_PR_MARK } from '../../src/mc/autonomous-pr.js';

export const profile = { soft_active_ms: 100, upper_active_ms: 200, emergency_active_ms: 300, reserve_active_ms: 100,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 200, tool_wait_ms: 120, lane_wait_ms: 150, total_awake_ms: 1000,
  no_progress_ms: 800, max_stagnant_sessions: 3, max_failures: 3 };
export const completion = { status: 0, normal_exit: true, recovery_ready: true, control_persisted: true, interrupted: false };
export function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
export function fixture(t, { close = true, existing = null, assignment = {} } = {}) {
  const f = stateFixture(); t.after(f.cleanup); f.setupProject(assignment);
  const cwd = join(f.root, 'memoro-cli'); mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Publication Test'); git(cwd, 'config', 'user.email', 'publication@example.invalid');
  writeFileSync(join(cwd, 'schema.test.js'), 'export {};\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'baseline');
  const remote = join(f.root, 'origin.git'); git(cwd, 'clone', '--bare', '-q', cwd, remote);
  git(cwd, 'remote', 'add', 'origin', remote); git(cwd, 'fetch', '-q', 'origin');
  git(cwd, 'switch', '-qc', f.project);
  let state = readAutonomousState(f.root, f.programme, f.project);
  sendAutonomousProject(f.root, f.programme, f.project, { actor: planner, token: 'fixture-lease', revision: state.revision });
  state = readAutonomousState(f.root, f.programme, f.project);
  // Activation remains unavailable; only this isolated runner fixture admits it.
  state.phase = 'ready';
  if (existing !== null) state.ownership.pr = existing;
  writeFileSync(f.paths.project, JSON.stringify(state));
  state = startAutonomousBuild(f.root, f.programme, f.project, { actor: builder, revision: state.revision,
    model: { tool: 'claude', model: 'haiku', effort: 'high' }, reviewer: { tool: 'claude', model: 'opus', effort: 'high' },
    assignment: state.contract, branch: f.project, profile,
    observation: { sequence: 0, at_ms: 1000, awake_ms: 0, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  state = mutateAutonomousProject(f.root, f.programme, f.project, 'progress', { id: 'schema-proof', criterion_id: 'schema',
    status: 'verified', reference: 'evidence/schema.json' }, { actor: builder, revision: state.revision });
  if (close) state = observeProjectSessionControl(f.root, f.programme, f.project, { actor: builder, revision: state.revision,
    observation: { sequence: 1, at_ms: 1200, awake_ms: 200, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  const env = { ...process.env, MC_WORK_ROOT: f.root, MC_HOME: join(f.root, 'mc-home'), MC_AUTONOMOUS_RUN: builder.run_id, MC_AUTONOMOUS_ROLE: 'step' };
  delete env.MC_STEP;
  const binding = { ...attribution(), run_id: builder.run_id };
  const input = { goal_revision: 1, message: 'Implement schema', title: 'Schema implementation', body: 'Built and measured the schema.',
    result: { schema: 'mc-session-result', version: 1, ...binding, outcome: 'continue', reason: null,
      handoff: { schema: 'mc-session-handoff', version: 1, ...binding, published_sha: null,
        interpretation: { implemented: ['Schema implemented.'], remaining: ['Next criterion.'], decisions: [], failed_approaches: [], next_focus: 'Check the next criterion.' },
        evidence: [{ ...binding, criterion_id: 'schema', reference: 'evidence/schema.json', summary: 'Schema verified.' }], references: [] } } };
  const calls = []; const output = []; let count = 0;
  let pr = existing === null ? null : { number: existing, headRefName: f.project, baseRefName: 'main', state: 'OPEN', body: '' };
  const stateNow = () => readAutonomousState(f.root, f.programme, f.project);
  const options = () => ({ root: f.root, programme: f.programme, project: f.project, actor: builder, cwd, env, revision: stateNow().revision });
  const requirements = async () => ({ base: git(cwd, 'rev-parse', 'origin/main'), configuration: gateConfiguration({ select: 'fixture-selector' }),
    selection: { kind: 'affected', files: ['schema.test.js'], commands: [], flags: [], pattern: null } });
  const gh = args => {
    calls.push(args);
    if (args[1] === 'list') return { ok: true, status: 0, stdout: JSON.stringify(pr ? [{ number: pr.number, url: `https://fixture/pull/${pr.number}`, state: pr.state }] : []) };
    if (args[1] === 'create') {
      assert.equal(pr, null, 'never create a second PR');
      assert.ok(args.includes('--draft')); assert.ok(args[args.indexOf('--body') + 1].includes(AUTONOMOUS_PR_MARK));
      pr = { number: 42, headRefName: f.project, baseRefName: 'main', state: 'OPEN', body: args[args.indexOf('--body') + 1] };
      return { ok: true, status: 0, stdout: 'https://fixture/pull/42' };
    }
    if (args[1] === 'edit') {
      assert.equal(Number(args[2]), pr.number);
      if (args.includes('--body')) pr.body = args[args.indexOf('--body') + 1];
      return { ok: true, status: 0, stdout: '' };
    }
    if (args[1] === 'view') {
      const remoteHead = git(cwd, 'ls-remote', '--heads', 'origin', f.project).split(/\s+/u)[0];
      return { ok: true, status: 0, stdout: JSON.stringify({ ...pr, headRefOid: remoteHead }) };
    }
    throw new Error(`unexpected GitHub operation ${args.join(' ')}`);
  };
  const deps = { stdout: { write: text => output.push(text) }, stderr: { write: text => output.push(text) }, requirements,
    publishDeps: { gh, merge: () => assert.fail('autonomous publication never queues merge') },
    gate: async (args, call) => {
      assert.deepEqual(args, ['--json', '--budget', '10800']); calls.push(['gate']); count++;
      const required = await requirements(); const candidate = captureWorktree(cwd);
      const receipt = gateReceipt({ measurement: { repo: 'memoro-cli', run: `gate-${count}`, ...call.measurementBinding,
        configuration: required.configuration, candidate, base: required.base }, before: candidate, after: candidate,
        result: { ok: true, code: 0, coverage: required.selection, execution: { tests: { exit: 0, finished: true,
          totals: { tests: 1, pass: 1, fail: 0, cancelled: 0 } }, commands: [] } },
        started: '2026-10-28T12:00:00Z', ended: '2026-10-28T12:01:00Z' });
      const path = persistGateReceipt({ root: env.MC_HOME, receipt });
      call.stdout.write(JSON.stringify({ evidence: { path } })); return 0;
    } };
  const edit = () => writeFileSync(join(cwd, 'implementation.js'), 'export const implemented = true;\n');
  return { ...f, cwd, remote, env, input, options, stateNow, deps, calls, output, gh, edit,
    finish: () => finishAutonomousPublication(options(), input, deps),
    complete: (result = completion) => completeAutonomousPublication(options(), result, deps),
    pr: () => pr };
}
