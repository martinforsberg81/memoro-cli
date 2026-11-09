/**
 * Reading a suite run's failures — the two mistakes that make a gate lie.
 *
 * Counting instead of naming: "3 red" is not something anybody can act on, and
 * a verdict that carried a number while the names were thrown away is what
 * this exists to stop. Reading only the top level: a file's suites and tests
 * each get a TAP line, so a red test inside a green-looking file is invisible
 * unless every level is read. Both are asserted here against TAP shaped the
 * way node's own reporter shapes it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cancelledFiles, killedFiles, redNames, redNamesIn, redTests, tapTotals } from '../../src/mc/tap-red.js';

/** TAP the shape node emits it: `# Subtest:` announcements, four-space nesting. */
function tap({ suites = [], totals = { tests: 0, pass: 0, fail: 0 } } = {}) {
  const lines = ['TAP version 13'];
  let counter = 0;
  for (const suite of suites) {
    lines.push(`# Subtest: ${suite.name}`);
    let inner = 0;
    for (const test of suite.tests || []) {
      inner += 1;
      lines.push(`    # Subtest: ${test.name}`);
      lines.push(`    ${test.red ? 'not ok' : 'ok'} ${inner} - ${test.name}${test.directive ? ` # ${test.directive}` : ''}`);
      lines.push('      ---', '      duration_ms: 1', '      ...');
    }
    counter += 1;
    const red = (suite.tests || []).some((test) => test.red && !test.directive);
    lines.push(`${red ? 'not ok' : 'ok'} ${counter} - ${suite.name}`);
  }
  lines.push(`1..${counter}`);
  for (const [key, value] of Object.entries(totals)) lines.push(`# ${key} ${value}`);
  return lines.join('\n');
}

describe('the red set of a suite run', () => {
  it('names every level, not only the top one', () => {
    const run = tap({
      suites: [{
        name: 'the lease',
        tests: [
          { name: 'is taken by the area that asks', red: true },
          { name: 'never restarts its own clock' },
        ],
      }],
      totals: { tests: 3, pass: 1, fail: 2 },
    });

    // The suite is red because its test is, and both are named — a change that
    // swaps which test inside a suite fails is invisible at the top level.
    assert.deepEqual(redNames(run), [
      'the lease › is taken by the area that asks',
      'the lease',
    ]);
  });

  it('a name carries the suites it sits under', () => {
    // Two suites can each have a test called "reports what it kept". Compared
    // as bare names they are one entry, and a gate would see a test move from
    // one suite to another as no change at all.
    const run = tap({
      suites: [
        { name: 'release', tests: [{ name: 'reports what it kept', red: true }] },
        { name: 'discard', tests: [{ name: 'reports what it kept' }] },
      ],
    });
    assert.deepEqual(redNames(run), ['release › reports what it kept', 'release']);
  });

  it('a test that announced it would fail is not a regression', () => {
    // `# TODO` is a test saying so in advance, and `# SKIP` never ran. Neither
    // is something a pull request broke, so neither may stop a merge.
    const run = tap({
      suites: [{
        name: 'planned work',
        tests: [
          { name: 'the unwritten half', red: true, directive: 'TODO' },
          { name: 'needs a network', red: true, directive: 'SKIP' },
        ],
      }],
    });
    assert.deepEqual(redNames(run), []);
  });

  it('reads the totals the run printed, and knows when there are none', () => {
    const finished = tap({ suites: [{ name: 'a', tests: [{ name: 'b' }] }], totals: { tests: 2, pass: 2, fail: 0 } });
    assert.deepEqual(tapTotals(finished), {
      tests: 2, pass: 2, fail: 0, cancelled: null, runs: 1, finished: true,
    });

    // A run that died before its summary. The distinction is the whole reason
    // this exists: an empty red set from a run that never ran looks exactly
    // like a clean sweep.
    const died = 'TAP version 13\n# Subtest: a\nnot ok 1 - a\n';
    assert.equal(tapTotals(died).finished, false);
  });

  it('sums a suite that ran in several processes, instead of keeping the last', () => {
    // memoro's runner spawns one `node --test` per resource class, so one
    // `npm test` prints three summaries. Measured on 2026-08-30, round
    // #11104: 2477 + 9 + 39 tests, reported as "39 tests" — the last batch's
    // number standing in for the whole suite, in the round's own output and
    // in the baseline cache it wrote.
    const batched = [
      '# tests 2477', '# pass 2477', '# fail 0',
      '# tests 9', '# pass 9', '# fail 0',
      '# tests 39', '# pass 39', '# fail 0',
    ].join('\n');
    const totals = tapTotals(batched);
    assert.equal(totals.tests, 2525);
    assert.equal(totals.pass, 2525);
    assert.equal(totals.fail, 0);
    assert.equal(totals.runs, 3);
    assert.equal(totals.finished, true);
  });

  it('counts the failures of every process, not only the last one to speak', () => {
    // The shape that matters for the gate: a red first batch and a green one
    // after it. Keeping the last summary reported `fail 0` over a suite with
    // four failures in it.
    const batched = ['# tests 100', '# fail 4', '# tests 20', '# fail 0'].join('\n');
    assert.equal(tapTotals(batched).fail, 4);
    assert.equal(tapTotals(batched).tests, 120);
  });
});

describe('killedFiles — a file ended by a signal from outside the run', () => {
  // node 24.10's own shape for a file whose process got `kill <pid>`.
  const killedTap = [
    'TAP version 13',
    '# Subtest: tests/scripts/build-bundle.test.js',
    'not ok 1 - tests/scripts/build-bundle.test.js',
    '  ---',
    '  duration_ms: 301234.5',
    "  type: 'test'",
    "  location: '/w/candidate/tests/scripts/build-bundle.test.js:1:1'",
    "  failureType: 'testCodeFailure'",
    '  exitCode: ~',
    "  signal: 'SIGTERM'",
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...',
    '# Subtest: tests/own.test.js',
    'not ok 2 - a test in own',
    '  ---',
    "  location: '/w/candidate/tests/own.test.js:3:1'",
    '  exitCode: 1',
    '  signal: ~',
    '  ...',
    '# tests 4',
    '# fail 2',
  ].join('\n');
  const files = ['tests/scripts/build-bundle.test.js', 'tests/own.test.js'];

  it('names the killed file with its signal, and not an ordinary red', () => {
    assert.deepEqual(killedFiles(killedTap, files), [{ file: 'tests/scripts/build-bundle.test.js', signal: 'SIGTERM' }]);
  });

  it('a run with no signal names nothing', () => {
    assert.deepEqual(killedFiles(killedTap.replace("signal: 'SIGTERM'", 'signal: ~'), files), []);
  });

  it('only files the caller named come back; null takes the location as written', () => {
    assert.deepEqual(killedFiles(killedTap, ['tests/own.test.js']), []);
    assert.deepEqual(killedFiles(killedTap, null), [{ file: '/w/candidate/tests/scripts/build-bundle.test.js', signal: 'SIGTERM' }]);
  });

  it('redNamesIn gives the red names a killed file accounts for, and no others', () => {
    assert.deepEqual(redNamesIn(killedTap, ['tests/scripts/build-bundle.test.js']), ['tests/scripts/build-bundle.test.js']);
    assert.deepEqual(redNamesIn(killedTap, []), []);
  });
});

// Captured from node v24.10.0 (`node --test --test-reporter=tap <files>`, in a
// scratch directory, paths shortened to the fixture's name). The captures were
// trimmed: the stack frames of the first are left out after the third, and the hook
// fixtures keep only the lines the reader uses. A file that fails to load writes its
// own diagnostic as `#` comments BEFORE its `# Subtest:` entry, not under it.
describe('a file that failed to load, and a hook that failed — node v24.10.0 TAP', () => {
  const duplicateConst = [
    'TAP version 13',
    '# file:///tmp/fixture/dup.test.js:3',
    '# const a = 2;',
    '#       ^',
    "# SyntaxError: Identifier 'a' has already been declared",
    '#     at compileSourceTextModule (node:internal/modules/esm/utils:357:16)',
    '#     at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:109:18)',
    '# Node.js v24.10.0',
    '# Subtest: dup.test.js',
    'not ok 1 - dup.test.js',
    '  ---',
    '  duration_ms: 142.807875',
    "  type: 'test'",
    "  location: '/tmp/fixture/dup.test.js:1:1'",
    "  failureType: 'testCodeFailure'",
    '  exitCode: 1',
    '  signal: ~',
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...',
    '# Subtest: passes',
    'ok 2 - passes',
    '  ---',
    '  duration_ms: 1.419625',
    "  type: 'test'",
    '  ...',
    '1..2',
    '# tests 2',
    '# suites 0',
    '# pass 1',
    '# fail 1',
    '# cancelled 0',
  ].join('\n');

  it('a file that failed to load names its own diagnostic, not only "test failed"', () => {
    const [failed, ...rest] = redTests(duplicateConst, ['dup.test.js']);
    assert.equal(rest.length, 0, 'the passing file is not red');
    assert.equal(failed.file, 'dup.test.js');
    assert.equal(failed.name, 'dup.test.js');
    assert.ok(failed.error.includes("SyntaxError: Identifier 'a' has already been declared"), failed.error.join('\n'));
    assert.ok(failed.error.includes('const a = 2;'), failed.error.join('\n'));
  });

  // A `before` hook that throws, and one that runs past its timeout. Both cancel
  // their suite's test (`cancelledByParent`), which is not a red test of its own.
  const hookThrows = [
    'TAP version 13',
    '# Subtest: hooked',
    '    # Subtest: child',
    '    not ok 1 - child',
    '      ---',
    "      type: 'test'",
    "      location: '/tmp/fixture/hook.test.js:4:3'",
    "      failureType: 'cancelledByParent'",
    "      error: 'test did not finish before its parent and was cancelled'",
    '      ...',
    '    1..1',
    'not ok 1 - hooked',
    '  ---',
    "  type: 'suite'",
    "  location: '/tmp/fixture/hook.test.js:2:1'",
    "  failureType: 'hookFailed'",
    "  error: 'seed failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  stack: |-',
    '    SuiteContext.<anonymous> (file:///tmp/fixture/hook.test.js:3:24)',
    '    TestHook.run (node:internal/test_runner/test:1106:25)',
    '  ...',
    '# tests 2',
    '# cancelled 1',
  ].join('\n');
  const hookTimesOut = [
    'TAP version 13',
    '# Subtest: hooked',
    'not ok 1 - hooked',
    '  ---',
    "  type: 'suite'",
    "  location: '/tmp/fixture/hook2.test.js:2:1'",
    "  failureType: 'hookFailed'",
    "  error: 'failed running before hook'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...',
    '# tests 1',
    '# cancelled 1',
  ].join('\n');

  it('a hook that threw names the suite it failed in, the hook\'s own frame, and the error', () => {
    const [hook] = redTests(hookThrows, ['hook.test.js']);
    assert.equal(hook.name, 'hooked');
    assert.equal(hook.at, 'hook.test.js:3:24');
    assert.deepEqual(hook.error, ['hook of hooked failed:', 'seed failed']);
    assert.deepEqual(cancelledFiles(hookThrows, ['hook.test.js']), []);
  });

  it('a hook that timed out names which hook it was', () => {
    const [hook] = redTests(hookTimesOut, ['hook2.test.js']);
    assert.equal(hook.name, 'hooked');
    assert.deepEqual(hook.error, ['before hook of hooked failed']);
    assert.deepEqual(cancelledFiles(hookTimesOut, ['hook2.test.js']), ['hook2.test.js']);
  });
});
