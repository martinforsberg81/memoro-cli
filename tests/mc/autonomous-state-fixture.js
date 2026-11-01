import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { programmeMetadata, autonomousProject } from './autonomy-fixtures.js';
import { autonomousPaths, reserveProgrammeRun, releaseProgrammeRun, mutateProgramme, createAutonomousDraft, mutateAutonomousProject, reserveProjectRun, readAutonomousState, updateProgrammeRegister } from '../../src/mc/autonomous-state.js';

export const foreground = { run_id: 'foreground-1', role: 'foreground-plan' };
export const planner = { run_id: 'plan-1', role: 'plan' };
export const builder = { run_id: 'build-1', role: 'step' };
export const reviewer = { run_id: 'review-1', role: 'review' };
export function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-autonomous-state-'));
  const programme = 'test-programme'; const project = 'test-project';
  const paths = autonomousPaths(root, programme, project);
  const input = join(root, 'input.json'); const out = []; const err = [];
  const draft = programmeMetadata();
  const deps = { root, env: {}, actor: foreground, token: 'fixture-lease', stdout: { write: line => out.push(line) }, stderr: { write: line => err.push(line) } };
  reserveProgrammeRun(root, programme, foreground, 0);
  const f = {
    root, programme, project, paths, input, deps, out, err, draft,
    json: path => JSON.parse(readFileSync(path, 'utf8')),
    file: value => { writeFileSync(input, JSON.stringify(value)); return input; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    setupProject: (overrides = {}) => {
      releaseProgrammeRun(root, programme, foreground, 1);
      mutateProgramme(root, programme, 'metadata', draft, { env: {}, revision: 2 });
      reserveProgrammeRun(root, programme, planner, 3);
      updateProgrammeRegister(root, programme, state => ({ ...state, planner_jobs: { version: 1, mode: 'active', wait: null, stop: null,
        events: [{ id: 'fixture-activation', type: 'activation', reference: 'fixtures/initial-owner' }],
        pending: { id: 'fixture-job', event_ids: ['fixture-activation'] }, operations: [], recoveries: [], lease: {
          actor: planner, token: 'fixture-lease', pid: process.pid, job_id: 'fixture-job',
          event_ids: ['fixture-activation'], expires_at: Date.now() + 600_000,
        } } }));
      f.deps.actor = planner;
      return createAutonomousDraft(root, programme, project, autonomousProject(overrides), { actor: planner, token: 'fixture-lease', revision: 5 });
    },
    releasePlanner: () => updateProgrammeRegister(root, programme, state => ({ ...state, active_run: null, planner_jobs: undefined })),
    switchProject: actor => {
      let state = readAutonomousState(root, programme, project);
      if (state.active_run) state = mutateAutonomousProject(root, programme, project, 'release', null, { actor: state.active_run, revision: state.revision });
      return reserveProjectRun(root, programme, project, actor, state.revision);
    },
  };
  return f;
}
