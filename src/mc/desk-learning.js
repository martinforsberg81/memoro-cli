/**
 * The shared terminal and scheduled area-learning session.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireCapability, resolveLaunch } from '../adapters/index.js';
import { writeJsonAtomic } from './atomic-write.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { runTool } from './child-async.js';
import { deskBudget, deskBudgetReason, deskRunsPath } from './desk-budget.js';
import { lessonsDir, listLessons } from './desk-lessons.js';
import { learningEligible, learningLine } from './lesson-learning.js';
import { learningClaimPath } from './learning-publication.js';
import { chooseCandidate } from './model-choice.js';
import { readCapacity } from './model-capacity.js';
import { readModels } from './model-config.js';
import { runnerDir } from './paths.js';
import { profileArgs } from './portrait.js';
import { instructionsFor, readCanonRole } from './roles.js';
import { headlessArgs, readSessionOutput, TIMEOUT_EXIT, tsvHeader, tsvRow } from './run-plan.js';
import { quotaFields, refusePlanOnRead } from './plan-refusal.js';
import { scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { withoutSessionIdentity } from './session-role.js';
import { releaseClaim, takeClaim } from './resource-claim.js';

/** Five open lessons, or one this old, start the pass. */
export const LEARNING_OPEN = 5;
export const LEARNING_AGE_DAYS = 7;
export const LEARNING_TIMEOUT_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const learningMarkerPath = (env = process.env) => join(runnerDir(env), 'learning.json');

/** Why the pass is due now, or null: the two triggers, read from the lessons alone. */
export function learningDue({ env = process.env, now = new Date(), lessons = listLessons({ env }) } = {}) {
  const open = lessons.filter(lesson => learningEligible(lesson));
  if (open.some(x => x.learning?.state === 'publication-failed' && x.learning.evidence === x.evidence)) return 'a failed area correction is ready to retry';
  if (open.length >= LEARNING_OPEN) return `${open.length} open lessons`;
  const old = open.find((lesson) => now.getTime() - Date.parse(lesson.at) >= LEARNING_AGE_DAYS * DAY_MS);
  return old ? `${old.name} has been open ${LEARNING_AGE_DAYS} days` : null;
}

/** At most one a day (UTC): the marker is written when a session starts, so a crashed one counts. */
export function learningRanToday({ env = process.env, now = new Date(), read = (path) => readFileSync(path, 'utf8') } = {}) {
  let marker = null;
  try { marker = JSON.parse(read(learningMarkerPath(env))); } catch { /* none */ }
  return typeof marker?.started_at === 'string' && marker.started_at.slice(0, 10) === now.toISOString().slice(0, 10);
}

function decisionRoute(env, now) {
  const catalog = readModels(env);
  return chooseCandidate({ cls: 'decision', catalog, capacity: readCapacity({ root: runnerDir(env) }), now, priority: catalog.providerPriority ?? 'auto' });
}
function appendRun(row, env) {
  const path = deskRunsPath(env);
  mkdirSync(join(runnerDir(env), 'log'), { recursive: true });
  let exists = true;
  try { readFileSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  appendFileSync(path, `${exists ? '' : `${tsvHeader()}\n`}${tsvRow(row)}\n`);
}
async function realSession({ bin, args, ...options }) {
  const result = await runTool(bin, args, options);
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return { ...result, status: timedOut ? TIMEOUT_EXIT : result.status ?? 1, timedOut, stderr: result.stderr || result.error?.message || '' };
}

export function learningPrompt({ reason, lessons }) {
  return `Evaluate these lesson records for area learning (${reason}): ${lessons.map(x => x.name).join(', ')}. Read their evidence and previous links in mc martin lessons --json. Process only the named lessons, following the learning role.`;
}

/**
 * Start the pass if it is due. Returns `{ started, reason, ... }`; a hold or a missing capacity is a
 * reason and no attempt. Every started session writes a `runs.tsv` row of kind `learning`.
 */
export async function runLearningPass({ env = process.env, now = () => new Date(), manual = false, deps = {} } = {}) {
  const lessons = listLessons({ env });
  const offered = lessons.filter(x => learningEligible(x, { manual }));
  const due = manual ? (offered.length ? 'manual run' : null) : learningDue({ env, now: now(), lessons });
  if (!due) return { started: false, reason: null };
  if (!manual && (deps.ranToday || learningRanToday)({ env, now: now() })) return { started: false, reason: 'the learning pass already ran today' };
  const budget = (deps.budget || deskBudget)({ env, now: now() });
  if (budget.held) return { started: false, held: true, reason: deskBudgetReason(budget) };
  const route = deps.route ? deps.route('decision') : decisionRoute(env, now());
  if (!route?.ok || !route.candidate) return { started: false, reason: route?.reason || 'no usable decision candidate' };
  const candidate = route.candidate;
  const launch = (deps.launch || resolveLaunch)(candidate.tool);
  if (!launch?.ok) return { started: false, reason: launch?.hint || launch?.reason || 'tool unavailable' };
  const role = (deps.role || readCanonRole)('learning');
  if (!role?.overlay) return { started: false, reason: 'learning role missing' };
  const billing = (deps.billingRoute || billingRouteNow)(requireCapability(launch.id, 'BILLING_PROVIDER'), { env, now: now(), route: { billing: route.billing, why: route.why } });
  if (billing.billing === 'unavailable') return { started: false, reason: billing.why };
  const run = randomUUID();
  const claimPath = learningClaimPath(env);
  const claim = takeClaim(claimPath, { pid: process.pid, run, manual, lessons: Object.fromEntries(offered.map(x => [x.name, x.evidence])) });
  if (!claim.ok) return { started: false, reason: claim.error || 'a learning session is already running' };
  try {
    if (!manual && (deps.ranToday || learningRanToday)({ env, now: now() })) return { started: false, reason: 'the learning pass already ran today' };
    return await launchLearning({ env, now, offered, due, manual, run, deps, candidate, launch, role, billing });
  } finally { releaseClaim(claimPath, claim.marker); }
}

async function launchLearning({ env, now, offered, due, manual, run, deps, candidate, launch, role, billing }) {
  const dir = lessonsDir(env);
  mkdirSync(dir, { recursive: true });
  const started = now();
  const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: candidate.model, effort: candidate.effort,
    instructions: instructionsFor(launch.id, role.overlay), prompt: learningPrompt({ reason: due, lessons: offered }), profileArgs, stream: false, cache: role.cache });
  const processLaunch = gatewayLaunch({ provider: requireCapability(launch.id, 'BILLING_PROVIDER'), model: candidate.model, bin: launch.spec.bin, args, billing: billing.billing });
  const childEnv = withoutSessionIdentity(env);
  for (const key of ['MC_GOAL', 'MC_PROGRAMME', 'MC_REPO', 'MC_WORKAREA', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR', 'MC_REVIEW_SEEN', 'MC_REVIEW_WRITE_BACK', 'MC_SCRATCH']) delete childEnv[key];
  delete childEnv.MC_SESSION_STARTED;
  Object.assign(childEnv, { MC_ROLE: 'learning', MC_HEADLESS: '1', MC_TOOL: candidate.tool, MC_MODEL: candidate.model, MC_LEARNING_RUN: run });
  if (!manual) (deps.writeMarker || writeJsonAtomic)(learningMarkerPath(env), { started_at: started.toISOString(), reason: due });
  let result;
  try { result = await (deps.session || realSession)({ ...processLaunch, cwd: dir, env: scrubProviderApiKeysFromEnv(childEnv), timeoutMs: LEARNING_TIMEOUT_MS, group: true }); }
  catch (error) { result = { status: 1, stdout: '', stderr: error.message || String(error) }; }
  const summary = readSessionOutput({ toolId: launch.id, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status, timedOut: result.timedOut, now: now(), model: candidate.model });
  refusePlanOnRead({ read: summary, launch, model: candidate.model, billing: billing.billing, env, now: now(), say: deps.say });
  const row = { ...summary, ts: now().toISOString(), name: 'learning', kind: 'learning', exit: result.status ?? 1,
    seconds: Math.round((now().getTime() - started.getTime()) / 1000), pr: '-', note: `${due}; ${result.timedOut ? 'exceeded the time limit' : `exit ${result.status ?? 1} (${summary.note})`}`,
    model: candidate.model, cls: 'decision', tool: candidate.tool, effort: candidate.effort, billing: billing.billing };
  (deps.logRun || ((entry) => appendRun(entry, env)))(row);
  const byName = new Map(listLessons({ env }).map(x => [x.name, x]));
  const lines = offered.flatMap(before => {
    const after = byName.get(before.name)?.learning;
    const line = after && JSON.stringify(after) !== JSON.stringify(before.learning) ? learningLine(after) : null;
    return line ? [line] : [];
  });
  const account = [...new Set(lines)];
  return { started: true, ok: result.status === 0, ...summary, reason: due, account: account.length ? account : ['mc: no area information to update'],
    quota: summary.quota, quotaReset: summary.quotaReset, ...quotaFields(summary, launch) };
}
