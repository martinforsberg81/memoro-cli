/** Runner-owned plan workspace and the headless queue consumer. Capability
 * injection only: the installed runner passes none, so nothing launches here. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { STABLE_ID_RE } from './goal-contract.js';
import { readProgrammeState } from './autonomous-state.js';
import { claimProgrammeJob, renewProgrammeJob, finishProgrammeJob, yieldProgrammeJob } from './programme-jobs.js';
import { programmePlanContext } from './programme-plan.js';
import { takeClaim, releaseClaim } from './resource-claim.js';
import { autonomousPlanRole, instructionsFor, roleRecord } from './roles.js';
import { headlessArgs, routedSettings } from './run-plan.js';
import { profileArgs } from './portrait.js';
import { writeJsonAtomic } from './atomic-write.js';

export const PLAN_SESSION_MAX_MS = 30 * 60 * 1000;
const LEASE_RENEW_MS = 30_000;

/** Never adopt, reset or merge a builder/foreground tree. Detached, clean,
 * runner-owned checkouts are refreshed from each repository's current main. */
export function ensureProgrammePlanWorkspace({ root, programme, repos, git }) {
  if (!STABLE_ID_RE.test(programme) || !repos.length) throw new Error('planner workspace needs a programme and repositories');
  const path = join(root, 'runner', 'plans', programme);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const marker = join(path, 'WORKSPACE.json');
  const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : { version: 1, heads: {} };
  if (previous.version !== 1 || !previous.heads || typeof previous.heads !== 'object' || Array.isArray(previous.heads)
    || Object.entries(previous.heads).some(([name, head]) => !STABLE_ID_RE.test(name) || !/^[a-f0-9]{40}$/u.test(head))) throw new Error('planner workspace ownership is unreadable; preserve it for recovery');
  const checked = [];
  for (const repo of repos) {
    if (!STABLE_ID_RE.test(repo.name)) throw new Error('invalid planner repository name');
    const run = (cwd, args) => {
      const result = git(cwd, args);
      if (!result.ok) throw new Error(`planner checkout ${repo.name}: git ${args[0]} failed`);
      return result.stdout.trim();
    };
    run(repo.path, ['fetch', '-q', 'origin']);
    const cwd = join(path, repo.name);
    if (!existsSync(cwd)) run(repo.path, ['worktree', 'add', '--detach', cwd, 'origin/main']);
    const common = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    if (run(cwd, common) !== run(repo.path, common) || realpathSync(run(cwd, ['rev-parse', '--show-toplevel'])) !== realpathSync(cwd)
      || run(cwd, ['branch', '--show-current']) || run(cwd, ['status', '--porcelain'])) throw new Error('planner checkout is not its clean detached worktree; preserve it for recovery');
    if (run(cwd, ['rev-parse', 'HEAD']) !== (previous.heads[repo.name] || run(repo.path, ['rev-parse', 'origin/main']))) throw new Error('planner inspection head changed; preserve it for recovery');
    run(cwd, ['checkout', '--detach', 'origin/main']);
    const head = run(cwd, ['rev-parse', 'HEAD']);
    previous.heads[repo.name] = head; writeJsonAtomic(marker, previous);
    checked.push({ name: repo.name, path: cwd, head });
  }
  return { path, repos: checked };
}

/** A normal exit is exact: each claimed event was acknowledged by ID, or a
 * recorded completion covers the snapshot. */
function unacknowledged({ planner_jobs: { lease, pending } }) {
  if (lease?.completion) return [];
  return (lease?.event_ids || []).filter(id => pending?.event_ids.includes(id));
}

export async function runProgrammePlan({ root, programme, repos, repo, lane, pid, paths, deps, capability,
  waitForSlot, dropSlot, routeClass, writeJson, remove, stamp, say }) {
  if (!capability?.programmePlan) return 'skipped:autonomous-disabled';
  const role = autonomousPlanRole(deps.role('plan'));
  if (!role) return 'skipped:role-missing';
  const route = routeClass('large');
  if (!route.ok || route.basis === 'credits') return 'skipped:no-capacity';
  const settings = routedSettings(null, null, { kind: 'step', candidate: route.candidate });
  const launch = deps.launch(settings.tool);
  if (!launch?.ok) return 'skipped:tool-missing';
  const slot = await waitForSlot(`programme:${programme}`);
  if (slot !== 'ok') return slot === 'stop' ? 'stop' : 'skipped';
  const claimPath = join(root, 'runner', 'plans', `${programme}.claim`);
  const held = takeClaim(claimPath, { pid });
  if (!held.ok) { dropSlot(); return 'skipped:planner-owned'; }
  const actor = { run_id: `plan-${randomUUID()}`, role: 'plan' };
  let token = null; let timer = null; let leaseFailure = null; let currentWritten = false;
  const now = () => deps.now().getTime();
  const options = () => ({ root, programme, actor, token, revision: readProgrammeState(root, programme).revision, now: now() });
  const currentPath = paths.currentFor(repo?.name || repos[0].name, lane);
  try {
    const previous = readProgrammeState(root, programme);
    const claimed = claimProgrammeJob({ root, programme, revision: previous.revision, actor, pid, now: now() });
    // Autonomy off, a reached stop or another planner: this is where each refuses.
    if (claimed.active_run?.run_id !== actor.run_id) return 'skipped:planner-owned';
    token = claimed.planner_jobs.lease.token;
    const prompt = programmePlanContext(options());
    const required = new Set(JSON.parse(prompt).goals.map(goal => goal.repo));
    for (const name of required) if (!repos.some(repo => repo.name === name && existsSync(repo.path))) throw new Error(`programme needs unavailable repository ${name}`);
    const workspace = ensureProgrammePlanWorkspace({ root, programme, repos: repos.filter(repo => existsSync(repo.path)), git: deps.git });
    const instructions = instructionsFor(launch.id, role.overlay);
    const directory = join(paths.scratch, actor.run_id); mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeJson(currentPath, { name: `programme:${programme}`, programme, kind: 'plan', flavor: 'autonomous', run_id: actor.run_id,
      repo: repo?.name || repos[0].name, lane, pid, started: stamp(), worktree: workspace.path, ...settings,
      role: roleRecord({ name: 'plan', source: 'canon', overlay: role.overlay, instructions }) });
    currentWritten = true;
    timer = setInterval(() => {
      try { renewProgrammeJob(options()); } catch (error) { leaseFailure = error; }
    }, deps.leaseRenewMs ?? LEASE_RENEW_MS);
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, ...settings, instructions, prompt, profileArgs, cache: role.cache });
    const result = await deps.session({ bin: launch.spec.bin, args, cwd: workspace.path,
      prompt: launch.id === 'codex' ? null : prompt, maxRunMs: PLAN_SESSION_MAX_MS, logPath: join(directory, 'session.jsonl'),
      env: { MC_AUTONOMOUS_RUN: actor.run_id, MC_AUTONOMOUS_ROLE: 'plan', MC_PROGRAMME: programme,
        MC_PROGRAMME_LEASE: token, MC_WORK_ROOT: root, MC_WORKAREA: workspace.path, MC_SCRATCH: directory },
      unsetEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MC_STEP', 'MC_PROJECT', 'MC_REPO'] });
    if (leaseFailure) throw leaseFailure;
    if (result.status !== 0 || result.signal || result.timedOut) throw new Error('planner process did not complete normally');
    const open = unacknowledged(readProgrammeState(root, programme));
    if (open.length) throw new Error(`planner exit left claimed events unacknowledged: ${open.join(', ')}`);
    // Mutated inspection checkouts are not silently cleaned or called success.
    for (const checkout of workspace.repos) {
      const status = deps.git(checkout.path, ['status', '--porcelain']);
      const head = deps.git(checkout.path, ['rev-parse', 'HEAD']);
      const branch = deps.git(checkout.path, ['branch', '--show-current']);
      if (!status.ok || status.stdout.trim() || !head.ok || head.stdout.trim() !== checkout.head || !branch.ok || branch.stdout.trim()) throw new Error('planner changed an inspection checkout');
    }
    finishProgrammeJob(options()); token = null;
    say(`${programme}: planner completed its claimed event snapshot`);
    return 'ran';
  } catch (error) {
    say(`${programme}: planner continuation retained — ${error.message}`);
    if (token) {
      try { yieldProgrammeJob(options(), error.message, { retry: true }); } catch { /* lease expiry/restart reconciliation retains the job */ }
    }
    return token ? 'ran' : 'skipped:planner-wait';
  } finally {
    clearInterval(timer);
    if (currentWritten) remove(currentPath);
    releaseClaim(claimPath, held.marker); dropSlot();
  }
}
