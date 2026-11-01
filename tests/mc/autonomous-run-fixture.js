/** Shared temporary runner/workarea fixture. No model/provider calls. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRunner, realDeps } from '../../src/mc/run.js';
import { AUTONOMOUS_EXECUTION_ENABLED } from '../../src/mc/autonomous-project.js';
import { readAutonomousState, readProgrammeState, sendAutonomousProject, mutateAutonomousProject,
  createAutonomousDraft, autonomousPaths } from '../../src/mc/autonomous-state.js';
import { normaliseCapacity, applyRefusal } from '../../src/mc/model-capacity.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { stateFixture, planner } from './autonomous-state-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';
import * as claudeAdapter from '../../src/adapters/claude-code.js';

export const profile = { soft_active_ms: 100, upper_active_ms: 200, emergency_active_ms: 300, reserve_active_ms: 100,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 200, tool_wait_ms: 120, lane_wait_ms: 150, total_awake_ms: 1000,
  no_progress_ms: 800, max_stagnant_sessions: 3, max_failures: 3 };
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export const completed = { status: 0, stdout: JSON.stringify({ subtype: 'success', num_turns: 1, session_id: 'fixture-session' }), stderr: '',
  normal_exit: true, recovery_ready: true, control_persisted: true };
export function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
export function runnerFixture(t, { assignment = {} } = {}) {
  const f = stateFixture(); t.after(f.cleanup);
  f.setupProject(assignment);
  const primaryHome = join(f.root, 'primary'); const primary = join(primaryHome, 'memoro-cli');
  const remote = join(f.root, 'remote.git');
  mkdirSync(primary, { recursive: true });
  git(primary, 'init', '-q', '-b', 'main');
  writeFileSync(join(primary, 'base.txt'), 'base\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-qm', 'Initial');
  git(f.root, 'clone', '-q', '--bare', primary, remote);
  git(primary, 'remote', 'add', 'origin', remote); git(primary, 'fetch', '-q', 'origin');
  const env = { ...process.env, MC_WORK_ROOT: f.root, MC_REPOS_HOME: primaryHome };
  delete env.MC_STEP;
  const calls = []; const log = []; let capacity = normaliseCapacity(null); const sleeps = [];
  const deps = { ...realDeps(env), now: () => new Date('2026-10-28T12:00:00Z'), log: line => log.push(line),
    // Admission scenarios use fixture capacity, never the host's current disk
    // or memory pressure. Resource-refusal tests can override these readings.
    freeBytes: () => 100 * 2 ** 30, freeMemoryPercent: () => 50,
    catalog: () => DEFAULT_CATALOG, capacity: { read: () => capacity, write: next => { capacity = next; } },
    laneCount: () => ({ per_repo: 2, total: 2 }), billing: { readMode: () => 'plan' },
    attachDeps: async () => ({ ok: true }),
    launch: () => ({ ok: true, id: 'claude-code', shortName: 'Claude', spec: { bin: 'fixture' }, adapter: claudeAdapter }),
    addWorktree: ({ name, branch, from }) => {
      const cwd = join(f.root, name, 'memoro-cli'); mkdirSync(join(f.root, name), { recursive: true });
      const existing = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: primary }).status === 0;
      git(primary, 'worktree', 'add', '-q', ...(existing ? [cwd, branch] : ['-b', branch, cwd, from]));
      return { ok: true, path: cwd };
    },
    session: async call => { calls.push(call); return completed; },
    gh: () => ({ ok: true, stdout: '[]', stderr: '' }),
    // Tests control lane release explicitly, without polling a real clock.
    sleep: () => { const wait = deferred(); sleeps.push(wait); return wait.promise; },
  };
  const capability = { fixture: true, profile, pollMs: 10, clock: () => ({ at_ms: 1000, awake_ms: 0 }),
    gate: async (args, options) => { assert.deepEqual(args, ['--budget', '10800']); assert.equal(options.env, env); return 0; } };
  const state = (project = f.project) => readAutonomousState(f.root, f.programme, project);
  const add = (project = f.project, overrides = {}) => {
    let value;
    const planning = readProgrammeState(f.root, f.programme);
    const author = planning.planner_jobs?.lease ? { actor: planner, token: 'fixture-lease' } : {};
    if (project === f.project) value = state();
    else value = createAutonomousDraft(f.root, f.programme, project, autonomousProject({ project_id: project, ...overrides }),
      { ...author, revision: planning.revision });
    sendAutonomousProject(f.root, f.programme, project, { ...author, revision: value.revision });
    value = state(project);
    // The later planner/activation door is not implemented here. Only this
    // isolated fixture supplies a ready assignment; no live command enables it.
    value.phase = 'ready'; writeFileSync(autonomousPaths(f.root, f.programme, project).project, JSON.stringify(value));
    return { project, programme: f.programme, repo: 'memoro-cli', path: join(f.paths.projectDir, 'PLAN.json'), plan: value.contract };
  };
  const record = add();
  // The assignment has been sent; the headless planner no longer owns this
  // programme. Builder recovery must preserve an incomplete attempt for plan.
  f.releasePlanner();
  const world = (...records) => ({ names: records.map(r => r.project), plans: records, prs: [], prsFailed: [] });
  const cwd = project => join(f.root, 'step', project, 'memoro-cli');
  const advanceMain = text => {
    writeFileSync(join(primary, 'base.txt'), text); git(primary, 'add', '.'); git(primary, 'commit', '-qm', 'Move main');
    git(remote, 'fetch', '-q', primary, 'main:main');
    return git(primary, 'rev-parse', 'HEAD');
  };
  return { ...f, deps, capability, primary, remote, calls, log, sleeps, record, world, state, add, cwd, advanceMain,
    refuse: () => { capacity = applyRefusal(capacity, 'claude', '2026-10-29T12:00:00Z'); } };
}
