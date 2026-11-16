import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { answerMainMend, mainMendPrompt, requestMainRepair, shapeMainRedTest } from '../../src/mc/main-repair.js';
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
    const prompt = mainMendPrompt({ repo: 'memoro-cli', branch: 'mend/main', worktree: '/work', root: '/fixture/home',
      entries: [{ file: 'tests/red.test.js', base: 'reported-base', tests: [{ name: 'assertion', at: 'tests/red.test.js:23:4',
        error: ['Assertion failed'], detail: ['detail line', 'frame line'], stack: ['frame line', 'node frame'] }] }],
      history: [landed()], exists: (path) => path === recordPath });
    assert.match(prompt, /assertion/u);
    assert.match(prompt, /tests\/red\.test\.js:23:4/u);
    assert.match(prompt, /Assertion failed/u);
    assert.match(prompt, /detail line/u);
    assert.match(prompt, /node frame/u);
    assert.equal(prompt.split('\n').filter((line) => line === '    frame line').length, 1, 'stack frames already in detail are not printed twice');
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
