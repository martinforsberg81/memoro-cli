/** Inert v2 session contracts. Model interpretation is never an observed gate,
 * publication fact, planner confirmation or permission to start another run. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomic } from './atomic-write.js';
import { validateAutonomousProject } from './autonomous-project.js';
import { STABLE_ID_RE } from './goal-contract.js';
import { realLock } from './register.js';
import { captureWorktree, findPublicationReceipt, sameContent } from './session-gate-evidence.js';

export const HANDOFF_MAX_BYTES = 16 * 1024;
export const SESSION_RESULT_MAX_BYTES = 24 * 1024;
export const SESSION_START_MAX_BYTES = 64 * 1024;
export const SESSION_OUTCOMES = Object.freeze(['continue', 'review-ready', 'incomplete', 'needs-plan']);
const ARTIFACT_MAX_BYTES = 32 * 1024;
const MISSING = Symbol('missing session artifact');
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const bindingKeys = ['programme_id', 'project_id', 'goal_revision', 'run_id'];
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const text = value => typeof value === 'string' && value.trim().length > 0;
const id = value => typeof value === 'string' && STABLE_ID_RE.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValid = result => { if (!result.ok) throw new Error(result.problems.join('; ')); };
const normal = result => ['continue', 'review-ready'].includes(result.outcome);
function keys(value, allowed, at, problems) {
  if (!plain(value)) { problems.push(`${at}: must be a JSON object`); return false; }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${at}.${key}: unknown key`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) problems.push(`${at}.${key}: required`);
  return true;
}
function json(value) {
  // Do not silently discard undefined, nonfinite numbers, class instances or
  // callbacks when measuring/serializing a model result.
  const seen = new Set();
  function visit(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if ((!Array.isArray(item) && !plain(item)) || seen.has(item)) throw new Error('must be finite acyclic JSON');
    seen.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) visit(child);
    seen.delete(item);
  }
  visit(value);
  return JSON.stringify(value);
}
function bounded(value, max, label) {
  const bytes = json(value);
  if (Buffer.byteLength(bytes, 'utf8') > max) throw new Error(`${label}: exceeds ${max} UTF-8 bytes; move detail to references, not requirements`);
  return bytes;
}
function binding({ assignment, programme, runId }) {
  if (!programme) throw new Error('programme context is required');
  requireValid(validateAutonomousProject(assignment, { programme }));
  if (!id(runId)) throw new Error('a stable session run ID is required');
  return { programme_id: programme.id,
    project_id: assignment.project_id, goal_revision: assignment.goal_revision, run_id: runId };
}
function matches(value, expected, at, problems) {
  for (const key of bindingKeys) if (value[key] !== expected[key]) problems.push(`${at}.${key}: mismatched run or assignment revision`);
}
function handoffProblems(value, expected, assignment) {
  const problems = [];
  try { bounded(value, HANDOFF_MAX_BYTES, 'handoff'); } catch (error) { return [error.message]; }
  if (!keys(value, ['schema', 'version', ...bindingKeys, 'published_sha', 'interpretation', 'evidence', 'references'], 'handoff', problems)) return problems;
  if (value.schema !== 'mc-session-handoff' || value.version !== 1) problems.push('handoff: unsupported schema/version');
  matches(value, expected, 'handoff', problems);
  if (value.published_sha !== null && !(typeof value.published_sha === 'string' && SHA.test(value.published_sha))) problems.push('handoff.published_sha: full SHA or null');
  const fields = ['implemented', 'remaining', 'decisions', 'failed_approaches', 'next_focus'];
  if (keys(value.interpretation, fields, 'interpretation', problems)) {
    for (const field of fields.slice(0, -1)) if (!Array.isArray(value.interpretation[field]) || !value.interpretation[field].every(text)) problems.push(`interpretation.${field}: an array of nonempty paragraphs`);
    if (!text(value.interpretation.next_focus)) problems.push('interpretation.next_focus: required');
  }
  const criteria = new Set(assignment.success_criteria.map(item => item.id));
  if (!Array.isArray(value.evidence)) problems.push('handoff.evidence: an array');
  else value.evidence.forEach(item => {
    if (!keys(item, [...bindingKeys, 'criterion_id', 'reference', 'summary'], 'evidence', problems)) return;
    matches(item, expected, 'evidence', problems);
    if (!criteria.has(item.criterion_id)) problems.push('evidence.criterion_id: unknown criterion');
    if (!text(item.reference) || !text(item.summary)) problems.push('evidence: a measured evidence reference and summary are required');
  });
  if (!Array.isArray(value.references)) problems.push('handoff.references: an array');
  else value.references.forEach(item => {
    if (!keys(item, ['kind', 'reference'], 'reference', problems)) return;
    if (!['code', 'log', 'artifact'].includes(item.kind) || !text(item.reference)) problems.push('reference: code, log or artifact and a nonempty reference');
  });
  return problems;
}

/** Shape/binding checks only. A valid model result is NOT a successful exit. */
export function validateSessionResult(value, context) {
  const problems = [];
  try {
    const expected = binding(context);
    bounded(value, SESSION_RESULT_MAX_BYTES, 'session result');
    if (keys(value, ['schema', 'version', ...bindingKeys, 'outcome', 'reason', 'handoff'], 'result', problems)) {
      if (value.schema !== 'mc-session-result' || value.version !== 1) problems.push('result: unsupported schema/version');
      matches(value, expected, 'result', problems);
      if (!SESSION_OUTCOMES.includes(value.outcome)) problems.push('result.outcome: unsupported outcome');
      if (normal(value) ? value.reason !== null : !text(value.reason)) problems.push('result.reason: null for normal results; otherwise a nonempty explanation');
      problems.push(...handoffProblems(value.handoff, expected, context.assignment));
      if (normal(value) && !value.handoff?.published_sha) problems.push('normal handoff requires a published SHA');
      if (value.outcome === 'review-ready') {
        if (!Array.isArray(value.handoff?.interpretation?.remaining) || value.handoff.interpretation.remaining.length) problems.push('review-ready: remaining work must be empty');
        const covered = new Set((Array.isArray(value.handoff?.evidence) ? value.handoff.evidence : []).map(item => item?.criterion_id));
        if (context.assignment.success_criteria.some(item => item.verification === 'premerge' && !covered.has(item.id))) problems.push('review-ready: every premerge criterion needs evidence');
      }
    }
  } catch (error) { problems.push(error.message); }
  return { ok: problems.length === 0, problems };
}

const STANDING = 'Build only the current goal assignment. Only plan revises goals or confirms completion. Independent review reports findings without repairs. Read referenced detail on demand; prior interpretation and evidence are continuation context, not proof for this run. A normal result requires a relevant green gate and matching committed/pushed content on the same branch/PR. An interrupted attempt is incomplete, never green.';

/** One fresh payload, not transcript concatenation. Oversize requirements fail
 * closed: callers must obtain a bounded assignment, never trim its criteria. */
export function buildSessionStart({ previous = null, previousRunId = null, ...context }) {
  const expected = binding(context);
  if (previous !== null) {
    if (!id(previousRunId) || previousRunId === context.runId) throw new Error('an explicit different predecessor run is required');
    validateContinuation(previous, { ...context, runId: previousRunId });
  } else if (previousRunId !== null) throw new Error('predecessor handoff is missing');
  return bounded({ schema: 'mc-session-start', version: 1, ...expected, standing: STANDING,
    programme: context.programme, assignment: context.assignment, previous }, SESSION_START_MAX_BYTES, 'session start');
}

function paths(root, expected) {
  const dir = join(root, 'session-handoffs', expected.programme_id, expected.project_id);
  return { dir, current: join(dir, 'CURRENT.json'), artifact: join(dir, `${expected.run_id}.json`) };
}
function read(file, max) {
  try {
    if (statSync(file).size > max) throw new Error('session artifact exceeds size limit');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return MISSING; throw error; }
}
function pointer(file) {
  const value = read(file, 1024);
  if (value === MISSING) return null;
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'run_id,sha256' || !id(value.run_id) || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error('invalid current handoff pointer');
  return value;
}
function completed(value) {
  return plain(value) && Object.keys(value).sort().join(',') === 'exit_code,interrupted'
    && value.exit_code === 0 && value.interrupted === false;
}
function validateContinuation(value, context) {
  const problems = [];
  if (!keys(value, ['artifact', 'handoff', 'observed', 'outcome'], 'continuation', problems)) throw new Error(problems.join('; '));
  problems.push(...handoffProblems(value.handoff, binding(context), context.assignment));
  if (!text(value.artifact) || !SESSION_OUTCOMES.includes(value.outcome)) problems.push('invalid continuation reference/outcome');
  if (!keys(value.observed, ['branch', 'pr', 'head', 'pushed', 'tree', 'gate', 'completion', 'normal_exit'], 'observed', problems)) throw new Error(problems.join('; '));
  if (!text(value.observed.branch) || !Number.isSafeInteger(value.observed.pr) || value.observed.pr < 1) problems.push('invalid observed branch/PR ownership');
  if (value.observed.normal_exit && !completed(value.observed.completion)) problems.push('normal handoff requires observed successful process completion');
  if (!value.observed.normal_exit && value.observed.completion !== null) problems.push('incomplete handoff has no successful process completion');
  if (typeof value.observed.normal_exit !== 'boolean' || value.observed.normal_exit !== ['continue', 'review-ready'].includes(value.outcome)) problems.push('invalid observed normal exit');
  if (value.observed.normal_exit === false && ['head', 'pushed', 'tree', 'gate'].some(key => value.observed[key] !== null)) problems.push('incomplete attempts cannot claim publication/gate observations');
  if (value.observed.normal_exit && (!SHA.test(value.observed.tree || '') || !SHA.test(value.observed.head || '') || value.observed.head !== value.handoff.published_sha || value.observed.pushed !== value.observed.head || !text(value.observed.gate))) problems.push('invalid observed publication');
  if (problems.length) throw new Error(problems.join('; '));
}

/** Read exactly the declared predecessor. Missing/corrupt/stale data is an
 * explicit error, not a silent return to an empty prompt or a green default. */
export function readCurrentHandoff({ root, ...context }) {
  const expected = binding(context);
  const files = paths(root, expected);
  const current = pointer(files.current);
  if (!current) return null;
  if (current.run_id !== expected.run_id) throw new Error('current handoff belongs to another run');
  const attempt = read(files.artifact, ARTIFACT_MAX_BYTES);
  if (attempt === MISSING || !attempt || hash(json(attempt)) !== current.sha256) throw new Error('missing or corrupt session attempt');
  requireValid(validateSessionResult(attempt.result, context));
  const continuation = { artifact: files.artifact, handoff: attempt.result.handoff, observed: attempt.observed, outcome: attempt.result.outcome };
  validateContinuation(continuation, context);
  return continuation;
}

/** A predecessor is read against the assignment and agreement it was built
 * for: a plan revision between two sessions changes the revisions, never the
 * finished attempt. `history` is `{ assignments, programmes }`, the goal's
 * contracts and the approved agreements; without it, the current ones. */
function predecessorContext(dir, runId, context, history) {
  const attempt = read(join(dir, `${runId}.json`), ARTIFACT_MAX_BYTES);
  const result = plain(attempt) ? attempt.result : null;
  return { ...context,
    assignment: history?.assignments?.find(item => item.goal_revision === result?.goal_revision) || context.assignment,
    programme: context.programme };
}

/** Trusted, inactive runner seam. Publication observations come from Git and the
 * existing receipt reader, never fields supplied by the model. Callers must own
 * the reserved run and supply process completion, independently observed remote
 * HEAD and PR identity.
 * This stores data only: no push, provider call, state transition or launch. */
export function persistSessionResult({ root, result, publication = null, completion = null, ownership, expectedPreviousRun = null, history = null, ...context }, { writeCurrent = writeJsonAtomic } = {}) {
  const expected = binding(context);
  requireValid(validateSessionResult(result, context));
  if (expectedPreviousRun !== null && (!id(expectedPreviousRun) || expectedPreviousRun === expected.run_id)) throw new Error('invalid previous run');
  if (!text(ownership?.branch) || !Number.isSafeInteger(ownership?.pr) || ownership.pr < 1) throw new Error('existing branch/PR ownership required');
  // Snapshot model input before observing the repository or taking the lock.
  result = JSON.parse(json(result));
  // Git observations are local but potentially slow; do not hold the shared
  // register lock across them. The reserved run owns its quiescent checkout.
  let observed = { branch: ownership.branch, pr: ownership.pr, head: null, pushed: null, tree: null, gate: null, completion: null, normal_exit: false };
  if (normal(result)) {
    if (!completed(completion)) throw new Error('normal result requires observed successful process completion, not an interrupted or unknown exit');
    if (!publication || publication.head !== result.handoff.published_sha) throw new Error('published SHA does not match the handoff');
    const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: publication.cwd, encoding: 'utf8', timeout: 60_000 });
    if (branch.error || branch.status !== 0 || branch.stdout.trim() !== ownership.branch) throw new Error('branch ownership mismatch');
    const receipt = findPublicationReceipt({ ...publication, root: publication.evidenceRoot || root, repo: context.assignment.repo,
      sessionRun: expected.run_id, goalRevision: expected.goal_revision });
    if (!receipt) throw new Error('normal result requires matching committed/pushed content and a relevant green receipt for this run/revision');
    // Recheck content after receipt lookup; no inferred remote tracking ref.
    if (!sameContent(captureWorktree(publication.cwd), receipt)) throw new Error('publication content changed');
    observed = { ...observed, head: publication.head, pushed: publication.pushed, tree: receipt.tree,
      gate: join(publication.evidenceRoot || root, 'gate-evidence', `${receipt.run}.json`), completion: { ...completion }, normal_exit: true };
  }
  return realLock(root, () => {
    const files = paths(root, expected);
    const current = pointer(files.current);
    if ((current?.run_id ?? null) !== expectedPreviousRun && current?.run_id !== expected.run_id) throw new Error('stale predecessor; current handoff was replaced');
    if (current && current.run_id !== expected.run_id) {
      const predecessor = readCurrentHandoff({ root, ...predecessorContext(files.dir, current.run_id, context, history), runId: current.run_id });
      if (predecessor.observed.branch !== ownership.branch || predecessor.observed.pr !== ownership.pr) throw new Error('branch/PR ownership cannot change between runs');
    }
    const attempt = { previous_run_id: expectedPreviousRun, result, observed };
    const bytes = bounded(attempt, ARTIFACT_MAX_BYTES, 'session attempt');
    const next = { run_id: expected.run_id, sha256: hash(bytes) };
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    try { writeFileSync(files.artifact, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !isDeepStrictEqual(read(files.artifact, ARTIFACT_MAX_BYTES), attempt)) throw new Error('immutable session attempt already exists or could not be written', { cause: error });
    }
    if (!isDeepStrictEqual(current, next)) writeCurrent(files.current, next);
    return { artifact: files.artifact, handoff: result.handoff, observed, outcome: result.outcome };
  }, { strict: true });
}
