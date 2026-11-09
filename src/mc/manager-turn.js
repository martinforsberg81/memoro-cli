/** One explicitly requested Manager task, always in a fresh headless session. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { registerForeground } from './foreground.js';
import { runnerDir } from './paths.js';
import { profileArgs } from './portrait.js';
import { instructionsFor, readCanonRole, roleRecord, roleSourceOf } from './roles.js';
import { headlessArgs, readSessionOutput, sessionResult, TIMEOUT_EXIT } from './run-plan.js';
import { scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { withoutSessionIdentity } from './session-role.js';
import { DEFAULT_CATALOG, readModels } from './model-config.js';
import { readCapacity } from './model-capacity.js';
import { chooseCandidate } from './model-choice.js';

function runSession({ bin, args, cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    execFile(bin, args, { cwd, env, timeout: timeoutMs, killSignal: 'SIGTERM', encoding: 'utf8', maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
      const timedOut = error?.killed === true && error?.signal === 'SIGTERM';
      resolve({ status: timedOut ? TIMEOUT_EXIT : (Number.isInteger(error?.code) ? error.code : error ? 1 : 0), timedOut, stdout: stdout || '', stderr: stderr || error?.message || '' });
    });
  });
}

export async function runManagerTurn({ prompt, tool = null, model = null, minutes = 30, env = process.env, now = new Date(), deps = {} } = {}) {
  if (!prompt?.trim() || !Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) return { ok: false, reason: 'invalid manager task or time limit' };
  const role = (deps.role || readCanonRole)('manager');
  if (!role?.overlay) return { ok: false, reason: 'manager role missing' };
  // The unattended manager runs on the catalog's manager list (`mc model`); an explicit model wins, and an explicit tool takes that tool's first manager candidate.
  const catalog = !model ? (deps.catalog || (() => readModels(env)))() : { providerPriority: 'auto' };
  const priority = catalog.providerPriority ?? 'auto';
  let routeCandidate = null;
  let routeWhy = null;
  let routeBilling = null;
  if (!model) {
    const managerList = catalog.manager || DEFAULT_CATALOG.manager;
    if (tool) routeCandidate = managerList.find((candidate) => candidate.tool === tool) || null;
    else {
      const chosen = chooseCandidate({ cls: 'manager', catalog: { manager: managerList }, capacity: (deps.capacity || (() => readCapacity({ root: runnerDir(env) })))(), now, priority });
      if (!chosen.ok) return { ok: false, reason: chosen.reason, providerPriority: priority };
      routeCandidate = chosen.candidate;
      routeWhy = chosen.why;
      routeBilling = chosen.billing;
    }
  }
  const selectedTool = tool || routeCandidate?.tool || role.tools?.[0] || 'claude';
  const launch = (deps.launch || resolveLaunch)(selectedTool);
  if (!launch?.ok) return { ok: false, reason: launch?.hint || launch?.reason || 'tool unavailable' };
  if (!model && !routeCandidate) return { ok: false, reason: `no ${selectedTool} candidate is on the manager list in mc model` };
  const selectedModel = model || routeCandidate?.model || (launch.shortName === role.tools?.[0] ? role.model : null) || 'opus';
  const instructions = instructionsFor(launch.id, role.overlay);
  const task = `You are running headless with nobody at the terminal. Carry out only the task below, then report what changed, what was checked and what remains. When a decision needs Martin, record the question with the affected goal or proposal and report it; do not guess his answer. Do not start another Manager session.\n\n${prompt}`;
  const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: selectedModel, effort: routeCandidate?.effort, instructions, prompt: task, profileArgs, stream: false, cache: role.cache });
  const provider = launch.id === 'codex' ? 'codex' : 'claude';
  const billing = (deps.billingRoute || billingRouteNow)(provider, { now, env, route: { billing: routeBilling, why: routeWhy } });
  if (billing.billing === 'unavailable') return { ok: false, reason: billing.why, providerPriority: priority, routeWhy };
  const processLaunch = gatewayLaunch({ provider, model: selectedModel, bin: launch.spec.bin, args, billing: billing.billing });
  // Keep unattended conversations outside the interactive desk's history lookup.
  const dir = join(runnerDir(env), 'manager', `${now.toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'result.json');
  const childEnv = withoutSessionIdentity(env);
  for (const key of ['MC_REPO', 'MC_WORKAREA', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR', 'MC_SESSION_STARTED']) delete childEnv[key];
  Object.assign(childEnv, { MC_ROLE: 'manager', MC_HEADLESS: '1', MC_TOOL: launch.shortName || launch.id, MC_MODEL: selectedModel, MC_SCRATCH: dir });
  const release = (deps.register || registerForeground)({ verb: 'manager', tool: launch.shortName || launch.id, model: selectedModel, role: roleRecord({ ...role, source: roleSourceOf(role), instructions }), env });
  try {
    let result;
    try {
      result = await (deps.session || runSession)({ ...processLaunch, cwd: dir, timeoutMs: minutes * 60_000, env: scrubProviderApiKeysFromEnv(childEnv) });
    } catch (error) {
      result = { status: 1, stdout: '', stderr: error.message || String(error) };
    }
    const summary = readSessionOutput({ toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut, now });
    const ok = result.status === 0 && !result.timedOut && !summary.quota && !summary.interrupted && !['failed', 'no-json'].includes(summary.note);
    let answer = launch.id === 'codex' ? '' : sessionResult(result.stdout)?.result || '';
    if (launch.id === 'codex') {
      for (const line of String(result.stdout || '').split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text || answer;
        } catch { /* not a JSON event */ }
      }
    }
    const receipt = { ...summary, answer, ok, status: result.status, tool: launch.shortName || launch.id, model: selectedModel, providerPriority: priority, routeWhy, billing: billing.billing, started: now.toISOString(), finished: new Date().toISOString(), prompt, stdout: result.stdout, stderr: result.stderr };
    writeFileSync(log, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return { ...receipt, log };
  } finally {
    release();
  }
}
