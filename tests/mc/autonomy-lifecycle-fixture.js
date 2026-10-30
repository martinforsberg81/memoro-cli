/** One real programme for the lifecycle and coexistence proofs: an approved
 * agreement, a bare origin and its primary clone, and the real runner, planner
 * journal, review, merge admission, merger round and archive doors. GitHub,
 * the model sessions and the merge round's gate are deterministic adapters:
 * no model is called, no provider key is read and no real project is touched.
 * The adapter GitHub really squashes the pinned head into the origin's main,
 * so a landing is an observable tree, not a flag. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, realDeps } from '../../src/mc/run.js';
import { readAutonomousState, readProgrammeState, reserveProgrammeRun, releaseProgrammeRun, mutateProgramme,
  mutateAutonomousProject, observeProjectSessionControl, projectSessionCheckpoint, currentAutonomousEvidence } from '../../src/mc/autonomous-state.js';
import { claimProgrammeJob, completeProgrammePlan, finishProgrammeJob, reconcileProgrammeJobs, cancelProgrammeOperation } from '../../src/mc/programme-jobs.js';
import { decideProgrammePlan } from '../../src/mc/programme-plan.js';
import { CONTROL_CAPABILITIES } from '../../src/mc/programme-control.js';
import { run as programmeCommand } from '../../src/mc/commands/programme.js';
import { finishAutonomousPublication } from '../../src/mc/autonomous-publish.js';
import { captureWorktree, gateReceipt, persistGateReceipt } from '../../src/mc/session-gate-evidence.js';
import { publicationGateSelection } from '../../src/mc/commands/gate.js';
import { preserveSession, sessionGitDir } from '../../src/mc/session-recovery.js';
import { controlResponse } from '../../src/mc/session-control.js';
import { SESSION_START_MAX_BYTES } from '../../src/mc/session-handoff.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { readClaim } from '../../src/mc/resource-claim.js';
import { landJob } from '../../src/mc/merger.js';
import { parseQueue, mergesPath } from '../../src/mc/merge-queue.js';
import { reviewCompletion, reviewSpawn } from './autonomous-review-process-fixture.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';
import { archiveProgramme } from '../../src/mc/archive-programme.js';
import { normaliseCapacity } from '../../src/mc/model-capacity.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import * as claudeAdapter from '../../src/adapters/claude-code.js';
import { programmeContract, autonomousProject } from './autonomy-fixtures.js';

export const PROGRAMME = 'test-programme';
export const PROJECT = 'test-project';
export const NOW = Date.parse('2026-10-29T12:00:00Z');
export const PROFILE = { soft_active_ms: 100, upper_active_ms: 200, emergency_active_ms: 300, reserve_active_ms: 100,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 200, tool_wait_ms: 120, lane_wait_ms: 150, total_awake_ms: 1000,
  no_progress_ms: 800, max_stagnant_sessions: 3, max_failures: 3 };
export const CRITERIA = [
  { id: 'first', criterion: 'The first behaviour works.', instruction: ['Build the first behaviour.'], check: 'mc gate base.test.js', verification: 'premerge' },
  { id: 'second', criterion: 'The second behaviour works.', instruction: ['Build the second behaviour.'], check: 'mc gate base.test.js', verification: 'premerge' },
  { id: 'installed', criterion: 'The landed main carries both.', instruction: ['Check main after landing.'], check: 'Read the landed files on main.', verification: 'after-integration' },
];
// Every plan decision cites the agreement's one approved criterion.
const BASIS = { criteria: ['contracts'], reference: 'decisions/approved-scope' };
// A dead process group: never one this test signals or waits on.
const DEAD_PID = 2147483647;
export const COMPLETION = { status: 0, normal_exit: true, recovery_ready: true, control_persisted: true, interrupted: false };
const LEGACY_COMPLETION = { status: 0, stdout: JSON.stringify({ subtype: 'success', num_turns: 1, session_id: 'fixture-session' }), stderr: '',
  normal_exit: true, recovery_ready: true, control_persisted: true };

export const goal = (project = PROJECT, overrides = {}) => autonomousProject({ project_id: project, success_criteria: CRITERIA, ...overrides });
export const cleanReview = (criteria = CRITERIA) => ({ criteria: criteria.map(item => ({ criterion_id: item.id,
  status: item.verification === 'premerge' ? 'verified' : 'deferred',
  evidence: [item.verification === 'premerge' ? `Measured ${item.id} on the published head.` : 'Checked only after integration.'], uncertainty: [] })),
defects: [], uncertainty: [] });
export const findings = (...defects) => ({ ...cleanReview(), defects });

export function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
const never = () => new Promise(() => {});

/** GitHub as the runner, publish, review and merger see it: one PR per head
 * branch, and a squash that writes the merged tree into the origin's main only
 * when the pinned head is still the branch head. `hang(args)` freezes one call
 * the way a dying process would leave it. */
export function github(remote) {
  const prs = []; const calls = []; const merges = []; const hangs = [];
  const head = branch => {
    const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const ok = value => ({ ok: true, status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const view = pr => ({ number: pr.number, url: pr.url, state: pr.state, isDraft: pr.draft, title: pr.title, body: pr.body,
    headRefName: pr.branch, baseRefName: 'main', headRefOid: pr.state === 'MERGED' ? pr.merged.head : head(pr.branch),
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', mergeCommit: pr.state === 'MERGED' ? { oid: pr.merged.commit } : null,
    mergedAt: pr.state === 'MERGED' ? '2026-10-29T12:30:00Z' : null });
  function squash(pr) {
    const main = head('main'); const tip = head(pr.branch);
    const tree = git(remote, 'merge-tree', '--write-tree', main, tip).split('\n')[0];
    const commit = git(remote, 'commit-tree', tree, '-p', main, '-m', `${pr.title} (#${pr.number})`);
    git(remote, 'update-ref', 'refs/heads/main', commit, main);
    pr.state = 'MERGED'; pr.merged = { head: tip, commit };
    merges.push({ pr: pr.number, head: tip, commit });
  }
  function gh(args) {
    calls.push(args);
    const hang = hangs.findIndex(item => item.when(args));
    if (hang >= 0) {
      const [item] = hangs.splice(hang, 1);
      if (item.before) item.before(args);
      return never();
    }
    assert.equal(args[0], 'pr', `unexpected GitHub call ${args.join(' ')}`);
    const pr = prs.find(item => item.number === Number(args[2]));
    if (args[1] === 'list') {
      const branch = flag(args, '--head'); const state = flag(args, '--state');
      return ok(prs.filter(item => (!branch || item.branch === branch) && (state === 'all' || item.state === 'OPEN')).map(view));
    }
    if (args[1] === 'create') {
      const branch = flag(args, '--head');
      assert.equal(prs.some(item => item.branch === branch && item.state === 'OPEN'), false, 'one PR per goal branch');
      const number = prs.length + 1;
      prs.push({ number, url: `https://github.invalid/pull/${number}`, branch, title: flag(args, '--title'), body: flag(args, '--body'),
        state: 'OPEN', draft: args.includes('--draft') });
      return ok(`https://github.invalid/pull/${number}`);
    }
    assert.ok(pr, `unknown PR in ${args.join(' ')}`);
    if (args[1] === 'edit') {
      if (args.includes('--body')) pr.body = flag(args, '--body');
      if (args.includes('--title')) pr.title = flag(args, '--title');
      return ok('');
    }
    if (args[1] === 'ready') { pr.draft = false; return ok(''); }
    if (args[1] === 'view') return ok(view(pr));
    if (args[1] === 'merge') {
      const pin = flag(args, '--match-head-commit');
      if (pr.state !== 'OPEN' || !pin || pin !== head(pr.branch)) return { ok: false, status: 1, stdout: '', stderr: 'head is not the pinned commit' };
      squash(pr);
      return ok('');
    }
    return assert.fail(`unexpected GitHub call ${args.join(' ')}`);
  }
  return { gh, prs, calls, merges, head,
    created: () => calls.filter(args => args[1] === 'create').length,
    hang: (when, before = null) => hangs.push({ when, before }) };
}

/** The agreement, approved by the operator's foreground plan and released. */
function agree(root) {
  const foreground = { run_id: 'foreground-1', role: 'foreground-plan' };
  reserveProgrammeRun(root, PROGRAMME, foreground, 0);
  const draft = programmeContract({ status: 'draft' }); delete draft.approval;
  mutateProgramme(root, PROGRAMME, 'draft', draft, { actor: foreground, revision: 1 });
  mutateProgramme(root, PROGRAMME, 'approve', { by: 'Martin', at: '2026-10-28T12:00:00Z' }, { actor: foreground, revision: 2 });
  releaseProgrammeRun(root, PROGRAMME, foreground, 3);
}

export function programmeWorld(t, { profile = PROFILE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-autonomy-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  agree(root);
  const primaryHome = join(root, 'repos'); const primary = join(primaryHome, 'memoro-cli');
  const remote = join(root, 'origin.git');
  mkdirSync(join(primary, '.mc'), { recursive: true });
  git(primary, 'init', '-q', '-b', 'main');
  git(primary, 'config', 'user.name', 'Test'); git(primary, 'config', 'user.email', 'test@example.invalid');
  git(primary, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(primary, 'base.txt'), 'base\n');
  writeFileSync(join(primary, 'shared.txt'), 'shared\n');
  writeFileSync(join(primary, 'base.test.js'), 'export {};\n');
  writeFileSync(join(primary, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  // A real selector declaration: publication and merge admission both read it.
  writeFileSync(join(primary, '.mc', 'test.json'), JSON.stringify({ select: 'node select.mjs', select_why: 'Isolated fixture selector.',
    pr_tests_flags: [], select_changed_path: true, select_changed_path_why: 'Fixture supports changed paths.' }));
  writeFileSync(join(primary, 'select.mjs'), 'console.log(JSON.stringify({files:["base.test.js"],commands:[]}));\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-qm', 'Initial');
  git(root, 'clone', '-q', '--bare', primary, remote);
  git(primary, 'remote', 'add', 'origin', remote); git(primary, 'fetch', '-q', 'origin');

  const env = { ...process.env, MC_WORK_ROOT: root, MC_REPOS_HOME: primaryHome, MC_HOME: join(root, 'mc-home') };
  for (const name of ['MC_STEP', 'MC_PROJECT', 'MC_AUTONOMOUS_ROLE', 'MC_AUTONOMOUS_RUN', 'MC_PROGRAMME_LEASE']) delete env[name];
  const hub = github(remote);
  const w = { root, env, primary, remote, hub, profile, scripts: { step: [], review: [] }, builds: [], reviews: [], legacy: [], gates: [], log: [] };
  let capacity = normaliseCapacity(null);
  const sleeps = [];
  w.deps = { ...realDeps(env), now: () => new Date(NOW), log: line => w.log.push(line),
    freeBytes: () => 100 * 2 ** 30, freeMemoryPercent: () => 50,
    catalog: () => DEFAULT_CATALOG, capacity: { read: () => capacity, write: next => { capacity = next; } },
    laneCount: () => ({ per_repo: 2, total: 2 }), billing: { readMode: () => 'plan' },
    attachDeps: async () => ({ ok: true }),
    launch: () => ({ ok: true, id: 'claude-code', shortName: 'Claude', spec: { bin: 'fixture' }, adapter: claudeAdapter }),
    addWorktree: ({ name, branch, from }) => {
      const cwd = join(root, name, 'memoro-cli'); mkdirSync(join(root, name), { recursive: true });
      const existing = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: primary }).status === 0;
      git(primary, 'worktree', 'add', '-q', ...(existing ? [cwd, branch] : ['-b', branch, cwd, from]));
      return { ok: true, path: cwd };
    },
    // The runner's own shape, `(cwd, args)`, as realDeps has it.
    gh: (cwd, args) => hub.gh(args), startMerger: () => ({ pid: null, started: false }),
    session: async call => {
      const role = call.env?.MC_AUTONOMOUS_ROLE;
      if (!role) { w.legacy.push(call); return LEGACY_COMPLETION; }
      const script = w.scripts[role].shift();
      assert.ok(script, `no scripted ${role} session`);
      return script(call);
    },
    // Lanes are released by the test, never by a real clock.
    sleep: () => new Promise(resolve => sleeps.push(resolve)),
  };
  w.sleeps = sleeps;
  w.publication = { requirements: (cwd, at) => publicationGateSelection(cwd, at), stdout: { write() {} }, stderr: { write() {} },
    publishDeps: { gh: hub.gh, merge: () => assert.fail('a build session never queues merge') },
    gate: async (args, call) => {
      w.gates.push(call.measurementBinding);
      if (w.gateHook) {
        const code = await w.gateHook(call);
        if (code !== undefined) return code;
      }
      const required = await publicationGateSelection(call.cwd, env); const candidate = captureWorktree(call.cwd);
      const receipt = gateReceipt({ measurement: { repo: 'memoro-cli', run: `gate-${w.gates.length}`, ...call.measurementBinding,
        configuration: required.configuration, candidate, base: required.base }, before: candidate, after: candidate,
        result: { ok: true, code: 0, coverage: required.selection, execution: { tests: { exit: 0, finished: true,
          totals: { tests: 1, pass: 1, fail: 0, cancelled: 0 } }, commands: [] } },
        started: '2026-10-29T12:00:00Z', ended: '2026-10-29T12:01:00Z' });
      call.stdout.write(JSON.stringify({ evidence: { path: persistGateReceipt({ root: env.MC_HOME, receipt }) } }));
      return 0;
    } };
  w.capability = { profile, pollMs: 10, review: true, clock: () => ({ at_ms: 1000, awake_ms: 0 }),
    gate: async () => 0, publication: w.publication };
  w.another = () => createRunner({ deps: w.deps, autonomous: w.capability });
  w.runner = w.another();
  /** The runner process that died is replaced: its reservations are orphaned. */
  w.restart = () => { w.die(); w.runner = w.another(); return w.runner; };

  w.state = (project = PROJECT) => readAutonomousState(root, PROGRAMME, project);
  w.programme = () => readProgrammeState(root, PROGRAMME);
  w.cwd = (project = PROJECT) => join(root, 'step', project, 'memoro-cli');
  w.record = (project = PROJECT) => ({ project, programme: PROGRAMME, repo: 'memoro-cli',
    path: join(root, 'programs', PROGRAMME, project, 'PLAN.json'), plan: w.state(project).contract });
  w.world = (...records) => ({ names: records.map(item => item.project), plans: records, prs: [], prsFailed: [] });
  w.run = (project = PROJECT, extra = []) => w.runner.runStep(project, w.world(w.record(project), ...extra));
  w.next = (...records) => w.runner.nextStep({ world: w.world(...records) });
  w.scan = (extra = {}) => reconcileProgrammeJobs({ root, programme: PROGRAMME, revision: w.programme().revision, ...extra });
  w.show = (ref, file) => git(remote, 'show', `${ref}:${file}`);
  w.tree = ref => git(remote, 'rev-parse', `${ref}^{tree}`);
  w.jobs = () => (existsSync(mergesPath(root)) ? parseQueue(readFileSync(mergesPath(root), 'utf8')) : []);
  w.advanceMain = files => {
    git(primary, 'pull', '-q', '--ff-only', 'origin', 'main');
    for (const [file, text] of Object.entries(files)) writeFileSync(join(primary, file), text);
    git(primary, 'add', '.'); git(primary, 'commit', '--allow-empty', '-qm', 'Move main'); git(primary, 'push', '-q', 'origin', 'main');
    return git(primary, 'rev-parse', 'HEAD');
  };

  /** `mc programme <verb>` as the operator runs it, on an installation that reports every control capability. */
  w.cli = async (argv, extra = {}) => {
    const out = []; const err = [];
    const code = await programmeCommand(argv, { root, env: {}, now: () => NOW, capabilities: { supported: [...CONTROL_CAPABILITIES] },
      stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) }, ...extra });
    return { code, out: out.join(''), err: err.join('') };
  };
  w.start = (extra = {}) => {
    const input = join(root, 'start.json');
    writeFileSync(input, JSON.stringify({ by: 'Martin', build: { class: 'fast', profile }, review: { model: { tool: 'claude', model: 'opus', effort: 'high' } } }));
    return w.cli(['start', PROGRAMME, '--expected-revision', String(w.programme().revision), '--stop', 'design-review', '--input-file', input], extra);
  };

  /** One headless plan delivery: claims the pending job, decides, acknowledges. */
  w.plan = (runId, { now } = {}) => {
    const actor = { run_id: runId, role: 'plan' };
    const lease = claimProgrammeJob({ root, programme: PROGRAMME, revision: w.programme().revision, actor, pid: process.pid, ...(now ? { now } : {}) }).planner_jobs.lease;
    assert.equal(lease?.actor.run_id, runId, 'a pending plan job is claimed');
    const owner = (extra = {}) => ({ root, programme: PROGRAMME, revision: w.programme().revision, actor, token: lease.token, ...extra });
    let count = 0;
    const intent = (kind, project = PROJECT, input = {}) => ({ id: `${runId}-${++count}`, kind, project,
      expected_revision: w.state(project).revision, programme_revision: w.programme().approved.at(-1).revision, basis: BASIS, input });
    return { actor, lease, owner, intent,
      events: () => w.programme().planner_jobs.events.filter(item => lease.event_ids.includes(item.id)).map(item => item.type),
      apply: (value, extra) => decideProgrammePlan(owner(extra), value),
      decide: (kind, project = PROJECT, input = {}) => decideProgrammePlan(owner(), intent(kind, project, input)),
      create: (project = PROJECT, overrides = {}) => decideProgrammePlan(owner(), { id: `${runId}-create`, kind: 'create-project', project,
        expected_revision: 0, programme_revision: 1, input: goal(project, overrides) }),
      cancel: (id, reason) => cancelProgrammeOperation(owner(), { id, reason }),
      stop: () => decideProgrammePlan(owner(), { id: `${runId}-stop`, kind: 'reach-stop', programme_revision: 1, stop: 'design-review', reference: 'decisions/planned-stop' }),
      finish: (reference = `decisions/${runId}`) => { completeProgrammePlan(owner(), { event_ids: lease.event_ids, reference }); finishProgrammeJob(owner()); } };
  };
  /** Plan creates the goal, sends it and makes it ready, in one delivery. */
  w.open = (project = PROJECT, overrides = {}, runId = `plan-open-${project}`) => {
    const plan = w.plan(runId);
    plan.create(project, overrides); plan.decide('send-project', project); plan.decide('resume-project', project); plan.finish();
    return plan;
  };

  w.build = (spec = {}) => { w.scripts.step.push(builder(w, spec)); };
  w.review = (result, { project = PROJECT, after = null } = {}) => { w.scripts.review.push(reviewer(w, result, project, after)); };
  w.die = () => orphanClaims([join(root, 'runner'), ...(existsSync(join(root, 'step')) ? readdirSync(join(root, 'step')) : [])
    .map(project => w.cwd(project)).filter(existsSync).map(cwd => sessionGitDir(cwd))]);

  /** One merger pass over the queued job of a goal, through the leased round;
   * `round` replaces the round's report, as a red main would. */
  w.land = async (project = PROJECT, { round = null } = {}) => {
    const job = w.jobs().find(item => item.branch === w.state(project).ownership.branch);
    assert.ok(job, 'a queued merge job');
    const [outcome] = await landJob(job, { root, say: line => w.log.push(line), sleep: async () => {}, gh: hub.gh,
      readRunningRound: () => null, readRunningDeploy: () => null, readLeaseFn: () => ({ held: false }), recordStart() {}, record() {},
      mergeRound: round ? async () => round : () => runMergeRound({ repoPath: job.repo_path, pr: job.pr, root: env.MC_HOME, env, gh: hub.gh,
        autonomous: job.autonomous, holder: { name: 'fixture-merger' }, installs: () => [], mergeLog: null, sleep: async () => {},
        // The merge gate's own measurement is the merger's; here it reports green for the head it measured.
        gate: async () => ({ ok: true, stopped_at: null, reason: null, base: { commit: hub.head('main') },
          pr: { number: job.pr, base: 'main', head: job.branch, head_sha: hub.head(job.branch) },
          candidate: { red: [], totals: { tests: 1, fail: 0 } }, extra_gates: [] }) }) });
    return outcome;
  };
  /** `mc plan <programme> --archive` with the docs merge and area release as adapters. */
  w.archive = async () => {
    const out = []; const err = [];
    const code = await archiveProgramme(PROGRAMME, { repos: [{ name: 'memoro-cli', path: primary }], env,
      areaName: `programs/${PROGRAMME}`, areaPath: join(root, 'programs', PROGRAMME),
      stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) }, now: () => new Date(NOW),
      deps: { git: (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' }; },
        gh: () => ({ ok: true, stdout: '', stderr: '' }), docsMerge: async () => assert.fail('no programme document on main to remove'),
        release: () => ({ removed: [], kept: [], held_by: [], conversations: [] }) } });
    return { code, out: out.join(''), err: err.join('') };
  };
  return w;
}

/** A dead process's reservations: each claim keeps its marker, its owner gone. */
function orphanClaims(directories) {
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (!entry.name.endsWith('.claim')) { walk(path); continue; }
      const held = readClaim(path);
      if (!held) continue;
      const { marker, ...owner } = held;
      writeFileSync(join(path, marker), JSON.stringify({ ...owner, pid: DEAD_PID }));
    }
  };
  for (const directory of directories) if (existsSync(directory)) walk(directory);
}

/** What the supervisor leaves for a session it saw close normally. */
export function closedSession(w, project, cwd) {
  const state = w.state(project);
  const directory = join(w.root, 'supervisor', state.active_run.run_id); mkdirSync(directory, { recursive: true });
  const result = { ...COMPLETION, signal: null, group_dead: true };
  const snapshot = preserveSession({ cwd, directory, control: state.session_control, telemetry: {}, process: result });
  writeJsonAtomic(join(directory, 'result.json'), { ...result, recovery: { ok: true }, control: controlResponse(state.session_control) });
  writeJsonAtomic(join(sessionGitDir(cwd), 'mc-autonomous-session.json'), {
    run_id: state.active_run.run_id, binding: state.session_control.binding, cwd,
    pid: DEAD_PID, process_closed: true, snapshot, control_persisted: true, unreconciled_tools: false, recovery: { ok: true },
  });
}

/**
 * A builder session as the model would drive it, through mc's own commands:
 * it writes `files`, records each criterion it verifies, the supervisor
 * observes that measured progress, and the builder asks for the durable next
 * action after every criterion and stops starting new ones when told to
 * finish. `pace` is the awake time each criterion takes; `upper` an awake
 * time reached without progress. It then publishes through the finish
 * transaction (gate, commit, push, PR) unless `publish` is false.
 * `crash(error)` sees a failed finish; `exit` replaces the normal result.
 */
function builder(w, spec) {
  return async call => {
    const project = spec.project || PROJECT;
    let state = w.state(project); const actor = state.active_run;
    assert.equal(actor.role, 'step'); assert.equal(call.env.MC_AUTONOMOUS_RUN, actor.run_id);
    assert.equal(call.args.includes('--resume'), false, 'every build session is a fresh conversation');
    assert.ok(Buffer.byteLength(call.prompt) <= SESSION_START_MAX_BYTES, 'bounded start context');
    const session = { run_id: actor.run_id, project, cwd: call.cwd, prompt: JSON.parse(call.prompt), actions: [], measured: [] };
    w.builds.push(session);
    if (spec.during) await spec.during(session);
    for (const [file, text] of Object.entries(spec.files || {})) writeFileSync(join(call.cwd, file), text);
    let awake = 0;
    const observe = extra => {
      state = observeProjectSessionControl(w.root, PROGRAMME, project, { actor, revision: state.revision,
        observation: { sequence: state.session_control.observation.sequence + 1, at_ms: 1000 + awake, awake_ms: awake,
          activity: { kind: 'model', id: null }, context: null, progress: null, failure: null, ...extra } });
    };
    const ask = () => {
      const response = projectSessionCheckpoint(w.root, PROGRAMME, project, 'status', {}, { actor, revision: state.revision });
      session.actions.push(response.next_action);
      return response;
    };
    for (const criterion of spec.criteria || []) {
      awake += spec.pace ?? 150;
      const id = `${actor.run_id}-${criterion}`; const reference = `evidence/${criterion}-${state.goal_revision}.json`;
      state = mutateAutonomousProject(w.root, PROGRAMME, project, 'progress', { id, criterion_id: criterion, status: 'verified', reference },
        { actor, revision: state.revision });
      observe({ progress: { id, reference, criterion_id: criterion } });
      session.measured.push(criterion);
      if (ask().next_action !== 'continue') break;
    }
    if (spec.upper) { awake = Math.max(awake, spec.upper); observe({}); ask(); }
    session.control = state.session_control;
    if (spec.publish === false) return spec.exit || COMPLETION;
    const binding = state.session_control.binding;
    const evidence = [...new Map(currentAutonomousEvidence(state).builder.filter(item => item.status === 'verified')
      .map(item => [item.criterion_id, item])).values()].map(item => ({ ...binding, criterion_id: item.criterion_id, reference: item.reference, summary: 'Measured.' }));
    const outcome = spec.outcome || 'continue';
    const input = { goal_revision: state.goal_revision, message: spec.message || `Build ${session.measured.join(', ') || 'closing'}`,
      title: 'Deliver the test goal', body: 'Measured by the session gate.',
      result: { schema: 'mc-session-result', version: 1, ...binding, reason: null, outcome,
        handoff: { schema: 'mc-session-handoff', version: 1, ...binding, published_sha: null,
          interpretation: { implemented: session.measured.map(id => `Criterion ${id}.`), remaining: outcome === 'continue' ? ['The remaining criteria.'] : [],
            decisions: [], failed_approaches: [], next_focus: 'Follow the current criteria.' },
          evidence, references: [] } } };
    try {
      session.publication = await finishAutonomousPublication({ root: w.root, programme: PROGRAMME, project, actor, cwd: call.cwd,
        env: w.env, revision: state.revision }, input, { ...w.publication, ...spec.publicationDeps });
    } catch (error) {
      session.error = error.message; session.stack = error.stack;
      if (!spec.crash) throw error;
      return spec.crash(error, session);
    }
    closedSession(w, project, call.cwd);
    return spec.exit || COMPLETION;
  };
}

/** An independent review session: it reports and does nothing else. `after`
 * is what the world does once the report is in, before the runner routes it. */
function reviewer(w, result, project, after) {
  return async call => {
    const state = w.state(project); const actor = state.active_run;
    assert.equal(actor.role, 'review'); assert.equal(call.env.MC_AUTONOMOUS_ROLE, 'review');
    assert.notEqual(call.cwd, w.cwd(project), 'review never works in the builder checkout');
    reviewSpawn(call.reviewProcess.options);
    w.reviews.push({ run_id: actor.run_id, model: state.review_session.model, checkout: call.cwd, head: state.review_session.head });
    mutateAutonomousProject(w.root, PROGRAMME, project, 'report', result, { actor, revision: state.revision });
    if (after) await after(call);
    return { ...reviewCompletion, stdout: '', stderr: '' };
  };
}

export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export { never };
