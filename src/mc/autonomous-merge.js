/** Current autonomous admission, shared by queueing and the leased merger.
 * Reports remain observations; this module neither repairs nor confirms goals. */
import { mainIncidentHold } from './programme-recovery.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runAsync as runGitAsync } from './git.js';
import { mcHome } from './paths.js';
import { PLAN_FILE } from './plan-source.js';
import { readAutonomousState, readProgrammeState, currentAutonomousEvidence } from './autonomous-state.js';
import { validateAutonomousProject } from './autonomous-project.js';
import { builderModels, independentModel } from './autonomous-models.js';
import { reviewDigest, cleanReviewInput } from './autonomous-review-report.js';
import { reviewCheckoutFingerprint } from './autonomous-review.js';
import { readCurrentHandoff } from './session-handoff.js';
import { captureWorktree, sameContent } from './session-gate-evidence.js';
import { readGreenReceipt, fullCoverage, checksHash } from './gate-greens.js';
import { publicationGateSelection } from './commands/gate.js';

const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
// queueMerge is a synchronous v1 API. A freshly measured in-process ticket is
// required there; deserialised queue tickets are revalidated by the async door.
const issued = new WeakMap();
export function assertAutonomousQueueAdmission({ root, owner, pr, ticket }) {
  const measured = ticket && issued.get(ticket);
  requireThat(measured && measured.root === root && isDeepStrictEqual(measured.owner, owner)
    && Date.now() >= measured.at && Date.now() - measured.at <= 30_000
    && isDeepStrictEqual(measured.ticket, ticket)
    && isDeepStrictEqual(autonomousProof({ root, owner, pr }).ticket, ticket),
    'fresh complete autonomous admission required before queueing');
  issued.delete(ticket);
}

/** Synchronous facts also checked before the queue writes. The durable ticket
 * carries identities, not permission to skip later reads or measurement. */
export function autonomousProof({ root, owner, pr }) {
  requireThat(owner.pr === Number(pr), 'autonomous publication has no resolved PR ownership');
  const state = readAutonomousState(root, owner.programme, owner.project);
  requireThat(!mainIncidentHold(root, owner.programme, owner.project), 'shared main repair awaits its owning programme plan');
  const assignment = state.contract;
  const sent = JSON.parse(readFileSync(join(root, 'programs', owner.programme, owner.project, PLAN_FILE), 'utf8'));
  requireThat(isDeepStrictEqual(sent, assignment) && assignment.repo === owner.repo, 'autonomous sent assignment changed or is invalid');
  const agreement = readProgrammeState(root, owner.programme);
  const programme = agreement.metadata;
  requireThat(validateAutonomousProject(assignment, { programme: programme || null }).ok, 'programme identity is missing or invalid');
  requireThat(!state.active_run && ['plan_pending', 'landing'].includes(state.phase) && !state.confirmed,
    'autonomous work is incomplete, active or already confirmed');
  const p = state.publication;
  requireThat(p?.phase === 'handoff_committed' && sha(p.head) && p.branch === owner.branch && p.pr === owner.pr
    && /^[a-zA-Z0-9-]+$/u.test(p.gate_run || '')
    && state.ownership.branch === owner.branch && state.ownership.pr === owner.pr
    && p.goal_revision === state.goal_revision
    && p.handoff === state.current_handoff, 'settled current autonomous publication required');
  const handoff = readCurrentHandoff({ root, assignment, programme, runId: p.run_id });
  requireThat(handoff?.observed.normal_exit && handoff.artifact === p.handoff && handoff.observed.head === p.head
    && handoff.observed.pushed === p.head && handoff.observed.tree === p.tree
    && handoff.observed.branch === owner.branch && handoff.observed.pr === owner.pr,
  'current durable normal handoff is missing or invalid');
  const report = state.review_reports?.at(-1);
  const session = report?.session;
  requireThat(!(state.merge_handoff?.status === 'answered' && state.merge_handoff.binding.report_id === report?.id),
    'autonomous merge outcome requires plan and renewed evidence');
  requireThat(report?.schema === 'mc-autonomous-review-report' && report.version === 1 && report.clean === true
    && Array.isArray(report.invalid_reasons) && report.invalid_reasons.length === 0
    && session?.schema === 'mc-autonomous-review-session' && session.version === 1
    && report.id === session.run_id && report.session_digest === reviewDigest(session)
    && session.assignment_digest === reviewDigest(assignment) && session.criteria_digest === reviewDigest(assignment.success_criteria)
    && isDeepStrictEqual(session, state.review_session)
    && isDeepStrictEqual(session.assignment, assignment) && cleanReviewInput(report.result, assignment),
  'complete current clean independent review required');
  requireThat(session.head === p.head && session.pr === p.pr && session.branch === p.branch && session.gate_run === p.gate_run
    && sha(session.base) && sha(session.integration_base) && isDeepStrictEqual(session.model, state.reviewer_model)
    && independentModel(session.model, builderModels(state)) && isDeepStrictEqual(session.builders, builderModels(state)),
  'review publication or independent model binding changed');
  requireThat(isDeepStrictEqual(session.verification, state.evidence.builder), 'criterion evidence changed after independent review');
  const current = currentAutonomousEvidence(state);
  const latest = new Map(current.builder.map(item => [item.criterion_id, item]));
  const published = new Map(handoff.handoff.evidence.map(item => [item.criterion_id, item]));
  const proofs = assignment.success_criteria.filter(item => item.verification === 'premerge').map(item => {
    const proof = latest.get(item.id);
    requireThat(proof?.status === 'verified' && published.get(item.id)?.reference === proof.reference,
      `premerge criterion ${item.id} lacks current published verified evidence`);
    return proof.id;
  });
  const observation = current.reviews.find(item => item.id === report.id);
  requireThat(observation && observation.reference === report.reference && !observation.findings.length,
    'durable independent review observation is missing or has findings');
  const ticket = { schema: 'mc-autonomous-merge-admission', version: 1, repo: owner.repo, programme: owner.programme,
    project: owner.project, pr: owner.pr, branch: owner.branch, head: p.head,
    goal_revision: state.goal_revision,
    assignment_digest: reviewDigest(assignment), review_id: report.id, review_digest: reviewDigest(report),
    gate_run: p.gate_run, builder_evidence: proofs, handoff: p.handoff };
  return { state, publication: p, session, ticket, handoff };
}

/** Test independence is not semantic independence: disjoint paths (including
 * another project's docs) can still be inputs to the reviewed code. Equal
 * integration trees prove no changed input; anything less stays conservative. */
export function reviewRelevance({ paths, assignment, reviewedFiles, fromTree, toTree }) {
  if (sha(fromTree) && fromTree === toTree) return 'unrelated';
  if (!Array.isArray(paths) || !paths.length || !Array.isArray(reviewedFiles) || !reviewedFiles.length) return 'unknown';
  const scope = JSON.stringify(assignment);
  return paths.some(path => reviewedFiles.includes(path) || scope.includes(path)) ? 'review-required' : 'unknown';
}

export async function autonomousAdmission({ root, repoPath, pr, owner, view, env = process.env,
  git = null, route = 'merger', expected = undefined, base = null, head = null, requirements = publicationGateSelection }) {
  try {
    requireThat(route === 'merger', 'autonomous changes must use the leased merger, never docs/admin shortcuts');
    const proof = autonomousProof({ root, owner, pr });
    const { state, publication: p, session, ticket, handoff } = proof;
    if (expected !== undefined) requireThat(isDeepStrictEqual(expected, ticket), 'queued autonomous evidence is missing, stale or changed');
    requireThat(view?.number === Number(pr) && view.state === 'OPEN' && view.headRefName === owner.branch
      && view.headRefOid === p.head && view.baseRefName === 'main' && (head === null || head === p.head),
    'published autonomous PR head or base moved or is unknown');
    const ask = git || ((args, options = {}) => runGitAsync(options.cwd, args, { env }));
    const command = async args => {
      const result = await ask(args, { cwd: repoPath });
      requireThat(result?.status === 0 || result?.ok === true, `autonomous merge cannot read git ${args[0]}`);
      return String(result.stdout || '').trim();
    };
    const remote = (await command(['ls-remote', '--heads', 'origin', `refs/heads/${owner.branch}`])).split(/\s+/u)[0];
    requireThat(remote === p.head, 'published autonomous remote head changed or is unknown');
    await command(['fetch', '--no-tags', 'origin', 'main']);
    const liveBase = await command(['rev-parse', 'FETCH_HEAD']);
    requireThat(sha(liveBase) && (base === null || liveBase === base), 'autonomous integration base changed during landing');
    if (liveBase !== session.integration_base) {
      await command(['merge-base', '--is-ancestor', session.integration_base, liveBase]);
      const paths = (await command(['diff', '--name-only', '--no-renames', `${session.integration_base}..${liveBase}`])).split('\n').filter(Boolean);
      const reviewedFiles = (await command(['diff', '--name-only', `${session.base}..${session.head}`])).split('\n').filter(Boolean);
      const fromTree = await command(['rev-parse', `${session.integration_base}^{tree}`]);
      const toTree = await command(['rev-parse', `${liveBase}^{tree}`]);
      requireThat(reviewRelevance({ paths, assignment: state.contract, reviewedFiles, fromTree, toTree }) === 'unrelated',
        'related or unknown main movement requires renewed independent review');
    }
    requireThat(reviewCheckoutFingerprint(session.checkout) === session.fingerprint, 'independent review checkout changed or is missing');
    const content = captureWorktree(session.checkout);
    const raw = JSON.parse(readFileSync(join(mcHome(env), 'gate-evidence', `${p.gate_run}.json`), 'utf8'));
    const required = await requirements(session.checkout, env, { baseCommit: raw.base });
    const receipt = readGreenReceipt({ root: mcHome(env), repo: owner.repo, repository: content.repository,
      run: p.gate_run, sessionRun: p.run_id, goalRevision: state.goal_revision, configuration: required.configuration });
    requireThat(receipt && fullCoverage(receipt.coverage) && sameContent(receipt, content) && receipt.tree === p.tree
      && receipt.base === required.base && checksHash(receipt.coverage) === checksHash(required.selection)
      && handoff.observed.gate === join(mcHome(env), 'gate-evidence', `${p.gate_run}.json`),
    'complete relevant published green gate evidence is missing, stale or insufficient');
    // State may have moved while git/selector ran. No stale result is returned.
    requireThat(isDeepStrictEqual(autonomousProof({ root, owner, pr }).ticket, ticket), 'autonomous evidence changed during admission');
    // Bind the actual measured value, not only the caller-owned object's
    // identity: changing a ticket cannot manufacture a fresh measurement.
    issued.set(ticket, { at: Date.now(), root, owner: structuredClone(owner), ticket: structuredClone(ticket) });
    return { checked: true, ok: true, problems: [], autonomous: ticket,
      evidence: { repository: receipt.repository, run: receipt.run, sessionRun: p.run_id, goalRevision: state.goal_revision } };
  } catch (error) {
    return { checked: true, ok: false, stop: 'autonomous-review-required', problems: [error.message] };
  }
}
