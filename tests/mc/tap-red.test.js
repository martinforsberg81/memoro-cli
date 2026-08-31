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

import { redNames, tapTotals } from '../../src/mc/tap-red.js';

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
