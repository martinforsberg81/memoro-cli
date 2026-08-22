/**
 * The word the gate prints, which is the thing that was wrong.
 *
 * The rule has always been differential — nothing new went red — and the
 * verdict said `GREEN` on top of fifty-five standing red names on main. That
 * word is the one every merge decision was reported with for a week, and it
 * was reported as the larger claim it sounds like. So these tests are about
 * strings, deliberately: the mechanism was already right, and the string was
 * the defect.
 *
 * Two rules, and the second is the one worth having a test for. `GREEN` only
 * when the base is actually green — and when it is not, the number is in the
 * line, not in a footnote in a document beside it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gateLines } from '../../../src/mc/commands/repo.js';
import { verdictFor, verdictHeadline, verdictPhrase } from '../../../src/mc/repo-gate.js';

/** A gate report that passed, with `standing` red names on the base. */
function passed({ standing = 0, ratchet = null, fixed = [] } = {}) {
  const red = Array.from({ length: standing }, (_, i) => `standing red ${i + 1}`);
  const report = {
    pr: { number: 400, head: 'feature', base: 'main' },
    ok: true,
    stopped_at: null,
    reason: null,
    baseline: { commit: 'base1111', totals: { tests: 1876 }, red },
    candidate: { commit: 'cand2222', totals: { tests: 1876 }, red },
    broke: [],
    fixed,
    standing_red: standing,
    ratchet,
    extra_gates: [],
    declaration: {},
  };
  report.verdict = verdictFor(report);
  return report;
}

const said = (report, options) => gateLines(report, options).join('\n');

describe('the verdict never says green over standing red', () => {
  it('a base with no red names is still GREEN, unchanged', () => {
    const text = said(passed({ standing: 0 }));
    assert.match(text, /GREEN — the test gate passes/u);
    assert.equal(verdictFor(passed({ standing: 0 })), 'green');
  });

  it('a base with red names never uses the word at all', () => {
    const text = said(passed({ standing: 55 }));
    assert.doesNotMatch(text, /green/iu, 'the word must not appear anywhere in the verdict');
  });

  it('and carries the number in the line instead', () => {
    const text = said(passed({ standing: 55 }));
    assert.match(text, /NO NEW RED — 55 standing red names on main/u);
    assert.equal(verdictFor(passed({ standing: 55 })), 'no-new-red');
  });

  it('one standing red name reads as one, not as 1 names', () => {
    assert.match(verdictHeadline(passed({ standing: 1 })), /1 standing red name on main/u);
  });

  /**
   * The reason the PM asked for this, said where the verdict is read. A test
   * that is already failing cannot fail any harder, so a fault introduced
   * inside one of the standing red names has nowhere to appear. They are not
   * only debt; they are that many places the gate is blind.
   */
  it('says what the standing red names cost, not only that they exist', () => {
    const text = said(passed({ standing: 55 }));
    assert.match(text, /a new fault inside any of them could not have shown up in this round/u);
  });

  it('keeps the line saying a passing gate is not a review, both ways', () => {
    for (const standing of [0, 55]) {
      const text = said(passed({ standing }));
      assert.match(text, /It says nothing about whether the change is right/u);
      assert.match(text, /that is the review, and it is still somebody's to do/u);
    }
  });

  it('the merge round narrates the same statement, not a friendlier one', () => {
    assert.equal(verdictPhrase(passed({ standing: 0 })), 'gate green');
    const phrase = verdictPhrase(passed({ standing: 55 }));
    assert.doesNotMatch(phrase, /green/iu);
    assert.match(phrase, /no new red \(55 standing red on main\)/u);
  });
});

describe('what the ratchet says on a round that passed it', () => {
  it('a repository with standing red and no recorded floor is told to record one', () => {
    const text = said(passed({ standing: 55, ratchet: { present: false, ok: true, file: '.mc/red-ratchet.json', accepted: 0, risen: [], fallen: [] } }));
    assert.match(text, /no standing red set is recorded/u);
    assert.match(text, /the 56th joining them/u, 'the point of recording it is the one that would come next');
  });

  it('a green repository with no ratchet is not nagged about one', () => {
    const text = said(passed({ standing: 0, ratchet: { present: false, ok: true, file: '.mc/red-ratchet.json', accepted: 0, risen: [], fallen: [] } }));
    assert.doesNotMatch(text, /red-ratchet/u);
  });

  it('names that came good are listed, and mc does not write the file itself', () => {
    const text = said(passed({
      standing: 55,
      ratchet: { present: true, ok: true, file: '.mc/red-ratchet.json', accepted: 56, risen: [], fallen: ['flaky under load'] },
    }));
    assert.match(text, /1 of them is green here/u);
    assert.match(text, /flaky under load/u);
    // The reason it is an instruction rather than an automatic write.
    assert.match(text, /would come back, and read as a rise next round/u);
  });
});

describe('a floor that moved', () => {
  const risen = {
    pr: { number: 400, head: 'feature', base: 'main' },
    ok: false,
    stopped_at: 'ratchet',
    reason: '1 red name is not in the standing red set recorded in .mc/red-ratchet.json',
    baseline: { commit: 'base1111', totals: { tests: 1876 }, red: ['a', 'b'] },
    candidate: { commit: 'cand2222', totals: { tests: 1876 }, red: ['a', 'b'] },
    broke: [],
    fixed: [],
    standing_red: 2,
    ratchet: { present: true, ok: true, file: '.mc/red-ratchet.json', accepted: 1, risen: ['b'], fallen: [] },
    extra_gates: [],
    declaration: {},
  };

  it('is reported with its names rather than as a generic stop', () => {
    const text = said(risen);
    assert.match(text, /RATCHET RISEN — 1 red name not in the standing red set/u);
    assert.doesNotMatch(text, /the round stopped at ratchet/u, 'it is a verdict, not a round that fell over');
    assert.equal(verdictFor(risen), 'ratchet-risen');
  });

  it('says plainly that the pull request did not cause it', () => {
    // Every risen name was red on the baseline too — one red only on the
    // candidate is `broke` and was stopped before this. An author refused for
    // somebody else's regression should not have to work that out.
    assert.match(said(risen), /red on main too, so this change did not cause it/u);
  });

  it('offers the remedy as a paste rather than as a retyping exercise', () => {
    assert.match(said(risen), /^ +"b",$/mu);
    // And it agrees with itself about how many there are.
    assert.match(said(risen), /fix it, or add it to its "names"/u);
  });

  it('an unreadable ratchet stops the round and decides nothing from it', () => {
    const broken = {
      ...risen,
      reason: '.mc/red-ratchet.json is not readable JSON',
      ratchet: { present: true, ok: false, file: '.mc/red-ratchet.json', accepted: 0, risen: [], fallen: [], reason: '.mc/red-ratchet.json is not readable JSON' },
    };
    const text = said(broken);
    assert.match(text, /STOPPED — .mc\/red-ratchet.json is not readable JSON/u);
    assert.match(text, /an unreadable ratchet is not an empty one/u);
  });
});
