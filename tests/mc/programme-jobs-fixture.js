import { readProgrammeState, releaseProgrammeRun, createAutonomousDraft } from '../../src/mc/autonomous-state.js';
import { claimProgrammeJob, setProgrammeJobMode, prepareProgrammeOperation, completeProgrammeOperation } from '../../src/mc/programme-jobs.js';
import { planner, stateFixture } from './autonomous-state-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';

export function programmeJobsFixture() {
  const fixture = stateFixture();
  fixture.setupProject();
  releaseProgrammeRun(fixture.root, fixture.programme, planner, 5);
  // Keep the existing builder-independent project fixture; the effect below
  // deliberately creates a different project so counts catch duplicate goals.
  fixture.read = () => readProgrammeState(fixture.root, fixture.programme);
  fixture.options = (extra = {}) => ({ root: fixture.root, programme: fixture.programme, revision: fixture.read().revision, ...extra });
  fixture.event = (id = 'activation-1', type = 'activation') => ({ id, type, programme_revision: 1, reference: `fixtures/${id}` });
  fixture.activate = () => setProgrammeJobMode(fixture.options(), { mode: 'active', event: fixture.event() });
  fixture.claim = (extra = {}) => {
    const state = claimProgrammeJob(fixture.options({ actor: { run_id: 'job-plan-1', role: 'plan' }, pid: process.pid, ...extra }));
    return fixture.owner(state.planner_jobs.lease);
  };
  fixture.owner = lease => (extra = {}) => fixture.options({ actor: lease.actor, token: lease.token, ...extra });
  fixture.intent = (id = 'create-goal-1') => ({ id, kind: 'create-project', project: 'next-project', expected_revision: 0,
    programme_revision: 1, input: autonomousProject({ project_id: 'next-project' }) });
  return fixture;
}

// A real process exit in each persistence gap, not a thrown exception whose
// finally blocks could accidentally finish the operation. Invoked by the test.
if (process.argv[2] === 'crash') {
  const [, , , root, programme, phase] = process.argv;
  const read = () => readProgrammeState(root, programme);
  const current = read();
  const actor = { run_id: 'crashed-plan-1', role: 'plan' };
  const claimed = claimProgrammeJob({ root, programme, revision: current.revision, actor, pid: process.pid });
  const token = claimed.planner_jobs.lease.token;
  const intent = { id: 'crash-create-1', kind: 'create-project', project: 'crash-project', expected_revision: 0,
    programme_revision: 1, input: autonomousProject({ project_id: 'crash-project' }) };
  if (phase === 'claim') process.exit(86);
  prepareProgrammeOperation({ root, programme, revision: read().revision, actor, token }, intent);
  if (phase === 'intent') process.exit(86);
  createAutonomousDraft(root, programme, intent.project, intent.input, { actor, revision: read().revision, operationId: intent.id,
    ...(phase === 'effect' ? { writeDraft: () => process.exit(86) } : {}) });
  if (phase === 'projection') process.exit(86);
  completeProgrammeOperation({ root, programme, revision: read().revision, actor, token }, intent, { project: intent.project, revision: 1 });
  process.exit(86);
}

if (process.argv[2] === 'contend') {
  const [, , , root, programme, run_id] = process.argv;
  try {
    const current = readProgrammeState(root, programme);
    const state = claimProgrammeJob({ root, programme, revision: current.revision, actor: { run_id, role: 'plan' }, pid: process.pid });
    process.stdout.write(state.active_run?.run_id === run_id ? 'claimed' : 'not-claimed');
  } catch (error) {
    if (!/stale programme state revision/u.test(error.message)) throw error;
    process.stdout.write('not-claimed');
  }
}
