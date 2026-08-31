/**
 * The word the gate prints, which has been the defect twice.
 *
 * The first time, the rule was differential — nothing new went red — and the
 * verdict said `GREEN` on top of fifty-five standing red names on main. The
 * correction was a second word, `NO NEW RED`, and a number in the line.
 *
 * On 2026-08-31 the differential rule itself went: a round measures one tree,
 * and a test the change reaches is either green or the round is red. So the
 * second word has nothing left to say and the number has nothing to count, and
 * what is asserted here is that neither came back — a verdict with a word for
 * "green, but" is a verdict somebody has to take a position on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gateLines } from '../../../src/mc/commands/repo.js';
import { verdictFor, verdictHeadline, verdictPhrase } from '../../../src/mc/repo-gate.js';

/** A gate report in the shape `runGate` returns one, with `red` red names. */
function report({ red = [], selection = null, full = false, extraGates = [] } = {}) {
  const built = {
    repo: '/work/repo',
    full,
    pr: full ? { number: null, head: null, base: null } : { number: 400, head: 'feature', base: 'main' },
    base: { ref: 'origin/main', commit: 'base1111' },
    ok: red.length === 0,
    stopped_at: red.length ? 'red' : null,
    reason: red.length ? `${red.length} tests red: ${red.join(', ')}` : null,
    candidate: { commit: 'cand2222', totals: { tests: 1876 }, red },
    selection,
    extra_gates: extraGates,
    pr_tests: null,
    timings: {},
    declaration: {},
  };
  built.verdict = verdictFor(built);
  return built;
}

const said = (r, options) => gateLines(r, options).join('\n');

describe('the verdict is green or it is red', () => {
  it('a tree with no red names is GREEN', () => {
    assert.match(said(report()), /GREEN — the test gate passes/u);
    assert.equal(verdictFor(report()), 'green');
  });

  it('a tree with red names is RED, and every name is in the lines', () => {
    const text = said(report({ red: ['old world › one', 'old world'] }));
    assert.match(text, /RED — 2 tests red:/u);
    assert.match(text, /^ {6}old world › one$/mu);
    assert.doesNotMatch(text, /GREEN/u);
  });

  /**
   * The word that is not allowed back. `NO NEW RED — 55 standing red names on
   * main` was the honest form of the differential pass, and it cost a second
   * worktree and half of every round to be able to say. A pass is a pass now.
   */
  it('there is no "no new red" any more, in any form', () => {
    for (const text of [said(report()), verdictHeadline(report()), verdictPhrase(report())]) {
      assert.doesNotMatch(text, /no new red/iu);
      assert.doesNotMatch(text, /standing red/iu);
    }
    assert.equal(verdictPhrase(report()), 'gate green');
  });

  it('a red command gate is red too, and says which contract broke', () => {
    const text = said(report({
      extraGates: [{ source: 'selection', name: 'i18n:contract', command: 'npm run i18n:contract', ok: false, ran: true, exit_code: 3, duration_ms: 4000, output: 'hardcoded string' }],
    }));
    assert.match(text, /RED — 1 command gate the selection chose failed/u);
    assert.match(text, /gate i18n:contract — FAILED \(exit 3\) in 4\.0s/u);
    assert.match(text, /a contract this change breaks, not a test that was already red/u);
  });

  it('keeps the line saying a passing gate is not a review', () => {
    const text = said(report());
    assert.match(text, /It says nothing about whether the change is right/u);
    assert.match(text, /that is the review, and it is still somebody's to do/u);
  });
});

describe('how far the verdict reached, in the verdict', () => {
  it('a selected round says over how many files it passed', () => {
    assert.match(said(report({ selection: { files: 17, commands: 2, full_suite: false } })),
      /GREEN — the test gate passes — measured over the 17 test files this change reaches/u);
  });

  it('a selector that gave up says that instead', () => {
    assert.match(said(report({ selection: { files: 258, commands: 0, full_suite: true } })),
      /over the whole suite: the selector could not narrow this change/u);
  });

  it('a --full round names itself and the branch it measured', () => {
    const text = said(report({ full: true }));
    assert.match(text, /the whole suite/u);
    assert.match(text, /origin\/main as fetched/u);
    assert.match(text, /asked for by --full/u);
  });
});
