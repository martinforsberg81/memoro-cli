import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './autonomous-publication-fixture.js';
import { reviewer } from './autonomous-state-fixture.js';
import { autonomousMergeDoor } from '../../src/mc/autonomous-pr.js';
import { reviewRelevance } from '../../src/mc/autonomous-merge.js';
import { landJob } from '../../src/mc/merger.js';
import { parseQueue, mergesPath } from '../../src/mc/merge-queue.js';
import { runDocsMerge } from '../../src/mc/docs-merge.js';
import { run as mergeCommand } from '../../src/mc/commands/merge.js';
import { clean, ready, queue, receiptPath, moveMain, round } from './autonomous-merge-fixture.js';

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
