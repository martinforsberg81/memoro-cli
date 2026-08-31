/**
 * The word the gate prints, and how much it prints around it.
 *
 * The word has been the defect twice. The first time the rule was differential
 * — nothing new went red — and the verdict said `GREEN` on top of fifty-five
 * standing red names on main; the correction was a second word, `NO NEW RED`,
 * and a number in the line. On 2026-08-31 the differential rule itself went: a
 * round measures one tree, and a test the change reaches is either green or the
 * round is red. So the second word has nothing left to say and the number has
 * nothing to count, and what is asserted below is that neither came back.
 *
 * The same ruling took the prose. A verdict a session has to weigh costs
 * tokens and turns a yes/no into a judgement call, so a green round is three
 * lines — subject, what ran as counts, the time — and a red one names what
 * failed and nothing else. Everything cut is behind `--json`, which is why the
 * length is asserted here as a number rather than left to drift back.
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
    pr_tests: { files: ['tests/a.test.js'], totals: { tests: 9 }, red: [] },
    timings: { prepare: 8000, suite: 54000 },
    duration_ms: 71000,
    declaration: { prepare: 'npm ci' },
  };
  built.verdict = verdictFor(built);
  return built;
}

const said = (r) => gateLines(r).join('\n');

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

  it('a red command gate is red too, and names which contract broke', () => {
    const text = said(report({
      extraGates: [{ source: 'selection', name: 'i18n:contract', command: 'npm run i18n:contract', ok: false, ran: true, exit_code: 3, duration_ms: 4000, output: 'hardcoded string' }],
    }));
    assert.match(text, /RED — 1 command gate failed:/u);
    assert.match(text, /^ {6}i18n:contract — exit 3 — npm run i18n:contract$/mu);
  });

  it('a gate that could not run at all says so rather than showing an exit code', () => {
    const text = said(report({
      extraGates: [{ source: 'selection', name: 'css:lint', command: 'npm run css:lint', ok: false, ran: false, exit_code: null, duration_ms: 20 }],
    }));
    assert.match(text, /^ {6}css:lint — could not run — npm run css:lint$/mu);
  });
});

/**
 * The length, asserted. Every line below was in a real verdict on 2026-08-31
 * and every one of them is now `--json`'s: the ruling is that a session
 * reading a verdict should have nothing to weigh, and prose is what grows back
 * if nothing counts it.
 */
describe('the verdict is short', () => {
  it('a green round is three lines: what it was, what ran, how long', () => {
    const lines = gateLines(report({ selection: { files: 17, commands: 2, full_suite: false } }));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^mc: repo #400 \(feature\) → main — GREEN/u);
    assert.match(lines[1], /^mc: ran 17 test files \(1876 tests\) and 0 command gates on cand222 /u);
    assert.match(lines[2], /^mc: 71s — --json /u);
  });

  it('a red round is the failures and the time, and nothing else', () => {
    const lines = gateLines(report({
      red: ['old world › one'],
      selection: { files: 17, commands: 2, full_suite: false },
      extraGates: [
        { source: 'selection', name: 'css:lint', command: 'npm run css:lint', ok: true, ran: true, exit_code: 0, duration_ms: 15100 },
        { source: 'selection', name: 'i18n:contract', command: 'npm run i18n:contract', ok: false, ran: true, exit_code: 3, duration_ms: 4000 },
      ],
    }));
    assert.deepEqual(lines, [
      'mc: repo #400 (feature) → main — RED — 1 test red, 1 command gate failed:',
      '      old world › one',
      '      i18n:contract — exit 3 — npm run i18n:contract',
      'mc: 71s — --json for timings, gate output and the file list',
    ]);
    // The gate that passed is a count on a green round and nothing on a red
    // one: a reader of a red verdict is repairing, not auditing.
    assert.doesNotMatch(lines.join('\n'), /css:lint/u);
  });

  /** Each of these was a line of its own until 2026-08-31. */
  it('what moved behind --json is not in the lines any more', () => {
    const text = said(report({
      selection: { files: 17, commands: 2, full_suite: false },
      extraGates: [{ source: 'selection', name: 'css:lint', command: 'npm run css:lint', ok: true, ran: true, exit_code: 0, duration_ms: 15100 }],
    }));
    // The pull request's own tests, the per-phase timings, what the round
    // prepared with, each passing gate's duration, and the two-line caveat
    // that a green is not a review.
    assert.doesNotMatch(text, /own tests/u);
    assert.doesNotMatch(text, /prepare 8s|suite 54s/u);
    assert.doesNotMatch(text, /prepared with/u);
    assert.doesNotMatch(text, /passed in/u);
    assert.doesNotMatch(text, /says nothing about whether the change is right/u);
    assert.doesNotMatch(text, /asked to check only/u);
  });

  it('a round that stopped before measuring says so in two lines', () => {
    const stopped = { ...report(), ok: false, stopped_at: 'lease', reason: 'held by alpha', candidate: null };
    assert.deepEqual(gateLines(stopped), [
      'mc: the round stopped at lease — held by alpha',
      'mc: nothing was measured, and nothing was merged',
    ]);
  });
});

describe('how far the verdict reached, in the verdict', () => {
  it('a selected round says over how many files it passed', () => {
    assert.match(said(report({ selection: { files: 17, commands: 2, full_suite: false } })),
      /ran 17 test files/u);
  });

  it('a selector that gave up says so, in a clause on the verdict itself', () => {
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
