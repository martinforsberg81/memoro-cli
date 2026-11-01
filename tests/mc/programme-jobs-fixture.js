import { readProgrammeState } from '../../src/mc/autonomous-state.js';
import { claimProgrammeJob, setProgrammeJobMode } from '../../src/mc/programme-jobs.js';
import { planner, stateFixture } from './autonomous-state-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';

export function programmeJobsFixture() {
  const fixture = stateFixture();
  fixture.setupProject();
  fixture.releasePlanner();
  // Keep the existing builder-independent project fixture; the effect below
  // deliberately creates a different project so counts catch duplicate goals.
  fixture.read = () => readProgrammeState(fixture.root, fixture.programme);
  fixture.options = (extra = {}) => ({ root: fixture.root, programme: fixture.programme, revision: fixture.read().revision, ...extra });
  fixture.event = (id = 'activation-1', type = 'activation') => ({ id, type, reference: `fixtures/${id}` });
  fixture.activate = () => setProgrammeJobMode(fixture.options(), { mode: 'active', event: fixture.event() });
  fixture.claim = (extra = {}) => {
    const state = claimProgrammeJob(fixture.options({ actor: { run_id: 'job-plan-1', role: 'plan' }, pid: process.pid, ...extra }));
    return fixture.owner(state.planner_jobs.lease);
  };
  fixture.owner = lease => (extra = {}) => fixture.options({ actor: lease.actor, token: lease.token, ...extra });
  fixture.intent = (id = 'create-goal-1') => ({ id, kind: 'create-project', project: 'next-project', expected_revision: 0,
    input: autonomousProject({ project_id: 'next-project' }) });
  return fixture;
}
