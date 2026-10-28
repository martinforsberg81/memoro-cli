import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { autonomousProject, programmeContract, attribution } from './autonomy-fixtures.js';
import { buildSessionStart, validateSessionResult, persistSessionResult, readCurrentHandoff,
  HANDOFF_MAX_BYTES, SESSION_RESULT_MAX_BYTES, SESSION_START_MAX_BYTES } from '../../src/mc/session-handoff.js';
import { captureWorktree, gateReceipt, persistGateReceipt } from '../../src/mc/session-gate-evidence.js';
import { gateConfiguration } from '../../src/mc/gate-greens.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { AUTONOMOUS_EXECUTION_ENABLED } from '../../src/mc/autonomous-project.js';

const SHA = 'a'.repeat(40);
const context = (runId = 'build-1') => ({ assignment: autonomousProject(), programme: programmeContract(), runId });
const binding = (run_id = 'build-1') => ({ ...attribution(), run_id });
function result(runId = 'build-1', outcome = 'incomplete') {
  return { schema: 'mc-session-result', version: 1, ...binding(runId), outcome,
    reason: ['continue', 'review-ready'].includes(outcome) ? null : 'Session limit reached before publication.',
    handoff: { schema: 'mc-session-handoff', version: 1, ...binding(runId), published_sha: SHA,
      interpretation: { implemented: ['Implemented the schema.'], remaining: outcome === 'review-ready' ? [] : ['Verify integration.'],
        decisions: ['Keep v1 behavior unchanged.'], failed_approaches: ['Transcript concatenation exceeded the budget.'], next_focus: 'Read the schema and verify the next criterion.' },
      evidence: [{ ...binding(runId), criterion_id: 'schema', reference: 'evidence/schema.json', summary: 'Measured schema cases; integration remains unmeasured.' }],
      references: [{ kind: 'code', reference: 'src/mc/autonomous-project.js#validateAutonomousProject' },
        { kind: 'log', reference: 'runner/log/build-1.jsonl' }] } };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownership = { branch: 'goal-branch', pr: 123 };
  return { root, ownership, save: (value, extras = {}, deps) => persistSessionResult({ root, ownership, ...context(value.run_id), result: value, ...extras }, deps) };
}
function git(cwd, ...args) {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
}
// Real commits and a local bare remote; synthetic completed check execution,
// not a claim that the fixture's JavaScript test was executed by a provider.
function published(t, overrides = {}) {
  const fx = fixture(t);
  const cwd = join(fx.root, 'repo'); mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', fx.ownership.branch);
  git(cwd, 'config', 'user.name', 'Handoff Test'); git(cwd, 'config', 'user.email', 'handoff@example.invalid');
  writeFileSync(join(cwd, 'schema.test.js'), 'export {};\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'baseline');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const remote = join(fx.root, 'remote.git'); git(cwd, 'init', '--bare', '-q', remote);
  git(cwd, 'push', '-q', remote, `HEAD:refs/heads/${fx.ownership.branch}`);
  const pushed = git(cwd, 'ls-remote', remote, `refs/heads/${fx.ownership.branch}`).split(/\s/u)[0];
  const candidate = captureWorktree(cwd);
  const selection = { kind: 'affected', files: ['schema.test.js'], commands: [], flags: [], pattern: null };
  const configuration = gateConfiguration({ select: 'fixture-selector' });
  const receipt = gateReceipt({ measurement: { repo: 'memoro-cli', run: 'gate-1', session_run: 'build-1', goal_revision: 1,
    configuration, base: head, candidate }, before: candidate, after: candidate,
    result: { ok: true, code: 0, coverage: selection, execution: { tests: { exit: 0, finished: true,
      totals: { tests: 1, pass: 1, fail: 0, cancelled: 0 } }, commands: [] } },
    started: '2026-10-28T12:00:00Z', ended: '2026-10-28T12:01:00Z' });
  persistGateReceipt({ root: fx.root, receipt: { ...receipt, ...overrides } });
  const value = result('build-1', 'continue'); value.handoff.published_sha = head;
  return { ...fx, save: (value, extras = {}, deps) => fx.save(value, { completion: { exit_code: 0, interrupted: false }, ...extras }, deps), cwd, head, value, publication: { cwd, head, pushed, run: 'gate-1', configuration, selection } };
}

it('fresh starts preserve the full approved assignment, programme criteria, scope, authority and planned stops', () => {
  const ctx = context();
  const payload = buildSessionStart(ctx);
  const parsed = JSON.parse(payload);
  assert.deepEqual(parsed.assignment, ctx.assignment);
  assert.deepEqual(parsed.programme, ctx.programme);
  assert.equal(parsed.previous, null);
  assert.equal(parsed.run_id, ctx.runId);
  assert.ok(Buffer.byteLength(payload) <= SESSION_START_MAX_BYTES);
  assert.match(parsed.standing, /Only plan revises goals/);
  assert.equal(AUTONOMOUS_EXECUTION_ENABLED, false);
});

it('accepts all four bound result shapes without treating validation as observed success', () => {
  for (const outcome of ['continue', 'review-ready', 'incomplete', 'needs-plan']) {
    assert.deepEqual(validateSessionResult(result('build-1', outcome), context()), { ok: true, problems: [] });
  }
});

it('rejects malformed schemas, missing continuation fields and model-supplied observation facts', () => {
  const mutations = [
    value => { value.schema = 'other'; }, value => { value.version = 2; }, value => { value.outcome = 'success'; },
    value => { delete value.handoff; }, value => { delete value.handoff.interpretation.decisions; },
    value => { value.handoff.interpretation.failed_approaches = 'none'; }, value => { value.handoff.references = [null]; },
    value => { value.handoff.evidence[0].criterion_id = 'unknown'; }, value => { value.reason = ''; },
    value => { value.handoff.published_sha = 'short'; }, value => { value.observed = { green: true }; },
    value => { value.handoff.interpretation.confirmed = true; }, value => { value.handoff.evidence[0].green = true; },
    value => { value.handoff.evidence = [null]; }, value => { value.handoff.interpretation.remaining = new Array(2); },
  ];
  for (const mutate of mutations) {
    const value = result(); mutate(value);
    assert.equal(validateSessionResult(value, context()).ok, false, mutate.toString());
  }
  for (const value of [null, [], 'text', 3, { self: null }]) assert.equal(validateSessionResult(value, context()).ok, false);
  const circular = result(); circular.self = circular;
  assert.equal(validateSessionResult(circular, context()).ok, false);
});

it('rejects results, handoffs and evidence from any other run or assignment revision', () => {
  for (const field of ['run_id', 'programme_id', 'programme_revision', 'project_id', 'goal_revision']) {
    for (const path of [value => value, value => value.handoff, value => value.handoff.evidence[0]]) {
      const value = result(); const target = path(value);
      target[field] = typeof target[field] === 'number' ? 2 : 'other-run';
      const validation = validateSessionResult(value, context());
      assert.equal(validation.ok, false, field);
      assert.match(validation.problems.join('; '), /mismatched/);
    }
  }
});

it('bounds handoff and whole result by UTF-8 bytes, including multibyte text', () => {
  const value = result(); value.handoff.interpretation.implemented = ['å'.repeat(HANDOFF_MAX_BYTES / 2)];
  assert.match(validateSessionResult(value, context()).problems.join('; '), /handoff: exceeds/);
  value.reason = 'x'.repeat(SESSION_RESULT_MAX_BYTES);
  assert.match(validateSessionResult(value, context()).problems.join('; '), /session result: exceeds/);
});

it('bounds the entire start payload without silently dropping requirements or reference paths', () => {
  const ctx = context(); ctx.assignment.instruction = ['x'.repeat(SESSION_START_MAX_BYTES)];
  assert.throws(() => buildSessionStart(ctx), /session start: exceeds/);
  assert.equal(ctx.assignment.success_criteria.length, 2);
  const docs = context(); docs.assignment.documents = [{ label: 'Detailed design', path: 'docs/design.md' }];
  assert.deepEqual(JSON.parse(buildSessionStart(docs)).assignment.documents, docs.assignment.documents);
  const largeProgramme = context(); largeProgramme.programme.specification = ['å'.repeat(SESSION_START_MAX_BYTES / 2)];
  assert.throws(() => buildSessionStart(largeProgramme), /session start: exceeds/);
});

it('rejects draft programmes, legacy assignments and missing approved snapshots', () => {
  const draft = context(); draft.programme.status = 'draft'; delete draft.programme.approval;
  assert.throws(() => buildSessionStart(draft), /draft grants no authority/);
  assert.throws(() => buildSessionStart({ ...context(), assignment: { version: 1, steps: [] } }), /version: must be 2/);
  assert.throws(() => buildSessionStart({ ...context(), programme: undefined }), /approved programme snapshot/);
});

it('review-ready requires no remaining work and evidence for each premerge criterion, not after-integration work', () => {
  const value = result('build-1', 'review-ready');
  assert.equal(validateSessionResult(value, context()).ok, true);
  value.handoff.evidence = [];
  assert.match(validateSessionResult(value, context()).problems.join('; '), /every premerge criterion/);
  value.handoff.interpretation.remaining = ['Unfinished'];
  assert.match(validateSessionResult(value, context()).problems.join('; '), /remaining work must be empty/);
});

it('a current handoff replaces prompt history while immutable attempt artifacts stay addressable', t => {
  const fx = fixture(t);
  const first = fx.save(result());
  const bytes = readFileSync(first.artifact, 'utf8');
  const secondResult = result('build-2'); secondResult.handoff.interpretation.next_focus = 'New focused continuation.';
  const second = fx.save(secondResult, { expectedPreviousRun: 'build-1' });
  assert.equal(readFileSync(first.artifact, 'utf8'), bytes);
  assert.deepEqual(readCurrentHandoff({ root: fx.root, ...context('build-2') }), second);
  const payload = buildSessionStart({ ...context('build-3'), previous: second, previousRunId: 'build-2' });
  const parsed = JSON.parse(payload);
  assert.deepEqual(parsed.previous.handoff, secondResult.handoff);
  assert.deepEqual(parsed.previous.handoff.evidence, secondResult.handoff.evidence);
  assert.deepEqual(parsed.previous.handoff.references, secondResult.handoff.references);
  assert.equal(payload.includes(first.artifact), false);
  assert.equal(parsed.previous.observed.normal_exit, false);
  assert.equal(parsed.previous.observed.gate, null);
  assert.equal(readdirSync(join(fx.root, 'session-handoffs', 'test-programme', 'test-project')).filter(f => /^build-/.test(f)).length, 2);
});

it('requires an explicit predecessor and rejects another run/revision instead of using it as current proof', t => {
  const fx = fixture(t); const previous = fx.save(result());
  assert.throws(() => buildSessionStart({ ...context('build-2'), previous }), /explicit different predecessor/);
  assert.throws(() => buildSessionStart({ ...context('build-2'), previousRunId: 'build-1' }), /missing/);
  assert.throws(() => buildSessionStart({ ...context('build-2'), previous, previousRunId: 'other' }), /mismatched/);
  const revised = context('build-2'); revised.assignment.goal_revision = 2;
  assert.throws(() => buildSessionStart({ ...revised, previous, previousRunId: 'build-1' }), /mismatched/);
  assert.throws(() => readCurrentHandoff({ root: fx.root, ...context('other') }), /another run/);
  assert.equal(validateSessionResult({ ...result('build-2'), handoff: previous.handoff }, context('build-2')).ok, false);
});

it('persists incomplete and needs-plan outcomes without a gate or publication and never claims green', t => {
  for (const outcome of ['incomplete', 'needs-plan']) {
    const fx = fixture(t); const value = result('build-1', outcome); value.handoff.published_sha = null;
    const saved = fx.save(value);
    assert.deepEqual(saved.observed, { ...fx.ownership, head: null, pushed: null, tree: null, gate: null, completion: null, normal_exit: false });
    assert.equal(readCurrentHandoff({ root: fx.root, ...context() }).outcome, outcome);
  }
});

it('a normal continuation or review-ready requires independently observed matching push and relevant green evidence', t => {
  for (const outcome of ['continue', 'review-ready']) {
    const fx = published(t); fx.value.outcome = outcome;
    if (outcome === 'review-ready') fx.value.handoff.interpretation.remaining = [];
    const saved = fx.save(fx.value, { publication: fx.publication });
    assert.equal(saved.observed.normal_exit, true);
    assert.equal(saved.observed.head, fx.head);
    assert.equal(saved.observed.pushed, fx.publication.pushed);
    assert.equal(saved.observed.tree, git(fx.cwd, 'rev-parse', 'HEAD^{tree}'));
    assert.equal(saved.observed.gate, join(fx.root, 'gate-evidence', 'gate-1.json'));
    assert.deepEqual(readCurrentHandoff({ root: fx.root, ...context() }), saved);
    assert.deepEqual(fx.save(fx.value, { publication: fx.publication }), saved, 'byte-identical retry');
  }
});

it('rejects missing gate, stale push, wrong head, branch/PR and broadened selection before recording normal results', t => {
  const fx = published(t);
  assert.throws(() => fx.save(fx.value), /published SHA/);
  for (const overrides of [{ pushed: SHA }, { head: SHA }, { run: 'missing' }, { configuration: null },
    { selection: { ...fx.publication.selection, files: ['schema.test.js', 'extra.test.js'] } }]) {
    assert.throws(() => fx.save(fx.value, { publication: { ...fx.publication, ...overrides } }), /published SHA|green receipt/);
  }
  assert.throws(() => fx.save(fx.value, { publication: fx.publication, ownership: { ...fx.ownership, branch: 'other' } }), /branch ownership/);
  assert.throws(() => fx.save(fx.value, { publication: fx.publication, ownership: { ...fx.ownership, pr: null } }), /branch\/PR/);
  assert.equal(readCurrentHandoff({ root: fx.root, ...context() }), null);
});

it('another run/revision/repo, named checks, red, running or incomplete evidence cannot complete this run', t => {
  for (const override of [{ session_run: 'other' }, { goal_revision: 2 }, { repo: 'other' },
    { outcome: 'red' }, { outcome: 'running' }, { outcome: 'incomplete' }, { exit: null },
    { coverage: { kind: 'named', files: ['schema.test.js'], commands: [], flags: [], pattern: null } }]) {
    const fx = published(t, override);
    assert.throws(() => fx.save(fx.value, { publication: fx.publication }), /green receipt/, JSON.stringify(override));
    assert.equal(readCurrentHandoff({ root: fx.root, ...context() }), null);
  }
});

it('post-gate dirty bytes and uncommitted changes cannot become normal handoffs', t => {
  const fx = published(t);
  writeFileSync(join(fx.cwd, 'schema.test.js'), 'changed\n');
  assert.throws(() => fx.save(fx.value, { publication: fx.publication }), /green receipt/);
  git(fx.cwd, 'add', '.'); git(fx.cwd, 'commit', '-qm', 'unmeasured');
  const head = git(fx.cwd, 'rev-parse', 'HEAD'); fx.value.handoff.published_sha = head;
  assert.throws(() => fx.save(fx.value, { publication: { ...fx.publication, head, pushed: head } }), /green receipt/);
});

it('same branch/PR ownership and predecessor CAS prevent stale sessions overwriting a later handoff', t => {
  const fx = fixture(t); fx.save(result());
  const second = result('build-2');
  assert.throws(() => fx.save(second), /stale predecessor/);
  assert.throws(() => fx.save(second, { expectedPreviousRun: 'build-1', ownership: { ...fx.ownership, pr: 456 } }), /ownership cannot change/);
  fx.save(second, { expectedPreviousRun: 'build-1' });
  assert.throws(() => fx.save(result()), /stale predecessor/);
  assert.throws(() => fx.save(result(), { expectedPreviousRun: 'build-2' }), /immutable session attempt/);
  assert.equal(readCurrentHandoff({ root: fx.root, ...context('build-2') }).handoff.run_id, 'build-2');
});

it('immutable attempt writes survive pointer-update crashes and recover idempotently without rewriting history', t => {
  const fx = fixture(t); const value = result();
  assert.throws(() => fx.save(value, {}, { writeCurrent: () => { throw new Error('pointer crash'); } }), /pointer crash/);
  assert.equal(readCurrentHandoff({ root: fx.root, ...context() }), null);
  const artifact = join(fx.root, 'session-handoffs', 'test-programme', 'test-project', 'build-1.json');
  const bytes = readFileSync(artifact, 'utf8');
  const saved = fx.save(value);
  assert.equal(readFileSync(artifact, 'utf8'), bytes);
  assert.deepEqual(fx.save(value), saved);
  const changed = result(); changed.handoff.interpretation.decisions.push('Different history.');
  assert.throws(() => fx.save(changed), /immutable session attempt/);
});

it('missing, malformed, oversized or tampered current artifacts fail closed', t => {
  for (const mutation of [file => rmSync(file), file => writeFileSync(file, '{'),
    file => writeFileSync(file, 'x'.repeat(64 * 1024)), file => writeFileSync(file, '{}')]) {
    const fx = fixture(t); const saved = fx.save(result()); mutation(saved.artifact);
    assert.throws(() => readCurrentHandoff({ root: fx.root, ...context() }), /missing or corrupt|JSON|size limit/);
  }
  const fx = fixture(t); const saved = fx.save(result());
  writeFileSync(join(saved.artifact, '..', 'CURRENT.json'), JSON.stringify({ run_id: '../outside', sha256: 'a'.repeat(64) }));
  assert.throws(() => readCurrentHandoff({ root: fx.root, ...context() }), /invalid current handoff pointer/);
});

it('the combined start limit includes the predecessor even when assignment and handoff fit separately', t => {
  const fx = fixture(t); const value = result();
  value.handoff.interpretation.implemented = ['x'.repeat(12 * 1024)];
  const previous = fx.save(value);
  const ctx = context('build-2'); ctx.assignment.instruction = ['y'.repeat(52 * 1024)];
  assert.ok(Buffer.byteLength(buildSessionStart(ctx)) < SESSION_START_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(previous.handoff)) < HANDOFF_MAX_BYTES);
  assert.throws(() => buildSessionStart({ ...ctx, previous, previousRunId: 'build-1' }), /session start: exceeds/);
});

it('a crash after atomic pointer replacement recovers the same attempt on retry', t => {
  const fx = fixture(t); const value = result();
  assert.throws(() => fx.save(value, {}, { writeCurrent: (file, pointer) => {
    writeJsonAtomic(file, pointer); throw new Error('after pointer crash');
  } }), /after pointer crash/);
  const recovered = readCurrentHandoff({ root: fx.root, ...context() });
  assert.deepEqual(fx.save(value), recovered);
});

it('malformed continuation observations and injected transcript history are rejected at start', t => {
  const fx = fixture(t); const previous = fx.save(result());
  for (const mutate of [value => { value.observed.gate = 'old-green.json'; },
    value => { value.observed.pr = null; }, value => { value.transcripts = ['accumulated history']; },
    value => { value.handoff.interpretation.remaining = undefined; }]) {
    const malformed = structuredClone(previous); mutate(malformed);
    assert.throws(() => buildSessionStart({ ...context('build-2'), previous: malformed, previousRunId: 'build-1' }));
  }
});

it('interrupted, failed and unknown process exits cannot be recorded as normal even with green published content', t => {
  const fx = published(t);
  for (const completion of [null, { exit_code: null, interrupted: false }, { exit_code: 1, interrupted: false },
    { exit_code: 0, interrupted: true }, { exit_code: 0 }, { exit_code: 0, interrupted: false, inferred: true }]) {
    assert.throws(() => fx.save(fx.value, { publication: fx.publication, completion }), /successful process completion/);
    assert.equal(readCurrentHandoff({ root: fx.root, ...context() }), null);
  }
});

it('a JSON null pointer is corrupt rather than an absent handoff', t => {
  const fx = fixture(t); const saved = fx.save(result());
  writeFileSync(join(saved.artifact, '..', 'CURRENT.json'), 'null');
  assert.throws(() => readCurrentHandoff({ root: fx.root, ...context() }), /invalid current handoff pointer/);
});
