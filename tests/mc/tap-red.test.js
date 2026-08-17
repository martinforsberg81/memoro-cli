/**
 * Reading a suite run's failures — the two mistakes that make a gate lie.
 *
 * Counting instead of naming: a round that fixed one test and broke another
 * has the same total on both sides, and a gate comparing totals waves it
 * through. Reading only the top level: a file's suites and tests each get a
 * TAP line, so swapping which test inside a suite fails leaves the top level
 * byte-identical. Both are asserted here against TAP shaped the way node's own
 * reporter shapes it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareRed, redNames, tapTotals } from '../../src/mc/tap-red.js';

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
      tests: 2, pass: 2, fail: 0, cancelled: null, finished: true,
    });

    // A run that died before its summary. The distinction is the whole reason
    // this exists: an empty red set from a run that never ran looks exactly
    // like a clean sweep.
    const died = 'TAP version 13\n# Subtest: a\nnot ok 1 - a\n';
    assert.equal(tapTotals(died).finished, false);
  });
});

describe('comparing two red sets', () => {
  it('the same count with different names is a regression', () => {
    // The mistake this whole module exists for: one fixed, one broken, totals
    // unchanged. A gate comparing numbers calls this quiet.
    const before = ['suite › one', 'suite'];
    const after = ['suite › two', 'suite'];
    const { broke, fixed } = compareRed(before, after);
    assert.deepEqual(broke, ['suite › two']);
    assert.deepEqual(fixed, ['suite › one']);
  });

  it('a round that repaired something is not held against it', () => {
    const { broke, fixed } = compareRed(['a', 'b'], ['a']);
    assert.deepEqual(broke, []);
    assert.deepEqual(fixed, ['b']);
  });

  it('an unchanged red set is unchanged', () => {
    const red = ['old world › one', 'old world › two', 'old world'];
    assert.deepEqual(compareRed(red, [...red]), { broke: [], fixed: [] });
  });

  it('order does not make two identical sets differ', () => {
    const { broke, fixed } = compareRed(['a', 'b'], ['b', 'a']);
    assert.deepEqual(broke, []);
    assert.deepEqual(fixed, []);
  });
});
