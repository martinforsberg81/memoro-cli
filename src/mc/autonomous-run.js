/** Inactive dynamic step dispatcher. Only createRunner's injected capability
 * admits v2. A process exit is not publication, continuation or completion. */
import { mainIncidentHold, mainRepairPreflight, readProgrammeIncidents } from './programme-recovery.js';
import { captureWorktree } from './session-gate-evidence.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readAutonomousState, readProgrammeState, startAutonomousBuild, observeProjectSessionControl } from './autonomous-state.js';
import { validateAutonomousProject } from './autonomous-project.js';
import { buildSessionStart, readCurrentHandoff } from './session-handoff.js';
import { projectSessionObserver } from './session-supervision.js';
import { reconcilePreviousSession, retirePreviousSession, sessionGitDir } from './session-recovery.js';
import { instructionsFor, roleRecord, roleSourceOf } from './roles.js';
import { headlessArgs, routedSettings } from './run-plan.js';
import { profileArgs } from './portrait.js';
import { run as gateCommand } from './commands/gate.js';
import { autonomousBuildClaim, autonomousBuildHeld, incompleteAutonomousBuild, recoverAutonomousBuild, settlePublishedBuild } from './autonomous-recovery.js';
import { prepareAutonomousReview, completeAutonomousReview } from './autonomous-review.js';
import { beginReviewProcess } from './autonomous-review-process.js';
import { recoverAutonomousReview, verifyReviewPr } from './autonomous-review-recovery.js';
import { SESSION_START_MAX_BYTES } from './session-handoff.js';
import { reviewRoutePending, routeAutonomousReview } from './autonomous-outcomes.js';
import { takeClaim, releaseClaim } from './resource-claim.js';
import { gatewayLaunch } from './billing-route.js';
import { PROVIDER_API_ENV_NAMES } from './runtime-secrets.js';

export function autonomousChoice({ root, record, capability, openPrs = [], worktree = null }) {
  const skip = (reason, text) => ({ kind: null, reason, skip: text });
  if (!capability) return skip('autonomous-disabled', 'autonomous execution is disabled');
  const assignment = record?.plan;
  const valid = validateAutonomousProject(assignment);
  if (!valid.ok) return skip('unparseable', valid.problems.join('; '));
  if (assignment.project_id !== record.project || assignment.programme.id !== record.programme || assignment.repo !== record.repo) return skip('assignment-mismatch', 'project identity does not match its location');
  try {
    const state = readAutonomousState(root, record.programme, record.project);
    const agreement = readProgrammeState(root, record.programme);
    const journal = agreement.planner_jobs;
    const reviewRecovery = state.active_run?.role === 'review' && capability.review;
    if (!reviewRecovery && !isDeepStrictEqual(state.contract, assignment)) return skip('assignment-mismatch', 'sent and current assignments differ');
    if (autonomousBuildHeld({ root, programme: record.programme, project: record.project })) return skip('autonomous-owned', 'another builder or reconciler owns the project');
    if (reviewRecovery) return { kind: 'review', flavor: 'autonomous', recovery: true };
    if (state.active_run) {
      if (worktree && (state.phase !== 'plan_pending' || journal) && state.active_run.role === 'step') return { kind: 'step', flavor: 'autonomous', recovery: true };
      return skip('autonomous-owned', `project is owned by ${state.active_run.run_id}; preserve its tree until recovery`);
    }
    if (mainIncidentHold(root, record.programme, record.project)) return skip('main-incident', 'shared main repair awaits its owning programme plan');
    if (capability.review && reviewRoutePending(root, state)) return { kind: 'review', flavor: 'autonomous', routing: true };
    if (state.phase === 'review_ready' && capability.review) return { kind: 'review', flavor: 'autonomous' };
    if (state.phase !== 'ready') return skip('autonomous-not-ready', `autonomous project is ${state.phase}`);
    if (openPrs.some(pr => pr.number !== state.ownership.pr || pr.headRefName !== state.ownership.branch)) return skip('autonomous-pr-mismatch', 'an open PR does not match project ownership');
    return { kind: 'step', flavor: 'autonomous' };
  } catch (error) { return skip('autonomous-state', error.message); }
}

export async function runAutonomousBuild({ root, record, repo, worktree, areaName, lane, pid, paths, deps, capability,
  openPrs, waitForSlot, dropSlot, routeClass, syncMain, writeJson, remove, stamp, say, observeResult }) {
  const choice = autonomousChoice({ root, record, capability, openPrs, worktree });
  if (!choice.kind) { say(`${record.project}: ${choice.skip}`); return `skipped:${choice.reason}`; }
  if (choice.routing) {
    const routed = await routeAutonomousReview({ root, programme: record.programme, project: record.project,
      repoPath: repo.path, env: deps.env, gh: deps.gh, start: deps.startMerger });
    say(`${record.project}: independent review continuation: ${routed.queued ? 'queued for merger' : routed.reason}`);
    return 'ran';
  }
  if (choice.kind === 'review' && !choice.recovery) return runAutonomousReview({ root, record, repo, worktree, lane, pid, paths, deps,
    waitForSlot, dropSlot, routeClass, writeJson, remove, stamp, say, observeResult });
  const name = record.project; const programme = record.programme;
  if (choice.recovery) {
    const slot = await waitForSlot(name);
    if (slot !== 'ok') return slot === 'stop' ? 'stop' : 'skipped';
    const path = autonomousBuildClaim({ root, programme, project: name });
    const held = takeClaim(path, { pid, project: name });
    const currentPath = paths.currentFor(repo.name, lane);
    let currentWritten = false;
    try {
      if (!held.ok) return 'skipped:autonomous-owned';
      const state = readAutonomousState(root, programme, name);
      if (!state.active_run || state.active_run.role !== choice.kind) return 'skipped:autonomous-reconciled';
      const review = choice.kind === 'review';
      const cwd = review && !deps.exists(worktree) ? repo.path : worktree;
      writeJson(currentPath, { name, step: null, kind: choice.kind, flavor: review ? 'autonomous-review-recovery' : 'autonomous-recovery', run_id: state.active_run.run_id,
        repo: repo.name, lane, started: stamp(), pid, worktree: review ? state.review_session?.checkout || cwd : worktree });
      currentWritten = true;
      const options = { root, programme, project: name, actor: state.active_run, cwd, env: deps.env };
      const recovered = review ? await recoverAutonomousReview(options, { gh: deps.gh })
        : await recoverAutonomousBuild(options, capability.publication || {});
      say(`${name}: recovered ${state.active_run.run_id}: ${recovered.phase}`);
      if (review && !recovered.active_run && recovered.review_reports?.at(-1)?.clean) {
        const routed = await routeAutonomousReview({ root, programme, project: name, repoPath: repo.path,
          env: deps.env, gh: deps.gh, start: deps.startMerger });
        say(`${name}: recovered review continuation: ${routed.queued ? 'queued for merger' : routed.reason}`);
      }
      return 'ran';
    } finally {
      if (currentWritten) remove(currentPath);
      if (held.ok) releaseClaim(path, held.marker);
      dropSlot();
    }
  }
  const route = routeClass('fast', readAutonomousState(root, programme, name));
  if (!route.ok) return 'skipped:no-capacity';
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
  const claimPath = autonomousBuildClaim(options);
  const held = takeClaim(claimPath, { pid, run_id: actor.run_id });
  if (!held.ok) { dropSlot(); return 'skipped:autonomous-owned'; }
  let owned = false;
  let currentWritten = false;
  try {
    // Another runner can have claimed while this one waited for capacity.
    let state = readAutonomousState(root, programme, name);
    const branchOwned = state.ownership.branch !== null;
    const branch = state.ownership.branch || name;
    state = startAutonomousBuild(root, programme, name, { actor, revision: state.revision, assignment: record.plan,
      branch, model: route.candidate, reviewer: route.reviewer, profile: capability.profile, observation: { sequence: 0, ...capability.clock(),
        activity: { kind: 'tool', id: 'main-integration' }, context: null, progress: null, failure: null } });
    owned = true;
    writeJson(currentPath, { name, step: null, kind: 'step', flavor: 'autonomous', run_id: actor.run_id,
      repo: repo.name, lane, tool: settings.tool, model: settings.model, effort: settings.effort, class: 'fast',
      billing: route.billing || 'plan', started: stamp(), pid, worktree, role: roleRecord({ name: 'step', source: roleSourceOf(role) || 'canon', overlay, instructions }) });
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
    const agreement = readProgrammeState(root, programme).metadata;
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
    if (previousRunId) retirePreviousSession(sessionGitDir(worktree), previousRunId);
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
    const repair = readProgrammeIncidents(root).some(item => item.status === 'open' && item.owner === programme && item.repair?.project === name);
    let startingOutput = '';
    const output = { write: text => { startingOutput += text; say(`${name}: starting gate: ${text.trimEnd()}`); } };
    const observeActivity = activity => {
      const current = readAutonomousState(root, programme, name);
      return observeProjectSessionControl(root, programme, name, { actor, revision: current.revision,
        observation: { sequence: current.session_control.observation.sequence + 1, ...capability.clock(),
          activity, context: null, progress: null, failure: null } });
    };
    observeActivity({ kind: 'gate', id: 'starting-gate' });
    const gate = await (capability.gate || gateCommand)(repair ? ['--json'] : [], { cwd: worktree, env: deps.env, stdout: output, stderr: output });
    if (gate !== 0) {
      let allowed = false;
      try { allowed = repair && mainRepairPreflight({ root, programme, project: name, summary: JSON.parse(startingOutput), content: captureWorktree(worktree), base: git(['rev-parse', 'origin/main']) }); } catch { /* unknown is not a diagnosed red */ }
      if (!allowed) throw new Error('starting gate did not complete successfully');
      say(`${name}: starting gate remains red on the assigned main incident; repair must still publish a complete green gate`);
    }
    observeActivity({ kind: 'model', id: null });
    const observer = projectSessionObserver({ ...options, verify: capability.verify });
    if (observer.control.phase !== 'running') throw new Error('starting integration/gate exhausted the session budget');
    const directory = join(paths.scratch, actor.run_id);
    deps.mkdir(paths.scratch);
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, ...settings, instructions, prompt, profileArgs, cache: role.cache });
    const tool = gatewayLaunch({ provider: settings.tool, model: settings.model, bin: launch.spec.bin, args, billing: route.billing });
    const result = await deps.session({ bin: tool.bin, args: tool.args, cwd: worktree, prompt,
      env: { MC_AUTONOMOUS_RUN: actor.run_id, MC_AUTONOMOUS_ROLE: 'step', MC_PROJECT: name,
        MC_REPO: repo.name, MC_WORKAREA: worktree, MC_SCRATCH: directory },
      unsetEnv: [...PROVIDER_API_ENV_NAMES, 'MC_STEP'],
      autonomous: { version: 1, tool: launch.id, ...observer, clock: capability.clock,
        directory, pollMs: capability.pollMs },
    });
    observeResult(launch.id, result);
    if (!result.normal_exit || !result.recovery_ready || !result.control_persisted) throw new Error(result.reason || 'incomplete autonomous process');
    const closing = readAutonomousState(root, programme, name);
    if (closing.publication?.run_id === actor.run_id) {
      const settled = await settlePublishedBuild({ ...options, cwd: worktree, env: deps.env }, result, capability.publication || {});
      say(`${name}: ${actor.run_id} published: ${settled.phase}`);
    } else throw new Error('process exit has no verified publication');
    return 'ran';
  } catch (error) {
    say(`${name}: autonomous build stopped: ${error.message}`);
    if (owned) {
      incompleteAutonomousBuild({ ...options, cwd: worktree }, error.message);
      if (readProgrammeState(root, programme).planner_jobs) await recoverAutonomousBuild({ ...options, cwd: worktree }, capability.publication || {});
    }
    return owned ? 'ran' : 'skipped:autonomous-owned';
  } finally {
    if (currentWritten) remove(currentPath);
    releaseClaim(claimPath, held.marker);
    dropSlot();
  }
}

/** Same lane/slot accounting as builders; never the builder checkout or overlay. */
export async function runAutonomousReview({ root, record, repo, worktree, lane, pid, paths, deps,
  waitForSlot, dropSlot, routeClass, writeJson, remove, stamp, say, observeResult }) {
  const name = record.project; const programme = record.programme;
  const state = readAutonomousState(root, programme, name);
  const route = routeClass('fast', state, 'review');
  if (!route.ok) { say(`${name}: review waits: ${route.reason || 'no model candidate'}`); return 'skipped:no-capacity'; }
  const role = deps.role('review');
  if (!role?.overlay) return 'skipped:role-missing';
  const settings = routedSettings(null, null, { kind: 'step', candidate: route.candidate });
  const launch = deps.launch(settings.tool);
  if (!launch?.ok) return 'skipped:tool-missing';
  const slot = await waitForSlot(name);
  if (slot !== 'ok') return slot === 'stop' ? 'stop' : 'skipped';
  const claimPath = autonomousBuildClaim({ root, programme, project: name });
  const held = takeClaim(claimPath, { pid, project: name });
  if (!held.ok) { dropSlot(); return 'skipped:autonomous-owned'; }
  const actor = { run_id: `review-${randomUUID()}`, role: 'review' };
  const options = { root, programme, project: name, actor, cwd: deps.exists(worktree) ? worktree : repo.path, model: route.candidate };
  const currentPath = paths.currentFor(repo.name, lane);
  let reserved = false; let currentWritten = false;
  const verifyPr = session => verifyReviewPr(options, session, deps.gh);
  try {
    const started = prepareAutonomousReview(options); reserved = true;
    const session = started.review_session;
    await verifyPr(session);
    const overlay = '@include _review-autonomous.md';
    const instructions = instructionsFor(settings.tool, overlay);
    const agreement = readProgrammeState(root, programme).metadata;
    const prompt = JSON.stringify({ programme: agreement, session, target: `${programme}/${name}`, state_revision: started.revision });
    if (Buffer.byteLength(prompt) > SESSION_START_MAX_BYTES) throw new Error('review assignment exceeds bounded start context');
    const directory = join(root, 'runner', 'reviews', actor.run_id, 'artifacts'); deps.mkdir(directory);
    writeJson(currentPath, { name, step: null, kind: 'review', flavor: 'autonomous-review', run_id: actor.run_id,
      repo: repo.name, lane, ...settings, billing: route.billing || 'plan', started: stamp(), pid, worktree: session.checkout,
      role: roleRecord({ name: 'review', source: 'canon', overlay, instructions }) });
    currentWritten = true;
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, ...settings, instructions, prompt, profileArgs, cache: role.cache });
    const tool = gatewayLaunch({ provider: settings.tool, model: settings.model, bin: launch.spec.bin, args, billing: route.billing });
    beginReviewProcess(options);
    const result = await deps.session({ bin: tool.bin, args: tool.args, cwd: session.checkout, prompt,
      reviewProcess: { options, tool: launch.id },
      env: { MC_AUTONOMOUS_RUN: actor.run_id, MC_AUTONOMOUS_ROLE: 'review', MC_PROJECT: name,
        MC_WORK_ROOT: root, MC_REPO: repo.name, MC_WORKAREA: session.checkout, MC_SCRATCH: directory },
      unsetEnv: [...PROVIDER_API_ENV_NAMES, 'MC_STEP'] });
    observeResult(launch.id, result);
    const invalidReasons = [];
    try { await verifyPr(session); } catch (error) { invalidReasons.push(error.message); }
    const finished = completeAutonomousReview(options, result, { invalidReasons });
    const routed = await routeAutonomousReview({ root, programme, project: name, repoPath: repo.path, env: deps.env, gh: deps.gh, start: deps.startMerger });
    say(`${name}: independent review recorded for plan (${finished.review_reports.at(-1).clean ? 'clean' : 'findings or unknown'}); ${routed.queued ? 'queued for merger' : `nothing queued: ${routed.reason}`}`);
    return 'ran';
  } catch (error) {
    say(`${name}: independent review stopped: ${error.message}`);
    if (reserved) {
      try { completeAutonomousReview(options, null, { invalidReasons: [error.message] }); }
      catch (failure) { say(`${name}: ${failure.message}`); }
    }
    return reserved ? 'ran' : 'skipped:review-wait';
  } finally {
    if (currentWritten) remove(currentPath);
    releaseClaim(claimPath, held.marker);
    dropSlot();
  }
}
