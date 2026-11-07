import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { captureWorktree, findPublicationReceipt, gateReceipt, persistGateReceipt, sameContent } from '../../src/mc/session-gate-evidence.js';
import { findGreen, findGreenForHead, GATE_MEASUREMENT_VERSION, gateConfiguration, readGreenReceipt, selectionHash } from '../../src/mc/gate-greens.js';
import { selectorCommand, runSessionGate as sessionGate } from '../../src/mc/session-gate-run.js';
import { deltaFromGreen, executedTimeoutOf, executionIdentity, realTests, resolveTestPlan, selectFiles } from '../../src/mc/repo-gate.js';
import { spawnedBatch, withSpawnedBatches } from './_helpers/spawned-batch.js';

/** Every fake `tests` here stands for a spawn: it reports the batch that spawn would launch. */
const runSessionGate = (request, deps = {}) => sessionGate(request, deps.tests ? { ...deps, tests: withSpawnedBatches(deps.tests) } : deps);
import { runShell } from '../../src/mc/child-async.js';
import { main as selectorMain } from '../../scripts/affected-tests.js';

const GREEN = 'TAP version 13\nok 1 - works\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
/**
 * A test child that reports each file it ran through the round's tracker, as node's
 * reporter does: track the times file, write a started, a done and an ended line per file,
 * complete it. A run with a gate that reports nothing is a run whose files never
 * started (`outputCut`), so a substitute that stands for a finished run reports one.
 */
const reporting = (run) => async ({ files = [], plan = null, flags = [], lanes = 1, times } = {}) => {
  if (times?.track) {
    const path = join(tmpdir(), `mc-evidence-times-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
    times.track(path);
    writeFileSync(path, files.flatMap((file) => [{ file: `/fixture/${file}`, started: true }, { file: `/fixture/${file}`, done: true, ms: 1 }, { file: `/fixture/${file}`, ended: true, ok: true }])
      .map((line) => JSON.stringify(line)).join('\n') + '\n');
    times.complete(path);
    rmSync(path, { force: true });
  }
  return run;
};
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
  const request = () => ({ cwd, files: ['a.test.js'], gate: { root: join(root, 'state') },
    measurement: { repo: 'repo', run: 'gate-one', session_run: 'session-one', goal_revision: 3, configuration: gateConfiguration({ select: 'selector' }), base, candidate: captureWorktree(cwd) } });
  return { cwd, root, base, request };
}
const receiptOf = (result) => JSON.parse(readFileSync(result.evidence.path, 'utf8'));
const quiet = { write: () => {} };

it('recovery before and after receipt persistence never invents or loses a completed measurement', async (t) => {
  for (const window of ['before', 'after']) {
    const { request } = fixture(t);
    const req = { ...request(), files: null, select: 'selector' };
    const context = { root: req.gate.root, repo: req.measurement.repo,
      repository: req.measurement.candidate.repository, run: req.measurement.run,
      sessionRun: req.measurement.session_run, goalRevision: req.measurement.goal_revision,
      configuration: req.measurement.configuration };
    const options = { ...quiet, select: async () => ({ ok: true, files: ['a.test.js'], commands: [] }),
      tests: reporting({ code: 0, tap: GREEN }) };
    let saved;
    await assert.rejects(runSessionGate(req, { ...options, persist: (args) => {
      if (window === 'after') saved = persistGateReceipt(args);
      throw new Error(`crash ${window} persistence`);
    } }), /crash/u);
    assert.equal(existsSync(join(req.gate.root, 'gate-greens.jsonl')), false);
    const recovered = readGreenReceipt(context);
    if (window === 'before') {
      assert.equal(recovered, null);
      // A fresh attempt has a new run identity; the interrupted one stays absent.
      req.measurement = { ...req.measurement, run: 'gate-restarted' };
      assert.equal(receiptOf(await runSessionGate(req, options)).outcome, 'green');
      assert.equal(readGreenReceipt(context), null);
    } else {
      assert.equal(recovered.outcome, 'green');
      const bytes = readFileSync(saved, 'utf8');
      assert.deepEqual(readGreenReceipt(context), recovered, 'the next session reads the same immutable result');
      assert.equal(persistGateReceipt({ root: context.root, receipt: recovered }), saved);
      assert.equal(readFileSync(saved, 'utf8'), bytes);
      assert.equal(findGreen({ root: context.root, repo: context.repo, tree: recovered.tree,
        selection: selectionHash(recovered.coverage) }), null, 'a crash before caching falls back to measurement');
    }
  }
});

it('a reuse-cache failure leaves a durable discoverable receipt and the completed verdict intact', async (t) => {
  const { request } = fixture(t);
  const req = { ...request(), files: null, select: 'selector' };
  let output = '';
  const result = await runSessionGate(req, {
    write: (line) => { output += line; },
    select: async () => ({ ok: true, files: ['a.test.js'], commands: [] }),
    tests: reporting({ code: 0, tap: GREEN }),
    record: () => { throw new Error('cache unavailable'); },
  });
  assert.equal(result.ok, true);
  assert.equal(receiptOf(result).outcome, 'green');
  assert.match(output, /reuse cache not updated: cache unavailable/u);
});

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
  const hidden = captureWorktree(cwd);
  assert.equal(sameContent(before, hidden), false);
  assert.equal(git(cwd, 'rev-parse', `${hidden.tree}:a.test.js`), git(cwd, 'hash-object', 'a.test.js'), 'the tree holds the bytes, not the flagged entry');
  git(cwd, 'update-index', '--no-assume-unchanged', 'a.test.js');
  git(cwd, 'update-index', '--skip-worktree', 'a.test.js');
  writeFileSync(join(cwd, 'a.test.js'), 'skipped\n');
  assert.equal(git(cwd, 'rev-parse', `${captureWorktree(cwd).tree}:a.test.js`), git(cwd, 'hash-object', 'a.test.js'));
  git(cwd, 'update-index', '--no-skip-worktree', 'a.test.js');
  mkdirSync(join(cwd, 'ignored'));
  writeFileSync(join(cwd, 'ignored/staged'), 'included\n');
  git(cwd, 'add', '-f', 'ignored/staged');
  const staged = captureWorktree(cwd);
  assert.match(git(cwd, 'ls-tree', '-r', staged.tree), /ignored\/staged/u);
});

it('an index seeded from the real stat cache measures the same tree as one rebuilt from HEAD', (t) => {
  const { cwd } = fixture(t);
  writeFileSync(join(cwd, 'b.txt'), 'staged\n');
  git(cwd, 'add', 'b.txt');
  writeFileSync(join(cwd, 'a.test.js'), 'export const x = 1;\n');
  writeFileSync(join(cwd, 'c.txt'), 'untracked\n');
  const seeded = captureWorktree(cwd);
  // A flagged entry forces the HEAD rebuild; the flag hides nothing that matters here.
  git(cwd, 'update-index', '--assume-unchanged', '.gitignore');
  const rebuilt = captureWorktree(cwd);
  git(cwd, 'update-index', '--no-assume-unchanged', '.gitignore');
  assert.equal(seeded.tree, rebuilt.tree);
  assert.equal(seeded.fingerprint, rebuilt.fingerprint);
  // Same size, rewritten after the index was: the stat cache cannot hide it.
  writeFileSync(join(cwd, 'b.txt'), 'STAGED\n');
  assert.equal(git(cwd, 'rev-parse', `${captureWorktree(cwd).tree}:b.txt`), git(cwd, 'hash-object', 'b.txt'));
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'measured');
  assert.equal(git(cwd, 'rev-parse', 'HEAD^{tree}'), captureWorktree(cwd).tree);
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
  const result = await runSessionGate(req, { ...quiet, tests: reporting({ code: 0, tap: GREEN }) });
  const receipt = receiptOf(result);
  assert.equal(receipt.outcome, 'green');
  assert.equal(receipt.gate_version, GATE_MEASUREMENT_VERSION);
  for (const key of ['repo', 'run', 'session_run', 'goal_revision', 'base']) assert.equal(receipt[key], req.measurement[key]);
  assert.equal(receipt.tree, req.measurement.candidate.tree);
  assert.equal(receipt.repository, req.measurement.candidate.repository);
  assert.ok(Date.parse(receipt.ended) >= Date.parse(receipt.started));
  assert.deepEqual(receipt.coverage.files, ['a.test.js']);
  assert.equal(receipt.coverage.kind, 'named');
  assert.equal(persistGateReceipt({ root: req.gate.root, receipt }), result.evidence.path);
  assert.throws(() => persistGateReceipt({ root: req.gate.root, receipt: { ...receipt, tree: 'replacement' } }), /EEXIST/u);
});

it('changes while waiting or testing invalidate the measurement, including generated untracked code', async (t) => {
  for (const when of ['waiting', 'testing']) {
    const { cwd, request } = fixture(t);
    const req = request();
    let calls = 0;
    if (when === 'waiting') writeFileSync(join(cwd, 'a.test.js'), 'changed');
    const result = await runSessionGate(req, { ...quiet, tests: async (args) => {
      calls++;
      writeFileSync(join(cwd, 'generated.js'), 'generated during test');
      return reporting({ code: 0, tap: GREEN })(args);
    } });
    assert.equal(calls, when === 'waiting' ? 0 : 1);
    assert.equal(result.ok, false);
    assert.deepEqual([result.code, result.process_ok, result.complete, result.verdict], [1, false, false, 'red']);
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
    const result = await runSessionGate(req, { ...quiet, tests: reporting(run) });
    assert.equal(result.ok, false);
    assert.notEqual(receiptOf(result).outcome, 'green');
    assert.equal(existsSync(join(req.gate.root, 'gate-greens.jsonl')), false);
  }
  const { request } = fixture(t);
  const req = request();
  let release;
  const pending = runSessionGate(req, { ...quiet, tests: () => new Promise((resolve) => { release = resolve; }) });
  assert.equal(existsSync(join(req.gate.root, 'gate-evidence')), false);
  release({ code: 0, tap: GREEN });
  await pending;
});

it('a concurrent ceiling receipt retains active evidence and cannot be reused as green', async (t) => {
  const { request } = fixture(t);
  const req = { ...request(), files: null, select: 'selector', round_timeout_ms: 20 };
  const result = await runSessionGate(req, { ...quiet,
    select: async () => ({ ok: true, files: ['a.test.js'], commands: [
      { packageScript: 'first' }, { packageScript: 'second' },
    ] }),
    tests: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ code: null, tap: '', aborted: true }), { once: true })),
    shell: (_command, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: null, signal: 'SIGTERM' }), { once: true })),
  });
  const receipt = receiptOf(result);
  assert.equal(result.stopped_at, 'timeout');
  assert.deepEqual([result.code, result.ok, result.process_ok, result.complete, result.verdict], [1, false, false, false, 'red']);
  assert.equal(result.timeout_phase, 'tests, command first');
  assert.deepEqual(result.red_files, ['a.test.js']);
  assert.deepEqual(result.running_commands, ["npm run 'first'"]);
  assert.deepEqual(result.pending_commands, ["npm run 'second'"]);
  assert.deepEqual(receipt.coverage.files, ['a.test.js']);
  assert.equal(receipt.execution.tests.finished, false);
  assert.deepEqual(receipt.execution.commands.map((entry) => entry.state), ['running', 'pending']);
  assert.equal(receipt.outcome, 'red');
  assert.equal(findGreen({ root: req.gate.root, repo: 'repo', tree: receipt.tree, selection: selectionHash(receipt.coverage) }), null);
  assert.equal(findGreenForHead({ root: req.gate.root, repo: 'repo', headTree: receipt.tree }), null);
});

it('an empty selection and an aborted command sequence cannot mint green', async (t) => {
  for (const mode of ['empty', 'interrupted', 'unknown', 'unavailable']) {
    const { request } = fixture(t);
    const req = { ...request(), files: null, select: 'selector' };
    const controller = new AbortController();
    const result = await runSessionGate(req, { ...quiet, signal: controller.signal,
      select: async () => ({ ok: true, files: [], commands: mode === 'empty' ? [] : [{ id: 'check:postgres', packageScript: 'check', unavailableExitCode: 69 }] }),
      shell: async () => {
        if (mode === 'interrupted') controller.abort();
        return { status: mode === 'unknown' ? null : mode === 'unavailable' ? 69 : 0 };
      },
    });
    const receipt = receiptOf(result);
    assert.notEqual(receipt.outcome, 'green');
    if (mode === 'unavailable') {
      assert.deepEqual([result.code, result.process_ok, result.ok, result.complete, result.verdict], [0, true, false, false, 'incomplete']);
      assert.equal(receipt.outcome, 'incomplete');
      assert.deepEqual(result.unavailable_commands, [{ id: 'check:postgres', packageScript: 'check', command: "npm run 'check'", exit: 69 }]);
      assert.deepEqual(receipt.execution.commands[0], { id: 'check:postgres', packageScript: 'check', command: "npm run 'check'",
        exit: 69, ok: false, state: 'unavailable', unavailable: true });
      assert.equal(existsSync(join(req.gate.root, 'gate-greens.jsonl')), false);
      assert.equal(findGreen({ root: req.gate.root, repo: 'repo', tree: receipt.tree, selection: selectionHash(receipt.coverage) }), null);
      assert.equal(findGreenForHead({ root: req.gate.root, repo: 'repo', headTree: receipt.tree }), null);
    }
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
      tests: reporting({ code: 0, tap: GREEN }), shell: async () => ({ status: 0 }) });
    const receipt = receiptOf(result);
    assert.equal(receipt.outcome, 'green');
    assert.equal(receipt.coverage.pattern, req.pattern);
    assert.equal(receipt.coverage.commands.length, req.files ? 0 : 1);
    assert.equal(receipt.execution.commands.length, req.files ? 0 : 1);
    const cached = findGreen({ root: req.gate.root, repo: 'repo', tree: receipt.tree, selection: selectionHash(selected) });
    assert.equal(Boolean(cached), mode === 'affected');
    assert.equal(Boolean(findGreenForHead({ root: req.gate.root, repo: 'repo', headTree: receipt.tree })), mode === 'affected');
    assert.equal(readdirSync(join(req.gate.root, 'gate-evidence')).filter((name) => name.endsWith('.json')).length, 1);
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
    tests: reporting({ code: 0, tap: GREEN }),
  });
  assert.equal(result.ok, false);
  assert.equal(receiptOf(result).outcome, 'red');
  assert.deepEqual([result.code, result.process_ok, result.complete, result.verdict], [1, false, false, 'red']);
});

async function measured(t, { files = null, pattern = null, flags = [], commands = [] } = {}) {
  const fx = fixture(t);
  const req = { ...fx.request(), files, pattern, flags, select: 'selector' };
  const result = await runSessionGate(req, { ...quiet,
    select: async () => ({ ok: true, files: ['a.test.js'], commands }),
    tests: reporting({ code: 0, tap: GREEN }), shell: async () => ({ status: 0 }),
  });
  const receipt = receiptOf(result);
  const context = { root: req.gate.root, repo: 'repo', repository: receipt.repository, run: req.measurement.run,
    sessionRun: 'session-one', goalRevision: 3, configuration: req.measurement.configuration };
  const lookup = (overrides = {}) => {
    const head = git(fx.cwd, 'rev-parse', 'HEAD');
    return findPublicationReceipt({ ...context, cwd: fx.cwd, head, pushed: head,
      selection: { files: ['a.test.js'], commands, flags, execution: executionIdentity(resolveTestPlan({ flags })) }, ...overrides });
  };
  return { ...fx, req, result, receipt, context, lookup };
}

it('publication accepts the measured uncommitted content after an equal-tree commit and observed push', async (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.cwd, 'new.txt'), 'included before commit');
  rmSync(join(fx.cwd, 'a.test.js'));
  writeFileSync(join(fx.cwd, 'b.test.js'), 'export {};');
  const req = { ...fx.request(), files: null, select: 'selector' };
  const selected = { ok: true, files: ['b.test.js'], commands: [] };
  const result = await runSessionGate(req, { ...quiet, select: async () => selected, tests: reporting({ code: 0, tap: GREEN }) });
  const receipt = receiptOf(result);
  const args = { root: req.gate.root, cwd: fx.cwd, repo: 'repo', run: 'gate-one', sessionRun: 'session-one',
    goalRevision: 3, configuration: req.measurement.configuration, selection: { ...selected, execution: executionIdentity(resolveTestPlan({})) } };
  const old = git(fx.cwd, 'rev-parse', 'HEAD');
  assert.equal(findPublicationReceipt({ ...args, head: old, pushed: old }), null, 'uncommitted content is not published');
  git(fx.cwd, 'add', '-A');
  git(fx.cwd, 'commit', '-qm', 'measured content');
  const head = git(fx.cwd, 'rev-parse', 'HEAD');
  assert.equal(git(fx.cwd, 'rev-parse', 'HEAD^{tree}'), receipt.tree);
  const remote = join(fx.root, 'remote.git');
  git(fx.cwd, 'init', '--bare', '-q', remote);
  git(fx.cwd, 'push', '-q', remote, 'HEAD:refs/heads/feature');
  const pushed = git(fx.cwd, 'ls-remote', remote, 'refs/heads/feature').split(/\s/u)[0];
  assert.equal(findPublicationReceipt({ ...args, head, pushed }).run, receipt.run);
  assert.equal(findPublicationReceipt({ ...args, head, pushed: old }), null);
  assert.equal(findPublicationReceipt({ ...args, head: old, pushed: old }), null, 'a different local HEAD is refused');
});

it('post-gate raw edits, untracked edits, and later changed commits are not the measured publication', async (t) => {
  const fx = await measured(t);
  assert.ok(fx.lookup());
  writeFileSync(join(fx.cwd, 'a.test.js'), 'edited');
  assert.equal(fx.lookup(), null);
  git(fx.cwd, 'add', '.');
  git(fx.cwd, 'commit', '-qm', 'later changed content');
  assert.equal(fx.lookup(), null);
  const clean = await measured(t);
  writeFileSync(join(clean.cwd, 'new.txt'), 'new');
  assert.equal(clean.lookup(), null);
});

it('publication is bound to repo, gate run, session, revision, measurement version and gate configuration', async (t) => {
  const fx = await measured(t);
  assert.ok(fx.lookup());
  for (const override of [{ repo: 'other' }, { run: 'other' }, { sessionRun: 'other' }, { goalRevision: 4 },
    { configuration: gateConfiguration({ select: 'changed' }) }, { configuration: null }]) {
    assert.equal(fx.lookup(override), null, JSON.stringify(override));
  }
  const other = fixture(t);
  assert.equal(fx.lookup({ cwd: other.cwd, head: git(other.cwd, 'rev-parse', 'HEAD'), pushed: git(other.cwd, 'rev-parse', 'HEAD') }), null);
  writeFileSync(fx.result.evidence.path, JSON.stringify({ ...fx.receipt, gate_version: GATE_MEASUREMENT_VERSION - 1 }));
  assert.equal(fx.lookup(), null);
  rmSync(fx.result.evidence.path);
  assert.equal(fx.lookup(), null);
});

it('publication requires the final full selection, including invocation semantics, not named or filtered coverage', async (t) => {
  for (const limited of [{ files: ['a.test.js'] }, { pattern: 'works' }, { flags: ['--test-only'] }]) {
    const fx = await measured(t, limited);
    assert.equal(fx.receipt.outcome, 'green');
    assert.equal(fx.lookup(), null);
  }
  const commands = [{ packageScript: 'lint', passBaseRef: true }];
  const fx = await measured(t, { commands });
  assert.ok(fx.lookup());
  for (const selection of [
    { files: ['a.test.js', 'new.test.js'], commands },
    { files: ['a.test.js'], commands: [] },
    { files: ['a.test.js'], commands: [{ packageScript: 'lint', passBaseRef: false }] },
    { files: ['a.test.js'], commands, flags: ['--import', './other.mjs'] },
  ]) assert.equal(fx.lookup({ selection }), null);
});

it('strict cache lookup reads durable full receipts and never accepts a legacy or missing receipt claim', async (t) => {
  const fx = await measured(t);
  const args = { root: fx.context.root, repo: 'repo', tree: fx.receipt.tree, selection: selectionHash(fx.receipt.coverage),
    checks: fx.receipt.coverage, evidence: fx.context };
  assert.ok(findGreen(args));
  assert.ok(findGreenForHead({ ...args, headTree: fx.receipt.tree }));
  assert.equal(findGreen({ ...args, evidence: { ...fx.context, run: 'other' } }), null);
  rmSync(fx.result.evidence.path);
  assert.equal(findGreen(args), null);
  assert.equal(findGreenForHead({ ...args, headTree: fx.receipt.tree }), null);
});

/**
 * The words of a command line as `sh` would split it, for the single quotes
 * `selectorCommand` and `deltaFromGreen` write.
 */
function words(line) {
  const out = [];
  let word = null;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) { if (char === "'") quoted = false; else word += char; continue; }
    if (char === "'") { quoted = true; word ??= ''; continue; }
    if (char === '\\') { i += 1; word = (word ?? '') + (line[i] ?? ''); continue; }
    if (/\s/u.test(char)) { if (word !== null) out.push(word); word = null; continue; }
    word = (word ?? '') + char;
  }
  if (word !== null) out.push(word);
  return out;
}

/**
 * The repository's selector run in this process, on the fixture it stands in;
 * any other command line through the shell. Nine selector processes, each
 * starting git through the model's own node, took 5.9 s (2026-11-03).
 * affected-tests.test.js runs the script as a process.
 */
const SELECTOR = 'node scripts/affected-tests.js';
const inProcess = async (command, options) => {
  if (!command.startsWith(`${SELECTOR} `)) return runShell(command, options);
  let stdout = '';
  try {
    const status = selectorMain(words(command).slice(2), { root: options.cwd, stdout: { write: (text) => { stdout += text; } } });
    return { status, signal: null, stdout, stderr: '', error: null };
  } catch (error) {
    return { status: 1, signal: null, stdout, stderr: error.message, error: null };
  }
};

it('real repository delta selection follows transitive dependencies, not just changed-file overlap', async (t) => {
  for (const mainPath of ['src/unrelated.js', 'src/shared.js', 'package.json']) {
    const fx = fixture(t);
    mkdirSync(join(fx.cwd, 'src'));
    mkdirSync(join(fx.cwd, 'scripts'));
    writeFileSync(join(fx.cwd, 'package.json'), '{"type":"module"}');
    writeFileSync(join(fx.cwd, 'scripts/affected-tests.js'), readFileSync(new URL('../../scripts/affected-tests.js', import.meta.url)));
    writeFileSync(join(fx.cwd, 'src/shared.js'), 'export const value = 1;');
    writeFileSync(join(fx.cwd, 'src/unrelated.js'), 'export const other = 1;');
    writeFileSync(join(fx.cwd, 'src/wrapper.js'), "export { value } from './shared.js';\n");
    writeFileSync(join(fx.cwd, 'a.test.js'), "import { value } from './src/wrapper.js';\n");
    writeFileSync(join(fx.cwd, 'b.test.js'), "import { other } from './src/unrelated.js';\n");
    git(fx.cwd, 'add', '.');
    git(fx.cwd, 'commit', '-qm', 'dependency graph');
    git(fx.cwd, 'branch', '-M', 'main');
    const base = git(fx.cwd, 'rev-parse', 'HEAD');
    git(fx.cwd, 'switch', '-qc', 'feature');
    writeFileSync(join(fx.cwd, 'src/wrapper.js'), "export { value } from './shared.js';\n// feature\n");
    const command = 'node scripts/affected-tests.js';
    const configuration = gateConfiguration({ select: command });
    const req = { ...fx.request(), files: null, select: selectorCommand(command, { base }),
      measurement: { ...fx.request().measurement, base, configuration } };
    const result = await runSessionGate(req, { ...quiet, select: (options) => selectFiles({ ...options, run: inProcess }), tests: reporting({ code: 0, tap: GREEN }) });
    const receipt = receiptOf(result);
    assert.deepEqual(receipt.coverage.files, ['a.test.js']);
    git(fx.cwd, 'add', '.');
    git(fx.cwd, 'commit', '-qm', 'feature');
    const headSha = git(fx.cwd, 'rev-parse', 'HEAD');
    git(fx.cwd, 'switch', '-q', 'main');
    writeFileSync(join(fx.cwd, mainPath), readFileSync(join(fx.cwd, mainPath), 'utf8') + '\n');
    git(fx.cwd, 'add', '.');
    git(fx.cwd, 'commit', '-qm', 'main moved');
    const baseCommit = git(fx.cwd, 'rev-parse', 'HEAD');
    git(fx.cwd, 'switch', '-q', 'feature');
    git(fx.cwd, 'merge', '--no-edit', '-q', 'main');
    const selection = await selectFiles({ cwd: fx.cwd, command: selectorCommand(command, { base: baseCommit }), env: process.env, say: () => {}, run: inProcess });
    const evidence = { repository: receipt.repository, run: receipt.run, sessionRun: 'session-one', goalRevision: 3, configuration };
    const args = { git: (args, { cwd }) => spawnSync('git', args, { cwd, encoding: 'utf8' }), cwd: fx.cwd,
      root: req.gate.root, repo: 'repo', headSha, baseCommit, command, env: process.env, selection, evidence, run: inProcess };
    const delta = await deltaFromGreen(args);
    assert.equal(delta.kind, 'reuse');
    assert.deepEqual(delta.paths, [mainPath]);
    assert.deepEqual(delta.files, mainPath === 'src/unrelated.js' ? [] : ['a.test.js']);
    assert.equal((await deltaFromGreen({ ...args, evidence: { ...evidence, configuration: 'changed' } })).kind, 'none');
    assert.equal((await deltaFromGreen({ ...args, command: 'false' })).kind, 'fallback');
    assert.equal((await deltaFromGreen({ ...args, command: `printf '%s' '{"files":[],"commands":[{}]}'` })).kind, 'fallback');
    rmSync(result.evidence.path);
    assert.equal((await deltaFromGreen(args)).kind, 'none');
  }
});

it('strict delta measures a changed command invocation even when main has no delta paths', async (t) => {
  const fx = await measured(t, { commands: [{ packageScript: 'lint', passBaseRef: true }] });
  const args = { git: (args, { cwd }) => spawnSync('git', args, { cwd, encoding: 'utf8' }), cwd: fx.cwd,
    root: fx.context.root, repo: 'repo', headSha: fx.base, baseCommit: fx.base, command: 'unused', env: process.env,
    evidence: fx.context, selection: { files: ['a.test.js'], commands: [{ packageScript: 'lint', passBaseRef: false }] } };
  const delta = await deltaFromGreen(args);
  assert.equal(delta.kind, 'reuse');
  assert.deepEqual(delta.files, []);
  assert.deepEqual(delta.commands, args.selection.commands);
  assert.equal((await deltaFromGreen({ ...args, evidence: { ...fx.context, repository: '/other/repo/.git' } })).kind, 'none');
});

it('corrupt or incomplete durable evidence never authorizes reuse or publication', async (t) => {
  const fx = await measured(t);
  const args = { root: fx.context.root, repo: 'repo', tree: fx.receipt.tree,
    selection: selectionHash(fx.receipt.coverage), checks: fx.receipt.coverage, evidence: fx.context };
  for (const corrupt of ['{', 'null', JSON.stringify({ ...fx.receipt, exit: null }),
    JSON.stringify({ ...fx.receipt, execution: { tests: null, commands: [] } }),
    JSON.stringify({ ...fx.receipt, coverage: { ...fx.receipt.coverage, commands: [null] } }),
    JSON.stringify({ ...fx.receipt, outcome: 'incomplete' })]) {
    writeFileSync(fx.result.evidence.path, corrupt);
    assert.equal(fx.lookup(), null);
    assert.equal(findGreen(args), null);
    assert.equal(findGreenForHead({ ...args, headTree: fx.receipt.tree }), null);
  }
});

it('a resumed full green is recorded for the merger and accepted for publication like a single-run green', async (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.cwd, 'b.test.js'), 'export {};\n');
  git(fx.cwd, 'add', '.');
  git(fx.cwd, 'commit', '-qm', 'two tests');
  const selected = { ok: true, files: ['a.test.js', 'b.test.js'], commands: [] };
  const attempt = (run, outcome) => {
    const req = { ...fx.request(), files: null, select: 'selector' };
    req.measurement = { ...req.measurement, run };
    return runSessionGate(req, { ...quiet, select: async () => selected, tests: async ({ files, times, plan }) => {
      const path = join(fx.root, `${run}.jsonl`);
      times.track(path);
      writeFileSync(path, files.flatMap((file) => [{ file: `/fixture/${file}`, started: true },
        { file: `/fixture/${file}`, test: { name: 'x', line: 1, ms: 1, ...(file === 'b.test.js' && outcome === 'red' ? { failed: true } : {}) } },
        { file: `/fixture/${file}`, done: true, ms: 1 },
        { file: `/fixture/${file}`, ended: true, ok: !(file === 'b.test.js' && outcome === 'red') }]).map((line) => JSON.stringify(line)).join('\n') + '\n');
      times.complete(path);
      return outcome === 'red' ? { code: 1, tap: 'not ok 1 - x\n1..1\n# tests 1\n# pass 0\n# fail 1\n' } : { code: 0, tap: GREEN };
    } });
  };
  const red = receiptOf(await attempt('gate-red', 'red'));
  assert.equal(red.outcome, 'red');
  const resumed = await attempt('gate-resumed', 'green');
  const receipt = receiptOf(resumed);
  assert.equal(receipt.outcome, 'green');
  assert.deepEqual(receipt.members.files.map(({ file, how, from }) => [file, how, from]),
    [['a.test.js', 'reused', 'gate-red'], ['b.test.js', 'ran', null]]);
  const context = { repository: receipt.repository, run: 'gate-resumed', sessionRun: 'session-one', goalRevision: 3,
    configuration: receipt.configuration };
  const root = join(fx.root, 'state');
  const cached = findGreen({ root, repo: 'repo', tree: receipt.tree, selection: selectionHash(selected), evidence: context, checks: receipt.coverage });
  assert.equal(cached?.receipt, resumed.evidence.path, 'recordReceiptGreen recorded the resumed green');
  const head = git(fx.cwd, 'rev-parse', 'HEAD');
  assert.equal(findPublicationReceipt({ ...context, root, cwd: fx.cwd, repo: 'repo', head, pushed: head,
    selection: { files: selected.files, commands: [], execution: executionIdentity(resolveTestPlan({})) } })?.run, 'gate-resumed');
});

it('a reused member that did not pass, or names no source, never makes a receipt green', (t) => {
  const { request } = fixture(t);
  const measurement = request().measurement;
  const coverage = { kind: 'affected', files: ['a.test.js'], commands: [], flags: [], pattern: null, selector: 'selector', execution: executionIdentity(resolveTestPlan({})) };
  const make = (member) => gateReceipt({ measurement, before: measurement.candidate, after: measurement.candidate,
    started: '2026-01-01T00:00:00Z', ended: '2026-01-01T00:00:01Z',
    result: { ok: true, code: 0, coverage, execution: { tests: null, commands: [] }, members: { files: [member], commands: [] } } });
  assert.equal(make({ file: 'a.test.js', how: 'reused', from: 'gate-zero', outcome: 'passed' }).outcome, 'green');
  for (const member of [{ file: 'a.test.js', how: 'reused', from: 'gate-zero', outcome: 'failed' },
    { file: 'a.test.js', how: 'reused', from: null, outcome: 'passed' },
    { file: 'a.test.js', how: 'ran', from: null, outcome: 'passed' }]) {
    assert.equal(make(member).outcome, 'incomplete', JSON.stringify(member));
  }
});

it('receipt: a green measured under the pre-contract measurement version 4 is never read as bound evidence', (t) => {
  const { request } = fixture(t);
  const req = { ...request(), files: ['a.test.js'], select: undefined };
  const root = req.gate.root;
  // A complete, valid green under the current version is read back for its own run and configuration.
  const path = persistGateReceipt({ root, receipt: gateReceipt({ measurement: req.measurement, before: req.measurement.candidate, after: req.measurement.candidate,
    started: '2026-01-01T00:00:00Z', ended: '2026-01-01T00:00:01Z',
    result: { ok: true, code: 0, coverage: { kind: 'named', files: ['a.test.js'], commands: [], flags: [], pattern: null, execution: executionIdentity(resolveTestPlan({})) },
      execution: { tests: { exit: 0, finished: true, totals: { tests: 1, pass: 1, fail: 0 }, batches: [spawnedBatch({ files: ['a.test.js'] })] }, commands: [] },
      members: { files: [{ file: 'a.test.js', how: 'ran', from: null, outcome: 'passed' }], commands: [] } } }) });
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  const read = (over = {}) => readGreenReceipt({ root, repo: 'repo', repository: receipt.repository, run: receipt.run, sessionRun: receipt.session_run,
    goalRevision: receipt.goal_revision, configuration: receipt.configuration, ...over });
  assert.equal(read()?.run, receipt.run, 'the current measurement is read');
  // The same receipt written as the pre-contract version: a green that did not bind its executed timeout is never read.
  writeFileSync(path, JSON.stringify({ ...receipt, gate_version: 4 }));
  assert.equal(read(), null, 'version 4 is refused');
});

it('receipt: a timeout the batch was not launched with, a missing batch, a changed Node or a missing identity never mint green', (t) => {
  const { request } = fixture(t);
  const measurement = request().measurement;
  // The requested policy: 1000 ms, declared; the identity the measurement was planned with.
  const plan = resolveTestPlan({ flags: ['--import', './x.mjs', '--test-timeout=1000'] });
  const identity = executionIdentity(plan);
  const flags = ['--import', './x.mjs', '--test-timeout=1000'];
  const coverage = (files, extra = {}) => ({ kind: 'affected', files, commands: [], flags, pattern: null, selector: 'selector', execution: identity, ...extra });
  const launch = (files, over = {}) => ({ ...spawnedBatch({ plan, files }), ...over });
  const members = (files) => ({ files: files.map((file) => ({ file, how: 'ran', from: null, outcome: 'passed' })), commands: [] });
  const outcome = (cover, batches, files = ['a.test.js']) => gateReceipt({ measurement, before: measurement.candidate, after: measurement.candidate,
    started: '2026-01-01T00:00:00Z', ended: '2026-01-01T00:00:01Z',
    result: { ok: true, code: 0, coverage: cover, execution: { tests: { exit: 0, finished: true, totals: { tests: 1, pass: 1, fail: 0 }, batches }, commands: [] }, members: members(files) } }).outcome;

  assert.equal(outcome(coverage(['a.test.js']), [launch(['a.test.js'])]), 'green', 'the consistent launch is green');
  // Requested 1000, executed 600000: the spawn boundary dropped the declared timeout and Node was given the default.
  const dropped = launch(['a.test.js'], { argv: launch(['a.test.js']).argv.map((word) => (word === '--test-timeout=1000' ? '--test-timeout=600000' : word)) });
  dropped.timeoutMs = executedTimeoutOf(dropped.argv);
  assert.equal(dropped.timeoutMs, 600000);
  assert.equal(outcome(coverage(['a.test.js']), [dropped]), 'incomplete', 'requested 1000, executed 600000');
  // A batch argv that does not carry the loader before its file paths.
  assert.equal(outcome(coverage(['a.test.js']), [launch(['a.test.js'], { argv: launch(['a.test.js']).argv.filter((word) => word !== './x.mjs') })]), 'incomplete', 'loader missing');
  // No execution identity at all, or one whose timeout the requested flags do not state.
  assert.equal(outcome({ ...coverage(['a.test.js']), execution: undefined }, [launch(['a.test.js'])]), 'incomplete', 'missing identity');
  assert.equal(outcome(coverage(['a.test.js'], { execution: { ...identity, timeoutSource: 'default' } }), [launch(['a.test.js'])]), 'incomplete', 'identity says default, flags state 1000');
  // A changed Node: the batch was spawned by another version than the one the identity names.
  assert.equal(outcome(coverage(['a.test.js']), [launch(['a.test.js'], { nodeVersion: 'v0.0.1' })]), 'incomplete', 'changed Node');
  // A missing batch: one of the two files ran in no launch.
  assert.equal(outcome(coverage(['a.test.js', 'b.test.js']), [launch(['a.test.js'])], ['a.test.js', 'b.test.js']), 'incomplete', 'missing batch');
  // A launch of a file the attempt did not select.
  assert.equal(outcome(coverage(['a.test.js']), [launch(['a.test.js']), launch(['z.test.js'])]), 'incomplete', 'unselected file launched');
  // Nothing ran: commands only, and no test batch is required of it.
  const commandsOnly = gateReceipt({ measurement, before: measurement.candidate, after: measurement.candidate,
    started: '2026-01-01T00:00:00Z', ended: '2026-01-01T00:00:01Z',
    result: { ok: true, code: 0, coverage: { kind: 'affected', files: [], commands: [{ packageScript: 'lint' }], flags, pattern: null, selector: 'selector', execution: identity },
      execution: { tests: null, commands: [{ packageScript: 'lint', exit: 0, ok: true, state: 'completed' }] }, members: { files: [], commands: [] } } });
  assert.equal(commandsOnly.outcome, 'green', 'commands only need no batch');
  assert.equal(commandsOnly.coverage.execution.timeoutMs, 1000);
});
