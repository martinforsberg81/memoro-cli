/** One fresh medium-class evidence turn per new desk item; no decisions. */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLaunch } from '../adapters/index.js';
import { writeJsonAtomic } from './atomic-write.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { runTool } from './child-async.js';
import { deskBudget, deskBudgetReason, deskRunsPath } from './desk-budget.js';
import { itemDirectory, listDeskItems, readDeskItem, writeDeskItem } from './desk-items.js';
import { chooseCandidate } from './model-choice.js';
import { readCapacity } from './model-capacity.js';
import { readModels } from './model-config.js';
import { runnerDir, workRoot } from './paths.js';
import { profileArgs } from './portrait.js';
import { instructionsFor, readCanonRole } from './roles.js';
import { realLock } from './runner-lock.js';
import { headlessArgs, readSessionOutput, TIMEOUT_EXIT, tsvHeader, tsvRow } from './run-plan.js';
import { scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { withoutSessionIdentity } from './session-role.js';
import { pidAlive } from './status-collect.js';

export const PREPARE_LIMIT = 3;
export const PREPARE_TIMEOUT_MS = 15 * 60_000;

/** The same catalog policy as routeClass; never borrow another list. */
function mediumRoute(env, now) {
  const catalog = readModels(env);
  return chooseCandidate({ cls: 'medium', catalog, capacity: readCapacity({ root: runnerDir(env) }), now, priority: catalog.providerPriority ?? 'auto' });
}

// The runner lock guards only claim/release, never the asynchronous turn. A
// live claim (even from this process) excludes manual and chore re-entry.
function claimItem(item, env) {
  const path = join(itemDirectory(item, env), '.prepare.json');
  return realLock(workRoot(env), () => {
    let claim;
    try { claim = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (claim && pidAlive(claim.pid)) return null;
    writeJsonAtomic(path, { pid: process.pid });
    return () => realLock(workRoot(env), () => rmSync(path, { force: true }), { strict: true, name: 'desk-prepare-release' });
  }, { strict: true, name: 'desk-prepare-claim' });
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

export async function prepareDeskItem({ id, env = process.env, now = () => new Date(), deps = {} } = {}) {
  const item = readDeskItem(id, { env });
  if (!item || item.state !== 'new') return { started: false, reason: 'item is not new' };
  const release = claimItem(item, env);
  if (!release) return { started: false, reason: 'item preparation already running' };
  try {
    if (readDeskItem(id, { env })?.state !== 'new') return { started: false, reason: 'item is no longer new' };
    const budget = (deps.budget || deskBudget)({ env, now: now() });
    if (budget.held) return { started: false, held: true, reason: deskBudgetReason(budget) };
    const route = deps.route ? deps.route('medium') : mediumRoute(env, now());
    if (!route?.ok || !route.candidate) return { started: false, reason: route?.reason || 'no usable medium candidate' };
    const candidate = route.candidate;
    const launch = (deps.launch || resolveLaunch)(candidate.tool);
    if (!launch?.ok) return { started: false, reason: launch?.hint || launch?.reason || 'tool unavailable' };
    const role = (deps.role || readCanonRole)('desk-prepare');
    if (!role?.overlay) return { started: false, reason: 'desk-prepare role missing' };
    const provider = candidate.tool;
    const billing = (deps.billingRoute || billingRouteNow)(provider, { env, now: now(), route: { billing: route.billing, why: route.why } });
    if (billing.billing === 'unavailable') return { started: false, reason: billing.why };
    const dir = itemDirectory(item, env);
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: candidate.model, effort: candidate.effort,
      instructions: instructionsFor(launch.id, role.overlay), prompt: `Prepare only desk item ${id}. Read it with mc martin item ${id}. Write prepared.md here, then mc martin item ${id} prepared --sort <sort> and stop.`, profileArgs, stream: false, cache: role.cache });
    const processLaunch = gatewayLaunch({ provider, model: candidate.model, bin: launch.spec.bin, args, billing: billing.billing });
    const childEnv = withoutSessionIdentity(env);
    for (const key of ['MC_REPO', 'MC_WORKAREA', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR', 'MC_SESSION_STARTED', 'MC_SCRATCH']) delete childEnv[key];
    Object.assign(childEnv, { MC_ROLE: 'desk-prepare', MC_HEADLESS: '1', MC_TOOL: candidate.tool, MC_MODEL: candidate.model });
    const started = now();
    let result;
    try { result = await (deps.session || realSession)({ ...processLaunch, cwd: dir, env: scrubProviderApiKeysFromEnv(childEnv), timeoutMs: PREPARE_TIMEOUT_MS, group: true }); }
    catch (error) { result = { status: 1, stdout: '', stderr: error.message || String(error) }; }
    const summary = readSessionOutput({ toolId: launch.id, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status, timedOut: result.timedOut, now: now(), model: candidate.model });
    const current = readDeskItem(id, { env });
    const prepared = current?.state === 'prepared';
    const reason = result.timedOut ? 'preparation exceeded fifteen minutes' : `turn exited ${result.status ?? 1} without preparing the item (${summary.note})${result.stderr ? `: ${String(result.stderr).slice(0, 1000)}` : ''}`;
    if (current?.state === 'new') {
      current.prepare_failures = [...(current.prepare_failures || []), { at: now().toISOString(), reason }];
      if (current.prepare_failures.length >= 2) {
        writeFileSync(join(dir, 'prepared.md'), `Preparation failed twice.\n\n${current.prepare_failures.map(attempt => `${attempt.at}: ${attempt.reason}`).join('\n\n')}\n`);
        current.state = 'prepared'; current.sort = 'mechanical';
      }
      writeDeskItem(current, { env });
    }
    const row = { ...summary, ts: now().toISOString(), name: id, kind: 'desk-prepare', exit: result.status ?? 1,
      seconds: Math.round((now().getTime() - started.getTime()) / 1000), pr: '-', note: prepared ? 'prepared' : reason,
      model: candidate.model, cls: 'medium', tool: candidate.tool, effort: candidate.effort, billing: billing.billing };
    (deps.logRun || (row => appendRun(row, env)))(row);
    return { started: true, ok: prepared, ...summary, reason: prepared ? null : reason };
  } finally { release(); }
}

export async function drainDeskPreparation({ env = process.env, now = () => new Date(), limit = PREPARE_LIMIT, deps = {} } = {}) {
  const done = [];
  for (const item of listDeskItems({ env, state: 'new' }).slice(0, limit)) {
    if (deps.stop?.()) break;
    const turn = await prepareDeskItem({ id: item.id, env, now, deps });
    if (turn.started) done.push(item.id);
    if (turn.reason) deps.say?.(`desk-prepare: ${turn.reason}`);
    if (turn.quota) { await deps.quotaPause?.(turn.quotaReset); break; }
    if (turn.held) break;
  }
  return { done };
}
