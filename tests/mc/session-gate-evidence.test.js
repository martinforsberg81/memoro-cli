import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { captureWorktree, gateReceipt, persistGateReceipt, sameContent } from '../../src/mc/session-gate-evidence.js';
import { findGreen, findGreenForHead, GATE_MEASUREMENT_VERSION, selectionHash } from '../../src/mc/gate-greens.js';
import { runSessionGate } from '../../src/mc/session-gate-run.js';
import { realTests } from '../../src/mc/repo-gate.js';

const GREEN = 'TAP version 13\nok 1 - works\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-evidence-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Gate Test');
  git(cwd, 'config', 'user.email', 'gate@example.invalid');
  writeFileSync(join(cwd, '.gitignore'), 'ignored/\n');
  writeFileSync(join(cwd, 'a.test.js'), 'export {};\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const request = () => ({ cwd, files: ['a.test.js'], reservation: { root: join(root, 'state') },
    measurement: { repo: 'repo', run: 'gate-one', session_run: 'session-one', goal_revision: 3, base, candidate: captureWorktree(cwd) } });
  return { cwd, root, base, request };
}
const receiptOf = (result) => JSON.parse(readFileSync(result.evidence.path, 'utf8'));
const quiet = { write: () => {} };

it('fingerprints staged, unstaged, deleted, executable, symlink and untracked bytes without changing the real index', (t) => {
  const { cwd } = fixture(t);
  writeFileSync(join(cwd, 'staged.txt'), 'staged\n');
  git(cwd, 'add', 'staged.txt');
  writeFileSync(join(cwd, 'staged.txt'), 'unstaged\n');
  writeFileSync(join(cwd, 'new.txt'), 'untracked\n');
  symlinkSync('new.txt', join(cwd, 'link'));
  const index = readFileSync(join(cwd, '.git/index'));
  const before = captureWorktree(cwd);
  assert.deepEqual(readFileSync(join(cwd, '.git/index')), index);
  assert.equal(sameContent(before, captureWorktree(cwd)), true);
  mkdirSync(join(cwd, 'ignored'));
  writeFileSync(join(cwd, 'ignored/output'), 'not code');
  assert.equal(sameContent(before, captureWorktree(cwd)), true);
  writeFileSync(join(cwd, 'new.txt'), 'changed');
  assert.equal(sameContent(before, captureWorktree(cwd)), false);
  const bytes = captureWorktree(cwd);
  chmodSync(join(cwd, 'new.txt'), 0o755);
  assert.equal(sameContent(bytes, captureWorktree(cwd)), false);
  rmSync(join(cwd, 'a.test.js'));
  const deleted = captureWorktree(cwd);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'measured content');
  assert.equal(git(cwd, 'rev-parse', 'HEAD^{tree}'), deleted.tree);
});

it('assume-unchanged does not hide mutations and staged ignored additions are measured', (t) => {
  const { cwd } = fixture(t);
  const before = captureWorktree(cwd);
  git(cwd, 'update-index', '--assume-unchanged', 'a.test.js');
  writeFileSync(join(cwd, 'a.test.js'), 'changed\n');
  assert.equal(sameContent(before, captureWorktree(cwd)), false);
  mkdirSync(join(cwd, 'ignored'));
  writeFileSync(join(cwd, 'ignored/staged'), 'included\n');
  git(cwd, 'add', '-f', 'ignored/staged');
  const staged = captureWorktree(cwd);
  assert.match(git(cwd, 'ls-tree', '-r', staged.tree), /ignored\/staged/u);
});

it('raw mutations invalidate evidence even when git normalizes them to the same tree', (t) => {
  const { cwd } = fixture(t);
  writeFileSync(join(cwd, '.gitattributes'), '*.txt text eol=lf\n');
  writeFileSync(join(cwd, 'line.txt'), 'one\n');
  const before = captureWorktree(cwd);
  writeFileSync(join(cwd, 'line.txt'), 'one\r\n');
  const after = captureWorktree(cwd);
  assert.equal(before.tree, after.tree);
  assert.equal(sameContent(before, after), false);
});

it('a completed measurement persists immutable identity, base, scope, version, times and outcome', async (t) => {
  const { request } = fixture(t);
  const req = request();
  const result = await runSessionGate(req, { ...quiet, tests: async () => ({ code: 0, tap: GREEN }) });
  const receipt = receiptOf(result);
  assert.equal(receipt.outcome, 'green');
  assert.equal(receipt.gate_version, GATE_MEASUREMENT_VERSION);
  for (const key of ['repo', 'run', 'session_run', 'goal_revision', 'base']) assert.equal(receipt[key], req.measurement[key]);
  assert.equal(receipt.tree, req.measurement.candidate.tree);
  assert.equal(receipt.repository, req.measurement.candidate.repository);
  assert.ok(Date.parse(receipt.ended) >= Date.parse(receipt.started));
  assert.deepEqual(receipt.coverage.files, ['a.test.js']);
  assert.equal(receipt.coverage.kind, 'named');
  assert.equal(persistGateReceipt({ root: req.reservation.root, receipt }), result.evidence.path);
  assert.throws(() => persistGateReceipt({ root: req.reservation.root, receipt: { ...receipt, tree: 'replacement' } }), /EEXIST/u);
});

it('changes while waiting or testing invalidate the measurement, including generated untracked code', async (t) => {
  for (const when of ['waiting', 'testing']) {
    const { cwd, request } = fixture(t);
    const req = request();
    let calls = 0;
    if (when === 'waiting') writeFileSync(join(cwd, 'a.test.js'), 'changed');
    const result = await runSessionGate(req, { ...quiet, tests: async () => {
      calls++;
      writeFileSync(join(cwd, 'generated.js'), 'generated during test');
      return { code: 0, tap: GREEN };
    } });
    assert.equal(calls, when === 'waiting' ? 0 : 1);
    assert.equal(result.ok, false);
    assert.equal(receiptOf(result).outcome, 'invalid');
  }
});

it('running, empty, unknown-exit, interrupted and red attempts never mint green', async (t) => {
  const attempts = [
    { code: null, tap: GREEN }, { tap: GREEN }, { code: 1, tap: GREEN },
    { code: 0, tap: '' }, { code: 0, tap: '# tests 0\n# pass 0\n# fail 0\n' },
    { code: 0, tap: '# tests 1\n# pass 0\n# fail 0\n' },
    { code: 0, tap: GREEN, aborted: true }, { code: 0, tap: GREEN, timedOut: true },
  ];
  for (const run of attempts) {
    const { request } = fixture(t);
    const req = request();
    const result = await runSessionGate(req, { ...quiet, tests: async () => run });
    assert.equal(result.ok, false);
    assert.notEqual(receiptOf(result).outcome, 'green');
    assert.equal(existsSync(join(req.reservation.root, 'gate-greens.jsonl')), false);
  }
  const { request } = fixture(t);
  const req = request();
  let release;
  const pending = runSessionGate(req, { ...quiet, tests: () => new Promise((resolve) => { release = resolve; }) });
  assert.equal(existsSync(join(req.reservation.root, 'gate-evidence')), false);
  release({ code: 0, tap: GREEN });
  await pending;
});

it('an empty selection and an aborted command sequence cannot mint green', async (t) => {
  for (const mode of ['empty', 'interrupted', 'unknown', 'unavailable']) {
    const { request } = fixture(t);
    const req = { ...request(), files: null, select: 'selector' };
    const controller = new AbortController();
    const result = await runSessionGate(req, { ...quiet, signal: controller.signal,
      select: async () => ({ ok: true, files: [], commands: mode === 'empty' ? [] : [{ packageScript: 'check', unavailableExitCode: 69 }] }),
      shell: async () => {
        if (mode === 'interrupted') controller.abort();
        return { status: mode === 'unknown' ? null : mode === 'unavailable' ? 69 : 0 };
      },
    });
    assert.notEqual(receiptOf(result).outcome, 'green');
  }
});

it('named or pattern-filtered runs never populate broader selector coverage; complete affected runs do', async (t) => {
  for (const mode of ['named', 'pattern', 'affected', 'flag-filter']) {
    const { request } = fixture(t);
    const req = { ...request(), select: 'selector', pattern: mode === 'pattern' ? 'one test' : null,
      flags: mode === 'flag-filter' ? ['--test-name-pattern=one'] : [] };
    if (mode === 'affected' || mode === 'flag-filter') req.files = null;
    const selected = { ok: true, files: ['a.test.js'], commands: [{ packageScript: 'lint', passBaseRef: true }] };
    const result = await runSessionGate(req, { ...quiet, select: async () => selected,
      tests: async () => ({ code: 0, tap: GREEN }), shell: async () => ({ status: 0 }) });
    const receipt = receiptOf(result);
    assert.equal(receipt.outcome, 'green');
    assert.equal(receipt.coverage.pattern, req.pattern);
    assert.equal(receipt.coverage.commands.length, req.files ? 0 : 1);
    assert.equal(receipt.execution.commands.length, req.files ? 0 : 1);
    const cached = findGreen({ root: req.reservation.root, repo: 'repo', tree: receipt.tree, selection: selectionHash(selected) });
    assert.equal(Boolean(cached), mode === 'affected');
    assert.equal(Boolean(findGreenForHead({ root: req.reservation.root, repo: 'repo', headTree: receipt.tree })), mode === 'affected');
    assert.equal(readdirSync(join(req.reservation.root, 'gate-evidence')).length, 1);
  }
});

it('receipt objects are deeply frozen and cannot relabel incomplete results green', (t) => {
  const { request } = fixture(t);
  const measurement = request().measurement;
  const receipt = gateReceipt({ measurement, before: measurement.candidate, after: measurement.candidate,
    result: { ok: true, code: null }, started: '2026-01-01T00:00:00Z', ended: '2026-01-01T00:00:01Z' });
  assert.equal(receipt.outcome, 'incomplete');
  assert.throws(() => { receipt.outcome = 'green'; }, TypeError);
});

it('an unfinished resource batch cannot hide behind passing totals from another batch', async () => {
  for (const unfinished of [{ code: null, tap: GREEN }, { code: 0, tap: '' }, { code: 0, tap: '# tests 0\n# pass 0\n# fail 0\n' }]) {
    let calls = 0;
    const result = await realTests({ files: ['a.test.js', 'db.test.js'], classes: { 'db.test.js': 'sqlite' },
      runBatch: async () => ++calls === 1 ? { code: 0, tap: GREEN } : unfinished,
    });
    assert.notEqual(result.code, 0);
  }
});

it('interruption during the final content observation cannot mint green', async (t) => {
  const { request } = fixture(t);
  const req = request();
  const controller = new AbortController();
  let observations = 0;
  const result = await runSessionGate(req, { ...quiet, signal: controller.signal,
    snapshot: (cwd) => {
      const snapshot = captureWorktree(cwd);
      if (++observations === 2) controller.abort();
      return snapshot;
    },
    tests: async () => ({ code: 0, tap: GREEN }),
  });
  assert.equal(result.ok, false);
  assert.equal(receiptOf(result).outcome, 'red');
});
