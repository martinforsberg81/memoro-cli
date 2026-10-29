import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { run } from '../../../src/mc/commands/project.js';
import { openProjectPrs } from '../../../src/mc/commands/project-amend.js';
import { REVIEW_STEP } from '../../../src/mc/plan-write.js';
import { parseEntry, registerPath, lockPath, realLock } from '../../../src/mc/register.js';

function fixture({ review = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-amend-'));
  const home = join(root, 'programs');
  const dir = join(home, 'text', 'alpha');
  mkdirSync(dir, { recursive: true });
  const step = title => ({ title, status: 'ready', done_when: 'The targeted tests pass.',
    instruction: ['Implement the specified behavior.'], runner: { model: 'haiku', effort: 'high' } });
  const plan = {
    schema: 'mc-plan', version: 1, repo: 'memoro',
    goal: ['Preserve the document.'], contract: ['Keep the format layer.'], out_of_scope: ['Layout.'],
    success_criteria: [{ criterion: 'The bytes are preserved.', check: 'mc gate tests/bytes.test.js', met: false }],
    documents: [], steps: [step('Landed'), step('Compiler'), step('Binding'), ...(review ? [structuredClone(REVIEW_STEP)] : [])],
  };
  const file = join(dir, 'PLAN.json');
  writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  let entry = parseEntry(JSON.stringify({
    project: 'alpha', repo: 'memoro', programme: 'text', plan: file,
    steps: [
      { key: 'Landed', status: 'done', pr: 11, landed: { sha: 'abc', into: 'main', at: '2026-10-01T00:00:00Z' } },
      { key: 'Compiler', status: 'blocked', branch: 'alpha-4', pr: null,
        blocked_by: { kind: 'decision', name: 'scope' }, reason: 'Read next style.',
        comments: ['Preserve commit abcdef.'], attempts: 2, stacked_on: { index: 0, pr: 11, sha: 'abc' } },
      { key: 'Binding', status: 'ready' },
      ...(review ? [{ key: REVIEW_STEP.title, status: 'ready' }] : []),
    ], criteria: [{ criterion: plan.success_criteria[0].criterion, met: false, at: null }],
  }));
  const register = registerPath(root, 'alpha');
  const out = []; const err = [];
  const deps = {
    root, home, env: {}, repos: [{ name: 'memoro', path: root }],
    now: () => new Date('2026-10-27T10:00:00Z'),
    stdout: { write: value => out.push(value) }, stderr: { write: value => err.push(value) },
    read: path => path === register ? JSON.stringify(entry) : null,
    write: () => { throw new Error('an amendment must never write the register'); },
    lock: (_root, fn) => fn(), openProjectPrs: () => [], by: () => ({ pid: 123 }),
  };
  const amendment = {
    contract: ['Keep preservation guarantees while correcting the implementation.'],
    steps: [{ number: 2, instruction: ['Read and expose the next style without rewriting it.'], done_when: 'The heading test passes.', model: 'fast', effort: 'high' },
      { number: 3, instruction: ['Retain history when acknowledging a save.'] }],
    success_criteria: [{ criterion: 'The bytes and next style are preserved.', check: 'mc gate tests/bytes.test.js tests/styles.test.js' }],
  };
  const input = join(root, 'amendment.json');
  const args = ['amend', 'alpha', '--amendment-file', input, '--reason', 'Approved in the programme session.'];
  return {
    root, dir, file, input, args, plan, amendment, deps, out, err,
    entry: () => entry, setEntry: value => { entry = value; },
    call: (value = amendment, argv = args) => { writeFileSync(input, JSON.stringify(value)); return run(argv, deps); },
    readPlan: () => JSON.parse(readFileSync(file, 'utf8')),
    audits: () => existsSync(join(dir, 'amendments')) ? readdirSync(join(dir, 'amendments')).map(name => JSON.parse(readFileSync(join(dir, 'amendments', name), 'utf8'))) : [],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('amend atomically changes all allowed fields, audits before/after and never releases or rewrites state', async () => {
  const f = fixture({ review: true });
  try {
    const state = JSON.stringify(f.entry());
    const before = readFileSync(f.file, 'utf8');
    assert.equal(await f.call(), 0, f.err.join(''));
    const next = f.readPlan();
    assert.deepEqual(next.contract, f.amendment.contract);
    assert.deepEqual(next.steps[0], f.plan.steps[0]);
    assert.deepEqual(next.steps.at(-1), REVIEW_STEP);
    assert.deepEqual(next.steps[1].instruction, f.amendment.steps[0].instruction);
    assert.equal(next.success_criteria[0].met, false);
    assert.equal(JSON.stringify(f.entry()), state, 'branch, commit notes, blocker, PR and history stay exactly as held');
    const [audit] = f.audits();
    assert.equal(f.audits().length, 1);
    assert.deepEqual(audit.before, f.plan);
    assert.deepEqual(audit.after, next);
    assert.equal(audit.reason, 'Approved in the programme session.');
    assert.equal(audit.at, '2026-10-27T10:00:00Z');
    assert.equal(audit.by.pid, 123);
    assert.equal(audit.before_sha256, createHash('sha256').update(before).digest('hex'));
    assert.equal(audit.after_sha256, createHash('sha256').update(readFileSync(f.file)).digest('hex'));
    assert.match(f.out.join(''), /still blocked; release separately/);
  } finally { f.cleanup(); }
});

test('amend refuses unsafe standing and a step session without touching plan, register or audit', async t => {
  const cases = {
    ready: f => { f.entry().steps[1].status = 'ready'; },
    running: f => { f.entry().steps[2].status = 'running'; },
    landing: f => { f.entry().steps[0].status = 'landing'; },
    session: f => { f.entry().steps[1].session = { pid: 123 }; },
    timer: f => { f.entry().steps[1].blocked_by = { kind: 'time', name: 'later', at: '2026-11-01T00:00:00Z' }; },
    dependency: f => { f.entry().steps[1].blocked_by = { kind: 'project', name: 'another' }; },
    proof: f => { f.entry().criteria[0].met = true; },
    missing: f => f.setEntry(null),
    mismatch: f => { f.entry().steps[1].key = 'Other'; },
    repository: f => { f.entry().repo = 'memoro-cli'; },
    archived: f => writeFileSync(join(f.dir, 'CLOSEOUT.json'), '{}'),
    runner: f => { f.deps.env.MC_STEP = 'another:0'; },
    openPr: f => { f.deps.openProjectPrs = () => [{ number: 99 }]; },
    lookupError: f => { f.deps.openProjectPrs = () => { throw new Error('offline'); }; },
    malformedLookup: f => { f.deps.openProjectPrs = () => null; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture();
    try {
      change(f);
      const state = JSON.stringify(f.entry());
      const before = readFileSync(f.file, 'utf8');
      assert.equal(await f.call(), 1, f.err.join(''));
      assert.equal(readFileSync(f.file, 'utf8'), before);
      assert.equal(JSON.stringify(f.entry()), state);
      assert.deepEqual(f.audits(), []);
    } finally { f.cleanup(); }
  });
});

test('amend validates the complete proposed plan and refuses protected fields and invalid instructions', async t => {
  const cases = {
    empty: {},
    goal: { goal: ['Changed'] },
    status: { steps: [{ number: 2, status: 'ready' }] },
    rename: { steps: [{ number: 2, title: 'Different' }] },
    past: { steps: [{ number: 1, instruction: ['Rewrite history.'] }] },
    duplicate: { steps: [{ number: 2 }, { number: 2 }] },
    missingStep: { steps: [{ number: 9 }] },
    badContract: { contract: [] },
    nullStep: { steps: [null] },
    badInstruction: { steps: [{ number: 2, instruction: [] }] },
    wrongModel: { steps: [{ number: 2, model: 'gpt-6.1-sol' }] },
    concreteModel: { steps: [{ number: 2, model: 'opus' }] },
    wrongEffort: { steps: [{ number: 2, effort: 'unlimited' }] },
    person: { steps: [{ number: 2, done_when: 'Martin approves.' }] },
    proseDependency: { steps: [{ number: 2, instruction: ['Set blocked_by later.'] }] },
    noCriteria: { success_criteria: [] },
    met: { success_criteria: [{ criterion: 'It passes.', check: 'mc gate tests/check.test.js', met: true }] },
    deployment: { success_criteria: [{ criterion: 'It passes.', check: 'Run it after the deploy.' }] },
    directoryTest: { success_criteria: [{ criterion: 'It passes.', check: 'node --test tests/mc' }] },
  };
  for (const [name, amendment] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture();
    try {
      const before = readFileSync(f.file, 'utf8');
      assert.equal(await f.call(amendment), 1, f.err.join(''));
      assert.equal(readFileSync(f.file, 'utf8'), before);
      assert.deepEqual(f.audits(), []);
    } finally { f.cleanup(); }
  });
});

test('amend preserves review steps, built steps and all prior ordinary edit refusals', async () => {
  const f = fixture({ review: true });
  try {
    assert.equal(await f.call({ steps: [{ number: 4, instruction: ['Change review.'] }] }), 1);
    f.entry().steps[2].status = 'built';
    assert.equal(await f.call({ steps: [{ number: 3, instruction: ['Change built work.'] }] }), 1);
    assert.equal(await run(['edit', 'alpha', '--contract', 'New'], f.deps), 1);
    assert.equal(await run(['step', 'edit', 'alpha', '2', '--done-when', 'New test passes.'], f.deps), 1);
    assert.deepEqual(f.readPlan(), f.plan);
  } finally { f.cleanup(); }
});

test('amend rejects concurrent register/plan changes after the remote check', async t => {
  for (const kind of ['register', 'plan']) await t.test(kind, async () => {
    const f = fixture();
    try {
      f.deps.openProjectPrs = () => {
        if (kind === 'register') f.entry().steps[1].status = 'ready';
        else writeFileSync(f.file, `${JSON.stringify({ ...f.plan, contract: ['Another editor wrote this.'] })}\n`);
        return [];
      };
      assert.equal(await f.call(), 1);
      assert.match(f.err.join(''), /changed during review/);
      assert.deepEqual(f.audits(), []);
      assert.deepEqual(f.readPlan().contract, kind === 'plan' ? ['Another editor wrote this.'] : f.plan.contract);
    } finally { f.cleanup(); }
  });
});

test('audit failure leaves the plan unchanged; plan-write failure leaves only a distinguishable authorization attempt', async t => {
  for (const fail of ['audit', 'plan']) await t.test(fail, async () => {
    const f = fixture();
    try {
      f.deps[fail === 'audit' ? 'writeAudit' : 'writeAmendedPlan'] = () => { throw new Error('disk full'); };
      const before = readFileSync(f.file, 'utf8');
      assert.equal(await f.call(), 1);
      assert.equal(readFileSync(f.file, 'utf8'), before);
      assert.equal(f.audits().length, fail === 'audit' ? 0 : 1);
      if (fail === 'plan') assert.notEqual(f.audits()[0].after_sha256, createHash('sha256').update(before).digest('hex'));
    } finally { f.cleanup(); }
  });
});

test('amend requires a sent plan, a reason and a readable JSON amendment, with no extra flags', async () => {
  const f = fixture();
  try {
    assert.equal(await run(['amend', 'alpha'], f.deps), 2);
    assert.equal(await f.call(f.amendment, [...f.args, '--model', 'haiku']), 2);
    assert.equal(await f.call(f.amendment, [...f.args.slice(0, -1), ' ']), 2);
    assert.equal(await f.call(f.amendment, ['amend', 'absent', ...f.args.slice(2)]), 1);
    writeFileSync(f.input, '{');
    assert.equal(await run(f.args, f.deps), 1);
    rmSync(f.input);
    assert.equal(await run(f.args, f.deps), 1);
    writeFileSync(join(f.dir, 'DRAFT.json'), JSON.stringify(f.plan)); rmSync(f.file);
    assert.equal(await f.call(), 1);
  } finally { f.cleanup(); }
});

test('strict register locking never enters a held lock or removes its holder', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-amend-lock-'));
  try {
    const path = lockPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '987654');
    let called = false;
    assert.throws(() => realLock(root, () => { called = true; }, { alive: () => true, waitMs: -1, strict: true }), /being written/);
    assert.equal(called, false);
    assert.equal(readFileSync(path, 'utf8'), '987654');
    rmSync(path);
    assert.equal(realLock(root, () => 42, { strict: true }), 42);
    assert.equal(existsSync(path), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the PR guard includes named and retained branches/PRs and fails closed on lookup errors or truncation', () => {
  const repo = { path: '/repo' };
  const entry = { steps: [{ branch: 'retained-work', pr: 9 }] };
  const rows = [
    { number: 1, headRefName: 'alpha' }, { number: 2, headRefName: 'alpha-4' },
    { number: 3, headRefName: 'alpha-repair' }, { number: 4, headRefName: 'retained-work' },
    { number: 9, headRefName: 'other-name' }, { number: 10, headRefName: 'unrelated' },
  ];
  const spawn = (_cmd, args, opts) => {
    assert.ok(args.includes('open')); assert.ok(args.includes('1000'));
    assert.equal(opts.cwd, '/repo');
    return { status: 0, stdout: JSON.stringify(rows) };
  };
  assert.deepEqual(openProjectPrs(repo, 'alpha', entry, spawn).map(pr => pr.number), [1, 2, 3, 4, 9]);
  for (const result of [
    { status: 1, stderr: 'offline' }, { status: 0, stdout: '{' },
    { status: 0, stdout: '{}' }, { status: 0, stdout: '[{}]' },
    { status: 0, stdout: JSON.stringify(Array(1000).fill(rows[0])) },
  ]) assert.throws(() => openProjectPrs(repo, 'alpha', entry, () => result));
});
