import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { programmeContract, autonomousProject } from './autonomy-fixtures.js';
import { autonomousPaths, reserveProgrammeRun, releaseProgrammeRun, mutateProgramme, createAutonomousDraft, mutateAutonomousProject, reserveProjectRun, readAutonomousState } from '../../src/mc/autonomous-state.js';

export const foreground = { run_id: 'foreground-1', role: 'foreground-plan' };
export const planner = { run_id: 'plan-1', role: 'plan' };
export const builder = { run_id: 'build-1', role: 'step' };
export const reviewer = { run_id: 'review-1', role: 'review' };
export function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-autonomous-state-'));
  const programme = 'test-programme'; const project = 'test-project';
  const paths = autonomousPaths(root, programme, project);
  const input = join(root, 'input.json'); const out = []; const err = [];
  const draft = programmeContract({ status: 'draft' }); delete draft.approval;
  const deps = { root, env: {}, actor: foreground, stdout: { write: line => out.push(line) }, stderr: { write: line => err.push(line) } };
  reserveProgrammeRun(root, programme, foreground, 0);
  const f = {
    root, programme, project, paths, input, deps, out, err, draft,
    json: path => JSON.parse(readFileSync(path, 'utf8')),
    file: value => { writeFileSync(input, JSON.stringify(value)); return input; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    setupProject: () => {
      mutateProgramme(root, programme, 'draft', draft, { actor: foreground, revision: 1 });
      mutateProgramme(root, programme, 'approve', { by: 'Martin', at: '2026-10-28T12:00:00Z' }, { actor: foreground, revision: 2 });
      releaseProgrammeRun(root, programme, foreground, 3);
      reserveProgrammeRun(root, programme, planner, 4);
      f.deps.actor = planner;
      return createAutonomousDraft(root, programme, project, autonomousProject(), { actor: planner, revision: 5 });
    },
    switchProject: actor => {
      let state = readAutonomousState(root, programme, project);
      if (state.active_run) state = mutateAutonomousProject(root, programme, project, 'release', null, { actor: state.active_run, revision: state.revision });
      return reserveProjectRun(root, programme, project, actor, state.revision);
    },
  };
  return f;
}
