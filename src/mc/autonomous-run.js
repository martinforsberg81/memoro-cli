/** Inactive dynamic step dispatcher. Only createRunner's injected capability
 * admits v2. A process exit is not publication, continuation or completion. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readAutonomousState, readProgrammeState, startAutonomousBuild, mutateAutonomousProject, observeProjectSessionControl } from './autonomous-state.js';
import { validateAutonomousProject } from './autonomous-project.js';
import { buildSessionStart, readCurrentHandoff } from './session-handoff.js';
import { projectSessionObserver } from './session-supervision.js';
import { reconcilePreviousSession, sessionGitDir } from './session-recovery.js';
import { instructionsFor, roleRecord, roleSourceOf } from './roles.js';
import { headlessArgs, routedSettings } from './run-plan.js';
import { profileArgs } from './portrait.js';
import { run as gateCommand } from './commands/gate.js';

export function autonomousChoice({ root, record, capability, openPrs = [] }) {
  const skip = (reason, text) => ({ kind: null, reason, skip: text });
  if (!capability) return skip('autonomous-disabled', 'autonomous execution is disabled');
  const assignment = record?.plan;
  const valid = validateAutonomousProject(assignment);
  if (!valid.ok) return skip('unparseable', valid.problems.join('; '));
  if (assignment.project_id !== record.project || assignment.programme.id !== record.programme || assignment.repo !== record.repo) return skip('assignment-mismatch', 'project identity does not match its location');
  try {
    const state = readAutonomousState(root, record.programme, record.project);
    if (!isDeepStrictEqual(state.contract, assignment)) return skip('assignment-mismatch', 'sent and current assignments differ');
    if (state.active_run) return skip('autonomous-owned', `project is owned by ${state.active_run.run_id}; preserve its tree until recovery`);
    if (state.phase !== 'ready') return skip('autonomous-not-ready', `autonomous project is ${state.phase}`);
    if (openPrs.some(pr => pr.number !== state.ownership.pr || pr.headRefName !== state.ownership.branch)) return skip('autonomous-pr-mismatch', 'an open PR does not match project ownership');
    return { kind: 'step', flavor: 'autonomous' };
  } catch (error) { return skip('autonomous-state', error.message); }
}

export async function runAutonomousBuild({ root, record, repo, worktree, areaName, lane, pid, paths, deps, capability,
  openPrs, waitForSlot, dropSlot, routeClass, syncMain, writeJson, remove, stamp, say, observeResult }) {
  const choice = autonomousChoice({ root, record, capability, openPrs });
  if (!choice.kind) { say(`${record.project}: ${choice.skip}`); return `skipped:${choice.reason}`; }
  const name = record.project; const programme = record.programme;
  const route = routeClass('fast');
  if (!route.ok || route.basis === 'credits') return 'skipped:no-capacity';
  const settings = routedSettings(null, null, { kind: 'step', candidate: route.candidate });
  // The autonomous flavor deliberately excludes v1's fixed-step/merge overlay.
  const role = deps.role('step');
  if (!role?.overlay) return 'skipped:role-missing';
  const overlay = '@include _step-autonomous.md';
  const instructions = instructionsFor(settings.tool, overlay);
  const launch = deps.launch(settings.tool);
  if (!launch?.ok) return 'skipped:tool-missing';
  const slot = await waitForSlot(name);
  if (slot !== 'ok') return slot === 'stop' ? 'stop' : 'skipped';
  const actor = { run_id: `build-${randomUUID()}`, role: 'step' };
  const currentPath = paths.currentFor(repo.name, lane);
  const options = { root, programme, project: name, actor };
  let owned = false;
  let currentWritten = false;
  try {
    // Another runner can have claimed while this one waited for capacity.
    let state = readAutonomousState(root, programme, name);
    const branchOwned = state.ownership.branch !== null;
    const branch = state.ownership.branch || name;
    state = startAutonomousBuild(root, programme, name, { actor, revision: state.revision, assignment: record.plan,
      branch, profile: capability.profile, observation: { sequence: 0, ...capability.clock(),
        activity: { kind: 'tool', id: 'main-integration' }, context: null, progress: null, failure: null } });
    owned = true;
    writeJson(currentPath, { name, step: null, kind: 'step', flavor: 'autonomous', run_id: actor.run_id,
      repo: repo.name, lane, tool: settings.tool, model: settings.model, effort: settings.effort, class: 'fast',
      started: stamp(), pid, worktree, role: roleRecord({ name: 'step', source: roleSourceOf(role) || 'canon', overlay, instructions }) });
    currentWritten = true;
    const existingTree = deps.exists(worktree);
    if (existingTree && !branchOwned) throw new Error('unowned worktree already exists');
    if (!existingTree) {
      if (!deps.git(repo.path, ['fetch', '-q', 'origin']).ok) throw new Error('initial fetch failed');
      // Never adopt a pre-existing unowned branch or rotate to a second one.
      if (!branchOwned && deps.git(repo.path, ['rev-parse', '--verify', `refs/heads/${branch}`]).ok) throw new Error('unowned branch already exists');
      const added = deps.addWorktree({ name: areaName, repo: repo.path, branch, from: 'origin/main', env: deps.env, attach: false });
      if (!added.ok) throw new Error(`worktree creation failed: ${added.reason}`);
    }
    const git = args => {
      const result = deps.git(worktree, args);
      if (!result.ok) throw new Error(`git ${args[0]} failed`);
      return result.stdout.trim();
    };
    const previous = reconcilePreviousSession(sessionGitDir(worktree));
    if (!previous.ok) throw new Error(`recovery required: ${previous.reason}`);
    if (git(['branch', '--show-current']) !== branch) throw new Error('checkout does not match the owned branch');
    if (git(['status', '--porcelain'])) throw new Error('unfinished tree requires deliberate recovery');
    const agreement = readProgrammeState(root, programme).approved.find(item => item.revision === state.programme_revision);
    let previousHandoff = null;
    let previousRunId = null;
    if (state.current_handoff) {
      previousRunId = state.runs.filter(run => run.role === 'step' && run.run_id !== actor.run_id).at(-1)?.run_id;
      previousHandoff = readCurrentHandoff({ root, assignment: state.contract, programme: agreement, runId: previousRunId });
      if (!previousHandoff || previousHandoff.artifact !== state.current_handoff || !previousHandoff.observed.normal_exit
        || previousHandoff.outcome !== 'continue') throw new Error('verified continuing handoff required');
    }
    // Build the entire bounded prompt before paying for a process. No transcript
    // or arbitrary earlier conversation is appended to this payload.
    const prompt = buildSessionStart({ assignment: state.contract, programme: agreement, runId: actor.run_id,
      previous: previousHandoff, previousRunId });
    const synced = syncMain(worktree, name, { resolveIgnore: false });
    if (synced.conflicts.length) {
      if (typeof capability.integrateConflicts !== 'function') throw new Error('main conflicts require step integration before building');
      await capability.integrateConflicts({ ...options, worktree, conflicts: synced.conflicts, instructions, prompt });
      if (git(['diff', '--name-only', '--diff-filter=U']) || deps.git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) throw new Error('main integration is unfinished');
    } else if (!synced.ok) throw new Error(`main integration failed: ${synced.why}`);
    if (git(['branch', '--show-current']) !== branch || !deps.git(worktree, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']).ok) throw new Error('current main is not integrated on the owned branch');
    await deps.attachDeps(worktree);
    // The capability uses the existing mc gate command and its affected-test
    // selection/reservations, never an unbounded direct test runner.
    const output = { write: text => say(`${name}: starting gate: ${text.trimEnd()}`) };
    const observeActivity = activity => {
      const current = readAutonomousState(root, programme, name);
      return observeProjectSessionControl(root, programme, name, { actor, revision: current.revision,
        observation: { sequence: current.session_control.observation.sequence + 1, ...capability.clock(),
          activity, context: null, progress: null, failure: null } });
    };
    observeActivity({ kind: 'gate', id: 'starting-gate' });
    const gate = await (capability.gate || gateCommand)([], { cwd: worktree, env: deps.env, stdout: output, stderr: output });
    if (gate !== 0) throw new Error('starting gate did not complete successfully');
    observeActivity({ kind: 'model', id: null });
    const observer = projectSessionObserver({ ...options, verify: capability.verify });
    if (observer.control.phase !== 'running') throw new Error('starting integration/gate exhausted the session budget');
    const directory = join(paths.scratch, actor.run_id);
    deps.mkdir(paths.scratch);
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, ...settings, instructions, prompt, profileArgs, cache: role.cache });
    const result = await deps.session({ bin: launch.spec.bin, args, cwd: worktree, prompt,
      env: { MC_AUTONOMOUS_RUN: actor.run_id, MC_AUTONOMOUS_ROLE: 'step', MC_PROJECT: name,
        MC_REPO: repo.name, MC_WORKAREA: worktree, MC_SCRATCH: directory },
      unsetEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MC_STEP'],
      autonomous: { version: 1, tool: launch.id, ...observer, clock: capability.clock,
        directory, pollMs: capability.pollMs },
    });
    observeResult(launch.id, result);
    if (!result.normal_exit || !result.recovery_ready || !result.control_persisted) throw new Error(result.reason || 'incomplete autonomous process');
    // Publication/reconciliation owns the next transition. Even exit 0 leaves
    // this durable owner in place; it cannot start a second builder or merge.
    say(`${name}: ${actor.run_id} process ended; awaiting verified publication`);
    return 'ran';
  } catch (error) {
    say(`${name}: autonomous build stopped: ${error.message}`);
    if (owned) {
      const state = readAutonomousState(root, programme, name);
      mutateAutonomousProject(root, programme, name, 'attempt', { id: actor.run_id, reason: error.message, commits: [], ...(state.current_handoff ? { handoff: state.current_handoff } : {}) }, { actor, revision: state.revision });
    }
    return owned ? 'ran' : 'skipped:autonomous-owned';
  } finally {
    if (currentWritten) remove(currentPath);
    dropSlot();
  }
}
