import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerMainMend, mainMendPrompt, publishMainMend, readMainMends, requestMainRepair, shapeMainRedTest, updateMainMends } from '../../src/mc/main-repair.js';
import { readRelease, releaseBranch, writeRelease } from '../../src/mc/deploy-release.js';
import { repairReleaseRun } from '../../src/mc/nightly-loop.js';
import { mainRedPath } from '../../src/mc/selector-miss.js';
import { redTests } from '../../src/mc/tap-red.js';

function stateWith(entries = []) {
  let state = structuredClone(entries);
  return {
    root: '/fixture/home', repo: 'memoro-cli',
    read: () => ({ version: 1, entries: state }),
    write: (_path, value) => { state = structuredClone(value.entries); },
    lock: (_root, fn) => fn(),
    entries: () => structuredClone(state),
  };
}

const landed = (extra = {}) => ({ id: 'prior-id', file: 'tests/red.test.js', state: 'landed', pr: 1539,
  base: 'measured-base', landed_commit: 'repair-commit', ...extra });

it('queues the exact red release head and keeps cut and later reds claimed through landing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-release-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = { name: 'memoro', path: join(root, 'memoro.git') };
  const cut = 'abcdef1234567';
  const head = 'bcdefa1234567';
  const fixed = 'cdefab1234567';
  const at = '2026-11-23T06:30:00.000Z';
  const branch = releaseBranch(cut);
  const cutRed = 'tests/cut-red.test.js';
  const laterRed = 'tests/later-red.test.js';
  const newRed = 'tests/main-only.test.js';
  const cutRun = { commit: cut, red: [cutRed] };
  writeRelease(root, { branch, cut: { sha: cut, at }, row: { started: at, sha: cut }, head: cut, state: 'red',
    reds: [cutRed], claimed_reds: [cutRed], repairs: [], cut_run: cutRun });
  const read = () => readRelease(root);
  const state = { root, repo: repo.name };
  const rows = () => readMainMends(state);
  const mainRed = (files) => requestMainRepair({ ...state, base: 'main-head', files });
  const publish = (id, pr) => {
    const repairBranch = `mend/main-memoro-${pr}`;
    updateMainMends(state, (entries) => Object.assign(entries.find((entry) => entry.id === id), { branch: repairBranch, state: 'running' }));
    publishMainMend({ ...state, branch: repairBranch, pr });
  };

  const first = repairReleaseRun(repo, read(), cutRun, { root, historyRoot: root });
  assert.deepEqual(rows().map(({ id, base, file, release_branch }) => [id, base, file, release_branch]), [[first.created[0], cut, cutRed, branch]]);
  publish(first.created[0], 10);
  answerMainMend({ ...state, pr: 10, landed: true, commit: head, baseBranch: branch });
  assert.equal(read().head, head);
  assert.deepEqual(read().repairs, [10]);
  assert.equal(repairReleaseRun(repo, read(), cutRun, { root, historyRoot: root }), null, 'a stale run cannot queue another mend');

  const later = repairReleaseRun(repo, read(), { commit: head, red: [laterRed] }, { root, historyRoot: root });
  assert.deepEqual(rows().map(({ base, file, release_branch }) => [base, file, release_branch]), [[cut, cutRed, branch], [head, laterRed, branch]]);
  assert.deepEqual(read().claimed_reds, [cutRed, laterRed]);
  assert.match(mainRed([cutRed, laterRed]).skipped, /all reds are claimed/u);
  assert.equal(rows().length, 2);

  publish(later.created[0], 11);
  answerMainMend({ ...state, pr: 11, landed: true, commit: fixed, baseBranch: branch });
  assert.deepEqual(rows().map(({ state, landed_commit }) => [state, landed_commit]), [['landed', head], ['landed', fixed]]);
  assert.match(mainRed([cutRed, laterRed]).skipped, /all reds are claimed/u);
  assert.equal(rows().length, 2, 'landing does not release the claims');
  const mixed = mainRed([laterRed, newRed]);
  assert.deepEqual(rows().filter((row) => !row.release_branch).map(({ id, file }) => [id, file]),
    [[mixed.created[0], laterRed], [mixed.created[1], newRed]]);
  writeRelease(root, { ...read(), closed: 'merged' });
  const after = mainRed([cutRed]);
  assert.deepEqual(rows().filter((row) => after.created.includes(row.id)).map((row) => row.file), [cutRed]);
});

describe('main-red repair evidence', () => {
  for (const [label, contains, extra] of [
    ['false', () => false, {}],
    ['true', () => true, {}],
    ['null', () => null, {}],
    ['absent', undefined, {}],
    ['no landed_commit', () => false, { landed_commit: undefined }],
  ]) {
    it(`stale report ${label} ancestry handling`, () => {
      const state = stateWith([landed(extra)]);
      const result = requestMainRepair({ ...state, base: 'reported-base', files: ['tests/red.test.js'],
        ...(contains ? { contains } : {}) });
      if (label === 'false') {
        assert.deepEqual(result.stale, ['prior-id']);
        assert.equal(result.created.length, 0);
        assert.equal(state.entries().length, 1);
      } else {
        assert.equal(result.created.length, 1);
        assert.equal(state.entries().length, 2);
      }
    });
  }

  it('stale report check member is unaffected by ancestry', () => {
    const state = stateWith([]);
    const result = requestMainRepair({ ...state, base: 'reported-base', files: [],
      checks: [{ key: 'check:part@started', part: 'part', started: 'started' }], contains: () => false });
    assert.equal(result.created.length, 1);
    assert.equal(state.entries()[0].file, 'check:part@started');
  });

  it('a red gate suite is a member of its own, deduplicated by its name while unfinished, and the prompt gives its verdict and whole output', () => {
    const state = stateWith([]);
    const suite = { name: 'msr-performance', exit: 1, verdict: ['mobile-constrained: long task 60 ms, bound 50 ms'], output_path: '/runner/deploy-prepare/2026-11-15T19-18/msr-performance.log', sha: 'abcdef1234567' };
    const first = requestMainRepair({ ...state, base: 'reported-base', files: [], suites: [suite] });
    assert.equal(first.created.length, 1);
    assert.deepEqual(state.entries()[0].suite, suite);
    assert.equal(state.entries()[0].file, 'suite:msr-performance');
    assert.equal(state.entries()[0].state, 'queued');

    const again = requestMainRepair({ ...state, base: 'reported-base', files: [], suites: [{ ...suite, exit: 2 }, { name: 'journeys', exit: 1, verdict: [], output_path: null, sha: 'abcdef1234567' }] });
    assert.deepEqual(again.open, [first.created[0]], 'the same suite joins the open member');
    assert.equal(again.created.length, 1, 'another suite is a member of its own');
    assert.deepEqual(state.entries().map((entry) => entry.file), ['suite:msr-performance', 'suite:journeys']);

    const prompt = mainMendPrompt({ repo: 'memoro', branch: 'mend/main', worktree: '/work', root: '/fixture/home', entries: state.entries() });
    assert.match(prompt, /the gate suite msr-performance was red \(exit 1\) at abcdef1/u);
    assert.match(prompt, /mobile-constrained: long task 60 ms, bound 50 ms/u);
    assert.match(prompt, /Whole output: \/runner\/deploy-prepare\/2026-11-15T19-18\/msr-performance\.log/u);
    assert.match(prompt, /the gate suite journeys was red[^\n]*\nIt stated no verdict\./u);
    assert.doesNotMatch(prompt, /mc gate --fresh suite:/u, 'a suite is not a test file to run by name');
  });

  it('landed commit is stored on every entry for the pull request', () => {
    const state = stateWith([
      { id: 'one', file: 'a.test.js', pr: 71, state: 'published' },
      { id: 'two', file: 'b.test.js', pr: 71, state: 'running' },
      { id: 'other', file: 'c.test.js', pr: 72, state: 'published' },
    ]);
    answerMainMend({ ...state, pr: 71, landed: true, commit: 'merge-sha' });
    assert.deepEqual(state.entries().map(entry => [entry.id, entry.state, entry.landed_commit]), [
      ['one', 'landed', 'merge-sha'], ['two', 'landed', 'merge-sha'], ['other', 'published', undefined],
    ]);
  });

  it('mend prompt carries the measured evidence, retained-record state and earlier finished repairs', () => {
    const recordPath = mainRedPath('/fixture/home', 'memoro-cli', 'reported-base');
    const file = 'tests/red.test.js';
    const frames = ['async TestContext.<anonymous> (file:///repo/tests/red.test.js:23:4)',
      'Test.run (node:internal/test_runner/test:1106:25)'];
    const tap = ['TAP version 13', '# Subtest: assertion', 'not ok 1 - assertion', '  ---', "  type: 'test'",
      "  location: '/repo/tests/red.test.js:3:1'", "  failureType: 'testCodeFailure'", '  error: |-',
      '    Assertion failed', '    detail line', '  stack: |-', ...frames.map(frame => `    ${frame}`),
      '  ...', '1..1', '# tests 1', '# pass 0', '# fail 1'].join('\n');
    const [parsed] = redTests(tap, [file], { cwd: '/repo' });
    const test = shapeMainRedTest(parsed);
    assert.deepEqual(test.stack, frames);
    assert.deepEqual(test.detail, ['Assertion failed', 'detail line', ...frames.map(frame => `  ${frame}`)]);
    const prompt = mainMendPrompt({ repo: 'memoro-cli', branch: 'mend/main', worktree: '/work', root: '/fixture/home',
      entries: [{ file, base: 'reported-base', tests: [test] }],
      history: [landed()], exists: (path) => path === recordPath });
    assert.match(prompt, /assertion/u);
    assert.match(prompt, /tests\/red\.test\.js:23:4/u);
    assert.match(prompt, /Assertion failed/u);
    assert.match(prompt, /detail line/u);
    assert.deepEqual(prompt.split('\n').filter(line => frames.includes(line.trim())),
      frames.map(frame => `      ${frame}`), 'stack frames in detail keep their formatting and are not printed twice');
    assert.match(prompt, new RegExp(recordPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(prompt, /Earlier tests\/red\.test\.js: state landed; PR #1539; landed_commit repair-commit/u);
    assert.match(prompt, /Read where each assertion failed/u);

    const absent = mainMendPrompt({ repo: 'memoro-cli', branch: 'mend/main', worktree: '/work', root: '/fixture/home',
      entries: [{ file: 'tests/red.test.js', base: 'reported-base', tests: [{ file: 'tests/red.test.js', name: 'legacy', error: ['old error'] }] }],
      exists: () => false });
    assert.match(absent, /No retained main-red record/u);
    assert.match(absent, /legacy[\s\S]*old error/u);
  });

  it('shapes a red test to the bounded entry evidence', () => {
    const shaped = shapeMainRedTest({ file: 'tests/red.test.js', name: 'red', at: 'tests/red.test.js:1:2', error: Array.from({ length: 20 }, (_, i) => `e${i}`),
      detail: Array.from({ length: 60 }, (_, i) => `d${i}`), stack: Array.from({ length: 30 }, (_, i) => `frame${i}`) });
    assert.equal(shaped.error.length, 12);
    assert.equal(shaped.detail.length, 40);
    assert.equal(shaped.stack.length, 20);
    assert.equal(shapeMainRedTest({ file: 'f', name: 'legacy', error: ['old'] }).at, undefined);
  });

  it('mend prompt retains a Node TAP frame behind a long assertion diff', () => {
    const file = 'tests/long.test.js';
    const frame = 'async TestContext.<anonymous> (file:///repo/tests/long.test.js:99:5)';
    const tap = ['TAP version 13', '# Subtest: long assertion', 'not ok 1 - long assertion', '  ---', "  type: 'test'",
      "  location: '/repo/tests/long.test.js:3:1'", "  failureType: 'testCodeFailure'", '  error: |-',
      ...Array.from({ length: 60 }, (_, i) => `    diff ${i}`), '  stack: |-', `    ${frame}`, '  ...', '1..1', '# tests 1', '# pass 0', '# fail 1'].join('\n');
    const [parsed] = redTests(tap, [file], { cwd: '/repo' });
    const prompt = mainMendPrompt({ repo: 'memoro-cli', branch: 'mend/main', worktree: '/work', root: '/fixture/home',
      entries: [{ file, base: 'reported-base', tests: [shapeMainRedTest(parsed)] }], exists: () => false });
    assert.match(prompt, /tests\/long\.test\.js:99:5/u);
    assert.match(prompt, /async TestContext\.<anonymous> \(file:\/\/\/repo\/tests\/long\.test\.js:99:5\)/u);
  });
});
