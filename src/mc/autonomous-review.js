/** Independent review lifecycle. Only the runner seam calls this. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { captureWorktree } from './session-gate-evidence.js';
import { sessionGit, sessionGitDir, reconcileSessionGate } from './session-recovery.js';
import { readAutonomousState, startAutonomousReview, recordAutonomousReview } from './autonomous-state.js';
import { STABLE_ID_RE } from './goal-contract.js';
import { PLAN_FILE } from './plan-source.js';
import { builderModels, independentModel } from './autonomous-models.js';
import { reviewDigest, reviewInputProblems, cleanReviewInput, unknownReviewInput } from './autonomous-review-report.js';
import { prepareReviewProcess, readReviewProcess, recordReviewTerminal, reviewProcessStatus, withReviewProcessClaim, writeReviewFact } from './autonomous-review-process.js';
const git = (cwd, ...args) => sessionGit(cwd, args).trim();
const read = o => readAutonomousState(o.root, o.programme, o.project);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Include ignored additions too. Review has no permission to change its checkout. */
export function reviewCheckoutFingerprint(cwd) {
  const ignored = sessionGit(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const extra = ignored.map(file => {
    const path = join(cwd, file); const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('unknown review checkout content');
    return [file, stat.mode, hash(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path))];
  });
  return reviewDigest({ content: captureWorktree(cwd), ignored: extra, head: git(cwd, 'rev-parse', 'HEAD'),
    branch: git(cwd, 'branch', '--show-current'), index: git(cwd, 'write-tree'), status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all') });
}
export function publishedReviewHead(cwd, state) {
  const p = state.publication;
  if (p?.phase !== 'handoff_committed' || !/^[a-f0-9]{40}$/u.test(p.head || '')
    || p.goal_revision !== state.goal_revision
    || p.pr !== state.ownership.pr || p.branch !== state.ownership.branch) throw new Error('settled published head required');
  git(cwd, 'check-ref-format', `refs/heads/${p.branch}`);
  const remote = git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${p.branch}`).split(/\s+/u)[0];
  if (remote !== p.head) throw new Error('published review head moved or is unknown');
  return p.head;
}
export function prepareAutonomousReview(options) {
  if (options.actor?.role !== 'review' || !STABLE_ID_RE.test(options.actor.run_id || '')) throw new Error('explicit stable review run required');
  const state = read(options);
  if (state.active_run || state.phase !== 'review_ready') throw new Error('project is not review ready');
  if (!independentModel(options.model, builderModels(state))) throw new Error('builder-model reuse is not independent review');
  const head = publishedReviewHead(options.cwd, state);
  // Fetch into the source, never sync or change the builder's branch/index.
  git(options.cwd, 'fetch', '--no-tags', 'origin', `refs/heads/${state.ownership.branch}`);
  git(options.cwd, 'fetch', '--no-tags', 'origin', 'main');
  const integrationBase = git(options.cwd, 'rev-parse', 'FETCH_HEAD');
  const base = git(options.cwd, 'merge-base', head, integrationBase);
  const checkout = join(options.root, 'runner', 'reviews', options.actor.run_id, 'checkout');
  mkdirSync(dirname(checkout), { recursive: true });
  // No reuse/reset: an interrupted review's checkout remains evidence.
  git(options.cwd, 'worktree', 'add', '--detach', checkout, head);
  const session = { schema: 'mc-autonomous-review-session', version: 1, run_id: options.actor.run_id,
    assignment: state.contract, assignment_digest: reviewDigest(state.contract),
    criteria_digest: reviewDigest(state.contract.success_criteria), head, base, integration_base: integrationBase,
    branch: state.ownership.branch, pr: state.ownership.pr, model: options.model,
    builders: builderModels(state), verification: structuredClone(state.evidence.builder), gate_run: state.publication.gate_run, checkout,
    fingerprint: reviewCheckoutFingerprint(checkout) };
  prepareReviewProcess(options, session, reviewCheckoutFingerprint(options.cwd));
  return startAutonomousReview(options.root, options.programme, options.project,
    { actor: options.actor, revision: state.revision, session });
}

/** A missing/broken/interrupted result is still a durable criterion-complete
 * report for plan, not success and never a request to a repair role. */
export function completeAutonomousReview(options, processResult, { invalidReasons = [], record = recordAutonomousReview } = {}) {
  const state = read(options);
  const previous = state.review_reports?.find(report => report.id === options.actor.run_id);
  if (previous) return state;
  const session = state.review_session;
  if (!session || session.run_id !== options.actor.run_id || !['reviewing', 'plan_pending'].includes(state.phase) || !isDeepStrictEqual(state.active_run, options.actor)) throw new Error('active review ownership required');
  const initial = reviewProcessStatus(options);
  if (initial.kind === 'live' || (initial.kind === 'unknown' && initial.attempt.spawn_intent && processResult?.process_closed !== true)) throw new Error(`review process ${initial.kind}; ownership retained`);
  return withReviewProcessClaim(options, claimMarker => {
    let attempt = readReviewProcess(options);
    if (!isDeepStrictEqual(attempt.manifest.session, session)) throw new Error('review process session binding changed');
    if (!attempt.terminal) {
      // Before spawn intent, no child could have been launched by this protocol.
      // Afterwards only explicit native supervisor closure can settle ownership.
      if (!attempt.spawn_intent) recordReviewTerminal(options, { status: 1, not_spawned: true,
        process_closed: true, group_dead: true, tools_closed: true, normal_exit: false, interrupted: true });
      else if (processResult?.process_closed === true) recordReviewTerminal(options, processResult);
    }
    const observed = reviewProcessStatus(options, { claimMarker });
    if (!['completed', 'incomplete'].includes(observed.kind)) throw new Error(`review process ${observed.kind}; ownership retained`);
    attempt = observed.attempt;
    processResult = attempt.terminal.result;
    const gate = reconcileSessionGate(sessionGitDir(session.checkout));
    if (!gate.ok) throw new Error(`review recovery required: ${gate.reason}; ownership retained`);
    const invalid = [...(attempt.report?.report.invalid_reasons || []), ...invalidReasons];
    if (gate.gate && gate.gate.code !== 0) invalid.push('review gate did not complete successfully');
    if (observed.kind !== 'completed') invalid.push('review process did not complete successfully');
    if (!isDeepStrictEqual(state.contract, session.assignment)
      || session.assignment_digest !== reviewDigest(session.assignment)
      || session.criteria_digest !== reviewDigest(session.assignment.success_criteria)) invalid.push('review assignment changed');
    if (session.pr !== state.ownership.pr || session.branch !== state.ownership.branch
      || session.gate_run !== state.publication?.gate_run || !isDeepStrictEqual(session.verification, state.evidence.builder)
      || !isDeepStrictEqual(session.builders, builderModels(state)) || !isDeepStrictEqual(session.model, state.reviewer_model)) invalid.push('review evidence binding changed');
    try {
      const sent = JSON.parse(readFileSync(join(options.root, 'programs', options.programme, options.project, PLAN_FILE), 'utf8'));
      if (!isDeepStrictEqual(sent, session.assignment)) invalid.push('review sent assignment changed');
      if (sessionGitDir(options.cwd) !== attempt.manifest.source_git_dir || sessionGitDir(session.checkout) !== attempt.manifest.checkout_git_dir) invalid.push('review checkout identity changed');
      if (reviewCheckoutFingerprint(options.cwd) !== attempt.manifest.source_fingerprint) invalid.push('review source checkout changed');
      if (reviewCheckoutFingerprint(session.checkout) !== session.fingerprint) invalid.push('review checkout changed');
      if (publishedReviewHead(options.cwd, state) !== session.head) invalid.push('review publication changed');
      if (git(options.cwd, 'merge-base', session.head, session.integration_base) !== session.base) invalid.push('review comparison base changed');
      if (!independentModel(session.model, builderModels(state))) invalid.push('reviewer built reviewed changes');
    } catch (error) { invalid.push(error.message); }
    let result = state.review_submission;
    const problems = reviewInputProblems(result, session.assignment);
    if (problems.length) {
      invalid.push(...problems);
      result = unknownReviewInput(session.assignment, 'missing or invalid independent review submission');
    }
    const report = { schema: 'mc-autonomous-review-report', version: 1, id: options.actor.run_id,
      session_digest: reviewDigest(session), session, result,
      invalid_reasons: [...new Set(invalid)], clean: !invalid.length && cleanReviewInput(result, session.assignment) };
    // Report first, owner release second. A retry must reproduce the same report;
    // changed checkout/publication after report persistence retains ownership.
    writeReviewFact(attempt.paths.report, { generation: attempt.manifest.generation,
      manifest_digest: reviewDigest(attempt.manifest), report });
    return record(options.root, options.programme, options.project,
      { actor: options.actor, revision: state.revision, report });
  });
}
