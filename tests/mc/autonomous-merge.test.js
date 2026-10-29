import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, completion } from './autonomous-publication-fixture.js';
import { reviewer } from './autonomous-state-fixture.js';
import { settlePublishedBuild } from '../../src/mc/autonomous-recovery.js';
import { prepareAutonomousReview, completeAutonomousReview } from '../../src/mc/autonomous-review.js';
import { mutateAutonomousProject } from '../../src/mc/autonomous-state.js';
import { autonomousMergeDoor, autonomousPrOwner } from '../../src/mc/autonomous-pr.js';
import { autonomousProof, reviewRelevance } from '../../src/mc/autonomous-merge.js';
import { criteriaDoor } from '../../src/mc/merge-boundary.js';
import { queueMerge, landJob } from '../../src/mc/merger.js';
import { parseQueue, mergesPath, markLanding } from '../../src/mc/merge-queue.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';
import { runDocsMerge } from '../../src/mc/docs-merge.js';
import { run as mergeCommand } from '../../src/mc/commands/merge.js';
import { publicationGateSelection } from '../../src/mc/commands/gate.js';
import { captureWorktree, gateReceipt, persistGateReceipt } from '../../src/mc/session-gate-evidence.js';

const clean = () => ({ criteria: [
  { criterion_id: 'schema', status: 'verified', evidence: ['Measured schema.'], uncertainty: [] },
  { criterion_id: 'integration', status: 'deferred', evidence: ['Requires integration.'], uncertainty: [] },
], defects: [], uncertainty: [] });

async function ready(t, { result = clean(), beforeReview = null } = {}) {
  const f = fixture(t);
  // A real selector/declaration, used by publication AND merge admission. It
  // only lists checks; no test process or gate is started inside this fixture.
  mkdirSync(join(f.cwd, '.mc'));
  writeFileSync(join(f.cwd, '.mc/test.json'), JSON.stringify({ select: 'node select.mjs', select_why: 'Isolated fixture selector.',
    pr_tests_flags: [], select_changed_path: true, select_changed_path_why: 'Fixture supports changed paths.' }));
  writeFileSync(join(f.cwd, 'select.mjs'), 'console.log(JSON.stringify({files:["schema.test.js"],commands:[]}));\n');
  f.deps.requirements = () => publicationGateSelection(f.cwd, f.env);
  f.deps.gate = async (args, call) => {
    const required = await f.deps.requirements(); const content = captureWorktree(f.cwd);
    const receipt = gateReceipt({ measurement: { repo: 'memoro-cli', run: 'admission-gate', ...call.measurementBinding,
      configuration: required.configuration, candidate: content, base: required.base }, before: content, after: content,
      result: { ok: true, code: 0, coverage: required.selection, execution: { tests: { exit: 0, finished: true,
        totals: { tests: 1, pass: 1, fail: 0, cancelled: 0 } }, commands: [] } },
      started: '2026-10-28T12:00:00Z', ended: '2026-10-28T12:01:00Z' });
    const path = persistGateReceipt({ root: f.env.MC_HOME, receipt });
    call.stdout.write(JSON.stringify({ evidence: { path } })); return 0;
  };
  f.edit(); await f.finish(); await settlePublishedBuild(f.options(), completion, f.deps);
  if (beforeReview) beforeReview(f);
  const options = { root: f.root, programme: f.programme, project: f.project, actor: reviewer, cwd: f.cwd,
    model: f.stateNow().reviewer_model };
  prepareAutonomousReview(options);
  mutateAutonomousProject(f.root, f.programme, f.project, 'report', result, { actor: reviewer, revision: f.stateNow().revision });
  completeAutonomousReview(options, { status: 0 });
  const door = extra => autonomousMergeDoor({ root: f.root, repoPath: f.cwd, pr: 42, env: f.env, gh: f.gh, ...extra });
  const patch = change => { const state = f.stateNow(); change(state); writeFileSync(f.paths.project, JSON.stringify(state)); };
  return { ...f, door, patch, options };
}
const queue = (f, autonomous) => queueMerge({ root: f.root, repo: 'memoro-cli', repoPath: f.cwd, pr: 42,
  branch: f.project, env: f.env, autonomous, start: () => ({ pid: null, started: false }) });
const receiptPath = f => join(f.env.MC_HOME, 'gate-evidence', 'admission-gate.json');
function moveMain(f, path) {
  const branch = git(f.cwd, 'branch', '--show-current'); git(f.cwd, 'switch', '-q', 'main');
  if (path !== 'empty') {
    const file = join(f.cwd, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'Main movement.\n');
    git(f.cwd, 'add', path);
  }
  git(f.cwd, 'commit', '--allow-empty', '-qm', 'Move main'); git(f.cwd, 'push', '-q', 'origin', 'main');
  const head = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', branch); return head;
}

// Real leased merge round; adapters stand in for GitHub and gate execution,
// not for git ancestry, content, ownership, reports or gate receipt validation.
function round(f, { duringGate = () => {}, ticket = undefined } = {}) {
  let merged = false; const calls = []; const head = f.stateNow().publication.head;
  const gh = (args, options) => {
    calls.push(args);
    if (args[1] === 'merge') { assert.equal(args.at(-1), head); merged = true; return { status: 0, stdout: '' }; }
    if (args.at(-1) === 'headRefOid') return { status: 0, stdout: JSON.stringify({ headRefOid: head }) };
    if (args.at(-1) === 'mergeCommit') return { status: 0, stdout: JSON.stringify({ mergeCommit: { oid: head } }) };
    return f.gh(args, options);
  };
  const run = async () => {
    const base = git(f.cwd, 'rev-parse', 'origin/main');
    const report = await runMergeRound({ repoPath: f.cwd, pr: 42, root: f.env.MC_HOME, env: f.env, gh,
      autonomous: ticket, holder: { name: 'fixture-merger' }, installs: () => [], mergeLog: null,
      gate: async call => {
        assert.equal(call.evidence.run, 'admission-gate'); assert.equal(call.evidence.sessionRun, f.stateNow().publication.run_id);
        await duringGate(call);
        return { ok: true, stopped_at: null, reason: null, pr: { number: 42, base: 'main', head: f.project, head_sha: head },
          base: { commit: base }, candidate: { red: [], totals: { tests: 1, fail: 0 } }, extra_gates: [] };
      }, sleep: async () => {} });
    return { report, merged, calls };
  };
  return run();
}

test('current clean review, premerge evidence and full gate enter the existing queue and pin the leased landing', async t => {
  const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true, admitted.problems.join('; '));
  assert.equal(admitted.checked, true); assert.deepEqual(admitted.autonomous.builder_evidence, ['schema-proof']);
  assert.equal(admitted.autonomous.review_id, reviewer.run_id); assert.equal(admitted.autonomous.gate_run, 'admission-gate');
  assert.equal((await criteriaDoor({ repoPath: f.cwd, pr: 42, root: f.root, env: f.env, gh: f.gh })).ok, true);
  assert.throws(() => queue(f), /admission/u, 'even the low-level queue requires freshly checked evidence');
  const owner = autonomousPrOwner({ root: f.root, repoPath: f.cwd, pr: 42 }).owner;
  assert.throws(() => queue(f, autonomousProof({ root: f.root, owner, pr: 42 }).ticket), /fresh complete/u, 'constructing IDs is not a gate check');
  queue(f, admitted.autonomous);
  assert.throws(() => queue(f, admitted.autonomous), /fresh complete/u, 'queue admission is single-use');
  assert.equal(await mergeCommand(['memoro-cli', '42'], { root: f.root, env: f.env, cwd: f.cwd, gh: f.gh,
    resolveRepoPath: () => f.cwd, prFiles: () => ['implementation.js'], stdout: f.deps.stdout, stderr: f.deps.stderr,
    startMerger: () => ({ pid: null, started: false }) }), 0, f.output.join(''));
  const jobs = parseQueue(readFileSync(mergesPath(f.root), 'utf8'));
  assert.deepEqual(jobs[0].autonomous, admitted.autonomous);
  const restarted = parseQueue(JSON.stringify(markLanding(jobs, jobs[0], { pid: 123, now: 'now' })))[0];
  assert.deepEqual(restarted.autonomous, admitted.autonomous);
  const outcome = await round(f, { ticket: restarted.autonomous });
  assert.equal(outcome.report.ok, true, outcome.report.reason); assert.equal(outcome.merged, true);
  assert.equal(f.stateNow().confirmed, false, 'admission never confirms a goal');
});

for (const mutation of ['plan-missing', 'plan-corrupt', 'state-missing', 'state-corrupt', 'report-missing', 'report-corrupt',
  'criterion-missing', 'criterion-unknown', 'revision', 'criteria-change', 'evidence-change', 'publication-incomplete', 'handoff-missing', 'model-reuse']) {
  test(`${mutation} refuses queue and resumed/direct landing instead of the legacy notChecked path`, async t => {
    const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true, admitted.problems.join('; '));
    if (mutation === 'plan-missing') rmSync(join(f.paths.projectDir, 'PLAN.json'));
    else if (mutation === 'plan-corrupt') writeFileSync(join(f.paths.projectDir, 'PLAN.json'), '{');
    else if (mutation === 'state-missing') rmSync(f.paths.project);
    else if (mutation === 'state-corrupt') writeFileSync(f.paths.project, '{');
    else if (mutation === 'handoff-missing') rmSync(f.stateNow().current_handoff);
    else f.patch(s => {
      if (mutation === 'report-missing') delete s.review_reports;
      if (mutation === 'report-corrupt') s.review_reports[0].session_digest = 'broken';
      if (mutation === 'criterion-missing') s.evidence.builder = [];
      if (mutation === 'criterion-unknown') s.evidence.builder[0].status = 'unknown';
      if (mutation === 'revision') { s.goal_revision++; s.contract.goal_revision++; }
      if (mutation === 'criteria-change') s.contract.success_criteria[0].instruction += ' Changed.';
      if (mutation === 'evidence-change') s.evidence.builder[0].id = 'replacement-proof';
      if (mutation === 'publication-incomplete') s.publication.phase = 'pushed';
      if (mutation === 'model-reuse') s.model_history.push({ run_id: 'reused-model', model: s.reviewer_model, goal_revision: 1 });
    });
    const door = await f.door(); assert.equal(door.checked, true); assert.equal(door.ok, false);
    assert.equal(door.stop, 'autonomous-review-required');
    assert.throws(() => queue(f, admitted.autonomous));
    const report = await runMergeRound({ repoPath: f.cwd, pr: 42, root: f.env.MC_HOME, env: f.env, gh: f.gh,
      autonomous: admitted.autonomous, gate: () => assert.fail('invalid evidence must not reach gate') });
    assert.equal(report.stopped_at, 'autonomous-review-required');
    const legacyDoor = await criteriaDoor({ repoPath: f.cwd, pr: 42, root: f.root, env: f.env, gh: () => ({ status: 1 }) });
    assert.equal(legacyDoor.ok, false, 'durable PR identity survives GitHub/plan failure');
  });
}

test('a clean reviewer cannot replace missing or unknown builder criterion verification', async t => {
  for (const status of ['missing', 'unknown']) {
    const f = await ready(t, { beforeReview: f => {
      const state = f.stateNow();
      if (status === 'missing') state.evidence.builder = [];
      else state.evidence.builder[0].status = 'unknown';
      writeFileSync(f.paths.project, JSON.stringify(state));
    } });
    const door = await f.door(); assert.equal(door.ok, false);
    assert.match(door.problems.join('; '), /premerge criterion/u);
  }
});

for (const finding of ['defect', 'unknown', 'uncertainty']) test(`${finding} review findings do not admit merge`, async t => {
  const result = clean();
  if (finding === 'defect') result.defects.push('Broken behavior.');
  if (finding === 'unknown') result.criteria[0].status = 'unknown';
  if (finding === 'uncertainty') result.uncertainty.push('Cannot establish correctness.');
  const f = await ready(t, { result }); assert.equal((await f.door()).ok, false);
});

for (const kind of ['missing', 'corrupt', 'focused', 'incomplete', 'wrong-tree', 'wrong-revision', 'limited-coverage', 'configuration']) {
  test(`${kind} gate evidence refuses autonomous admission`, async t => {
    const f = await ready(t); const path = receiptPath(f);
    if (kind === 'missing') rmSync(path);
    else if (kind === 'corrupt') writeFileSync(path, '{');
    else {
      const receipt = JSON.parse(readFileSync(path));
      if (kind === 'focused') receipt.coverage.kind = 'named';
      if (kind === 'incomplete') receipt.execution.tests.finished = false;
      if (kind === 'wrong-tree') receipt.tree = 'a'.repeat(40);
      if (kind === 'wrong-revision') receipt.goal_revision++;
      if (kind === 'limited-coverage') receipt.coverage.files = ['other.test.js'];
      if (kind === 'configuration') receipt.configuration = 'stale';
      writeFileSync(path, JSON.stringify(receipt));
    }
    const door = await f.door(); assert.equal(door.ok, false, kind);
  });
}

test('new commits, even equal-tree commits, invalidate the published head', async t => {
  const f = await ready(t); const admitted = await f.door();
  git(f.cwd, 'commit', '--allow-empty', '-qm', 'New head'); git(f.cwd, 'push', '-q', 'origin', f.project);
  assert.equal((await f.door({ expected: admitted.autonomous })).ok, false);
});

test('related/unknown main movement needs new review; proven identical integration content reuses it independently of gate delta', async t => {
  for (const path of ['implementation.js', 'shared.js', 'docs/technical/shared.md', 'docs/project/another-goal/note.md', 'empty']) {
    const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true, admitted.problems.join('; '));
    moveMain(f, path); const door = await f.door({ expected: admitted.autonomous });
    assert.equal(door.ok, path === 'empty', door.problems.join('; '));
    if (door.ok) assert.deepEqual(door.autonomous, admitted.autonomous);
  }
  const f = await ready(t); const assignment = f.stateNow().contract;
  assert.equal(reviewRelevance({ paths: ['docs/project/other/note.md'], assignment, reviewedFiles: ['implementation.js'] }), 'unknown', 'namespace separation is not proof of semantic independence');
  assert.equal(reviewRelevance({ paths: ['docs/project/other/note.md'], assignment: { ...assignment, documents: [{ path: 'docs/project/other/note.md' }] }, reviewedFiles: ['implementation.js'] }), 'review-required');
  assert.equal(reviewRelevance({ paths: [], assignment, reviewedFiles: [] }), 'unknown');
  assert.equal(reviewRelevance({ fromTree: 'a'.repeat(40), toTree: 'a'.repeat(40) }), 'unrelated');
});

for (const change of ['head', 'criteria', 'report', 'receipt', 'related-main', 'unrelated-main']) test(`${change} during a green gate is checked again before the pinned squash`, async t => {
  const f = await ready(t); const admitted = await f.door();
  const outcome = await round(f, { ticket: admitted.autonomous, duringGate: () => {
    if (change === 'head') { git(f.cwd, 'commit', '--allow-empty', '-qm', 'Another head'); git(f.cwd, 'push', '-q', 'origin', f.project); }
    if (change === 'criteria') f.patch(s => { s.contract.success_criteria[0].instruction += ' Changed.'; });
    if (change === 'report') f.patch(s => { s.review_reports[0].clean = false; });
    if (change === 'receipt') rmSync(receiptPath(f));
    if (change.endsWith('-main')) moveMain(f, change === 'unrelated-main' ? 'empty' : 'shared.js');
  } });
  assert.equal(outcome.merged, change === 'unrelated-main', outcome.report.reason || change);
  if (change !== 'unrelated-main') assert.equal(outcome.report.ok, false);
});

test('docs, admin and imported docs doors cannot bypass even a clean autonomous review', async t => {
  const f = await ready(t); const gh = args => { assert.notEqual(args[1], 'merge'); return f.gh(args); };
  for (const flag of ['--docs', '--admin']) {
    const code = await mergeCommand(['memoro-cli', '42', flag], { root: f.root, env: f.env, gh,
      resolveRepoPath: () => f.cwd, stdout: f.deps.stdout, stderr: f.deps.stderr, measure: () => assert.fail('no docs shortcut') });
    assert.equal(code, 1);
  }
  assert.equal((await runDocsMerge({ repoPath: f.cwd, pr: 42, root: f.root, env: f.env, gh,
    measure: () => assert.fail('no direct docs shortcut') })).stopped_at, 'autonomous-review-required');
  let queued = false;
  assert.equal(await mergeCommand(['memoro-cli', '42'], { root: f.root, env: f.env, gh,
    resolveRepoPath: () => f.cwd, prFiles: () => ['docs/note.md'], stdout: f.deps.stdout, stderr: f.deps.stderr,
    gate: () => { queued = true; return 0; }, runDocsMerge: () => assert.fail('automatic docs route must use leased merger') }), 0);
  assert.equal(queued, true);
});

test('missing or damaged restarted queue IDs refuse while legacy PRs retain notChecked behavior', async t => {
  const f = await ready(t); const admitted = await f.door();
  for (const ticket of [null, {}, { ...admitted.autonomous, gate_run: 'old-gate' }]) {
    const outcome = await round(f, { ticket }); assert.equal(outcome.merged, false); assert.equal(outcome.report.stopped_at, 'autonomous-review-required');
  }
  const door = await autonomousMergeDoor({ root: f.root, repoPath: f.cwd, pr: 99,
    gh: () => ({ status: 0, stdout: JSON.stringify({ headRefName: 'legacy', body: '' }) }) });
  assert.deepEqual(door, { checked: false, ok: true, problems: [] });
  const markerRoot = join(f.root, 'runner', 'autonomous-prs');
  const directory = join(markerRoot, readdirSync(markerRoot)[0]);
  writeFileSync(join(directory, readdirSync(directory)[0]), '{');
  assert.equal((await f.door()).ok, false, 'corrupt registry is not a legacy escape');
});

test('merger passes persisted IDs into restarted rounds rather than silently rebuilding admission', async t => {
  const f = await ready(t); const admitted = await f.door(); queue(f, admitted.autonomous);
  const job = parseQueue(readFileSync(mergesPath(f.root), 'utf8'))[0]; let seen;
  await landJob(job, { root: f.root, say() {}, sleep: async () => {}, gh: f.gh,
    readRunningRound: () => null, readRunningDeploy: () => null, readLeaseFn: () => ({ held: false }),
    mergeRound: async options => { seen = options.autonomous; return { ok: false, stopped_at: 'autonomous-review-required', reason: 'fixture stop' }; },
    recordStart() {}, record() {} });
  assert.deepEqual(seen, admitted.autonomous);
});
