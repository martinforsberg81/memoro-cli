/** Trusted v2 reconciliation. Never launch a model, reset a tree, signal a
 * previous worker, enqueue merge or reinterpret an incomplete exit as green. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readAutonomousState, readProgrammeState, mutateAutonomousProject, settleAutonomousBuild } from './autonomous-state.js';
import { finishAutonomousPublication, completeAutonomousPublication } from './autonomous-publish.js';
import { readCurrentHandoff } from './session-handoff.js';
import { preserveSession, reconcilePreviousSession, sessionGit, sessionGitDir } from './session-recovery.js';
import { processAlive, readClaim, takeClaim, releaseClaim } from './resource-claim.js';
import { writeJsonAtomic } from './atomic-write.js';

export const autonomousBuildClaim = ({ root, programme, project }) => join(root, 'runner', 'autonomous-builds', programme, `${project}.claim`);
export function autonomousBuildHeld(options) {
  const path = autonomousBuildClaim(options);
  if (!existsSync(path)) return false;
  const claim = readClaim(path);
  return !claim || processAlive(claim.pid);
}
const read = options => readAutonomousState(options.root, options.programme, options.project);

/** Failure is durable and idempotent. Retain ownership even when children are
 * unknown: plan must reconcile them before it can authorize further work. */
export function incompleteAutonomousBuild(options, reason) {
  const state = read(options);
  if (!isDeepStrictEqual(state.active_run, options.actor)) throw new Error('active step ownership required');
  if (state.attempts.some(item => item.id === options.actor.run_id)) return state;
  let commits = [];
  try { commits = [sessionGit(options.cwd, ['rev-parse', 'HEAD']).trim()]; } catch { /* preparation may not have created a checkout */ }
  return mutateAutonomousProject(options.root, options.programme, options.project, 'attempt', {
    id: options.actor.run_id, reason, commits, ...(state.current_handoff ? { handoff: state.current_handoff } : {}),
  }, { actor: options.actor, revision: state.revision });
}

/** Normal runner return and crash recovery share the same continuation door. */
export async function settlePublishedBuild(options, processResult, deps = {}) {
  await completeAutonomousPublication(options, processResult, deps);
  const state = read(options);
  const programme = readProgrammeState(options.root, options.programme).metadata;
  const handoff = readCurrentHandoff({ root: options.root, assignment: state.contract, programme, runId: options.actor.run_id });
  return settleAutonomousBuild(options.root, options.programme, options.project,
    { actor: options.actor, revision: state.revision, handoff });
}

/** Call while holding the project build claim. The supervisor's durable result,
 * not a runner restart or status=0 alone, supplies process completion facts. */
export async function recoverAutonomousBuild(options, deps = {}) {
  const state = read(options);
  if (state.continuation?.run_id === options.actor.run_id && state.continuation.goal_revision === state.goal_revision && !state.active_run) return state;
  if (!isDeepStrictEqual(state.active_run, options.actor) || options.actor.role !== 'step') throw new Error('active step ownership required');
  if (state.phase === 'plan_pending' && !readProgrammeState(options.root, options.programme).planner_jobs) return state;
  // A surviving supervisor/finish operation is not ours to replace. Unknown
  // claims remain held; dead claims are generation-safely reclaimed.
  const claims = [];
  try {
    const gitDir = sessionGitDir(options.cwd);
    for (const name of ['mc-autonomous-session.claim', 'mc-autonomous-finish.claim']) {
      const path = join(gitDir, name);
      const held = takeClaim(path, { pid: process.pid, run_id: options.actor.run_id });
      if (!held.ok) return state;
      claims.push([path, held.marker]);
    }
    const settled = state.attempts.map(item => item.id).filter(id => id !== options.actor.run_id);
    const quiet = reconcilePreviousSession(gitDir, { publication: state.publication, settled });
    if (!quiet.ok && ['previous-process-group-alive', 'gate-worker-alive'].includes(quiet.reason)) return state;
    if (!quiet.ok) throw new Error(`recovery required: ${quiet.reason}`);
    if (state.phase === 'plan_pending') return mutateAutonomousProject(options.root, options.programme, options.project, 'release', null, { actor: options.actor, revision: read(options).revision });
    if (quiet.gate && quiet.gate.code !== 0) throw new Error('previous gate did not complete green');
    const path = join(gitDir, 'mc-autonomous-session.json');
    if (!existsSync(path)) throw new Error('durable supervisor completion is missing');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const checkpoint = JSON.parse(readFileSync(join(manifest.snapshot, 'checkpoint.json'), 'utf8'));
    const result = JSON.parse(readFileSync(join(dirname(manifest.snapshot), 'result.json'), 'utf8'));
    if (manifest.run_id !== options.actor.run_id || !isDeepStrictEqual(manifest.binding, state.session_control?.binding)
      || !isDeepStrictEqual(checkpoint.control.binding, manifest.binding)
      || Object.entries(manifest.binding).some(([key, value]) => result.control?.[key] !== value)
      || manifest.process_closed !== true || manifest.unreconciled_tools !== false
      || manifest.control_persisted !== true || manifest.recovery?.ok !== true || result.control_persisted !== true || result.recovery?.ok !== true
      || (manifest.recovery.gate && manifest.recovery.gate.code !== 0) || (result.recovery.gate && result.recovery.gate.code !== 0)
      || [result, checkpoint.process].some(item => item.status !== 0 || item.normal_exit !== true || item.interrupted !== false || item.signal !== null || item.group_dead !== true)) {
      throw new Error('incomplete or unbound supervisor completion');
    }
    if (!state.publication || state.publication.run_id !== options.actor.run_id) throw new Error('process exit has no publication intent');
    // Release only our finish claim: the existing publication transaction owns
    // that lock itself. Keep the project and session claims across the retry.
    const finishClaim = claims.pop(); releaseClaim(...finishClaim);
    if (state.publication.phase !== 'handoff_committed') {
      await finishAutonomousPublication({ ...options, revision: read(options).revision }, state.publication.input, deps);
    }
    // A recovered commit keeps the old snapshot immutable. Save a fresh one
    // outside the checkout before replacing its manifest pointer.
    if (checkpoint.head !== sessionGit(options.cwd, ['rev-parse', 'HEAD']).trim()) {
      const parent = dirname(manifest.snapshot); mkdirSync(parent, { recursive: true });
      const directory = mkdtempSync(join(parent, 'publication-recovery-'));
      const snapshot = preserveSession({ cwd: options.cwd, directory, control: checkpoint.control,
        telemetry: checkpoint.telemetry, process: checkpoint.process });
      writeJsonAtomic(join(directory, 'result.json'), result);
      writeJsonAtomic(path, { ...manifest, snapshot });
    }
    return await settlePublishedBuild(options, { ...result, recovery_ready: true }, deps);
  } catch (error) {
    return incompleteAutonomousBuild(options, error.message);
  } finally {
    for (const claim of claims.reverse()) releaseClaim(...claim);
  }
}
