/** Repair's model reads only supplied evidence and bounded, pinned repository reads. */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { requireCapability, resolveLaunch } from '../adapters/index.js';
import { declaredAreaKeys } from './area-proposals.js';
import { AREAS_PATH, checkAreas } from './areas.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { runTool } from './child-async.js';
import { tryGit } from './git.js';
import { profileArgs } from './portrait.js';
import { defaultRepos } from './repos.js';
import { instructionsFor, readCanonRole } from './roles.js';
import { headlessArgs, sessionAnswer, userMessageLine } from './run-plan.js';
import { scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';
import { withoutSessionIdentity } from './session-role.js';

const ROLE = 'repair';
const TIMEOUT_MS = 5 * 60_000;
const MAX_READS = 4;
const MAX_TURNS = 3;
const SAFE_ROOTS = ['docs/technical', 'src', 'tests', 'scripts'];
const SAFE_FILE = /^(?:docs\/technical|src|tests|scripts)\/(?:[\w.-]+\/)*[\w.-]+$/u;

function getEvidence(request, snapshots, git) {
  if (!request || typeof request !== 'object') return null;
  const snapshot = snapshots.get(request.repository);
  if (!snapshot?.head) return null;
  const { head, path } = snapshot;
  if (request.file && typeof request.file === 'string' && SAFE_FILE.test(request.file)
    && !request.file.split('/').some(name => name === '.' || name === '..')) {
    const start = request.line === undefined ? 1 : request.line;
    if (!Number.isSafeInteger(start) || start < 1) return null;
    const content = git(path, ['show', `${head}:${request.file}`], { trim: false });
    return { repository: request.repository, file: request.file, line: start, revision: head, text: content === null ? null
      : content.split('\n').slice(start - 1, start + 119).map((line, i) => `${start + i}: ${line}`).join('\n').slice(0, 12_000) };
  }
  if (typeof request.find === 'string' && request.find.length >= 3 && request.find.length <= 100 && !/[\p{Cc}]/u.test(request.find)) {
    const content = git(path, ['grep', '-n', '-F', '-m', '3', '-e', request.find, head, '--', ...SAFE_ROOTS]);
    return { repository: request.repository, find: request.find, revision: head, text: content?.slice(0, 6_000) ?? null };
  }
  return null;
}

export async function judgeRepair({ source, orders, env }, deps = {}) {
  const role = (deps.role ?? readCanonRole)(ROLE);
  const tool = (deps.launch ?? resolveLaunch)('claude');
  if (!role?.overlay || !tool?.ok) throw new Error('repair session is not available');
  const provider = requireCapability(tool.id, 'BILLING_PROVIDER');
  const billing = (deps.billing ?? billingRouteNow)(provider, { env });
  if (billing.billing === 'unavailable') throw new Error('no billing route is available for the repair session');
  const git = deps.git ?? tryGit;
  const snapshots = new Map((deps.repos ?? defaultRepos(env)).map(repo => [repo.name, {
    path: repo.path, head: git(repo.path, ['rev-parse', '--verify', 'origin/main']),
  }]));
  const revisions = Object.fromEntries([...snapshots].map(([repo, { head }]) => [repo, head]));
  const areas = [...snapshots].flatMap(([name, { path, head }]) => {
    if (!head) return [];
    const result = checkAreas(git(path, ['show', `${head}:${AREAS_PATH}`]), AREAS_PATH);
    return result.ok ? [{ name, areas: result.areas }] : [];
  });
  const areaKeys = declaredAreaKeys(areas);
  const child = scrubRuntimeSecretsFromEnv(withoutSessionIdentity(env));
  for (const name of ['MC_REPO', 'MC_WORKAREA', 'MC_SCRATCH', 'MC_SESSION_STARTED', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR',
    'MC_REVIEW_SEEN', 'MC_REVIEW_WRITE_BACK', 'MC_PROGRAMME_REVIEW_TOKEN', 'MC_LEARNING_RUN']) delete child[name];
  Object.assign(child, { MC_ROLE: ROLE, MC_HEADLESS: '1', MC_TOOL: tool.id, MC_MODEL: role.model, MC_REPAIR_RUN: randomUUID() });

  const args = headlessArgs({
    toolId: tool.id, adapter: tool.adapter, model: role.model, instructions: instructionsFor(tool.id, role.overlay),
    prompt: '', profileArgs, autocompact: null, stream: true, cache: role.cache,
  });
  // The role gets data, not an executor. Even read tools could reach beyond the collected evidence.
  const at = args.indexOf('--tools');
  if (at < 0) throw new Error('repair session cannot disable tools');
  args[at + 1] = '';
  args.push('--no-session-persistence');
  const launch = gatewayLaunch({ provider, model: role.model, bin: tool.spec.bin, args, billing: billing.billing });
  const evidence = [];
  const started = Date.now();
  for (let round = 1; round <= MAX_TURNS; round++) {
    const timeoutMs = TIMEOUT_MS - (Date.now() - started);
    if (timeoutMs <= 0) throw new Error('repair session did not finish within five minutes');
    const prompt = JSON.stringify({ source: { kind: source.ref.kind, repository: source.repo, evidence: source.text },
      openOrders: orders, revisions, areas: areaKeys, evidence, repositoryRead: round < MAX_TURNS ? MAX_READS : 0 });
    const result = await (deps.session ?? runTool)(launch.bin, launch.args, {
      cwd: tmpdir(), env: child, timeoutMs, group: true, input: userMessageLine(prompt),
    });
    if (result.status !== 0) throw new Error('repair session did not finish; nothing was ordered');
    let answer;
    try { answer = JSON.parse(sessionAnswer(tool.id, result.stdout)); }
    catch { throw new Error('repair session returned no readable decision'); }
    if (answer?.status !== 'read') {
      if (['draft', 'resolved'].includes(answer?.status) && !evidence.some(item => item.text)) {
        throw new Error('repair session did not check the current repository');
      }
      if (answer?.area && (!areaKeys.includes(answer.area) || !answer.area.startsWith(`${source.repo ?? answer.repository}/`))) {
        throw new Error('repair session did not name a declared area of the affected repository');
      }
      return answer;
    }
    if (round === MAX_TURNS || !Array.isArray(answer.requests) || !answer.requests.length || answer.requests.length > MAX_READS) {
      throw new Error('repair session exceeded its repository reading allowance');
    }
    for (const request of answer.requests) {
      const item = getEvidence(request, snapshots, git);
      if (!item) throw new Error('repair session asked for a read outside the repository evidence boundary');
      evidence.push(item);
    }
  }
  throw new Error('repair session returned no decision');
}
