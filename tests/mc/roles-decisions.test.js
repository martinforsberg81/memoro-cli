/**
 * How every role that can put a question to Martin is told to write it.
 *
 * The five overlays used to agree on a shape that produced the failure this
 * project exists to fix: "the options one line each, and a `## Rekommendation`
 * section". A brief opening with six of those is a menu of menus — Martin
 * cannot take a position on it, and two of the six he was shown on 2026-08-29
 * belonged to projects that no longer existed. The shape is a proposal now:
 * one thing to do, defended from the code, that he answers with a word.
 *
 * The second half is where a decision lives once it is answered. The file is
 * deleted by `mc run`, so the plan has to absorb the answer or it is lost —
 * `step.md` is the role that does the absorbing and is held to it hardest.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readCanonRole } from '../../src/mc/roles.js';

/** Every role that may create a decision file. `brief` answers them instead. */
const AUTHORS = ['worker', 'plan', 'step'];

/** Overlays wrap at 76 columns, so every phrase test has to cross newlines. */
const phrase = (words) => new RegExp(words.split(' ').join('\\s+'), 'u');

describe('the decision shape every role writes', () => {
  for (const name of AUTHORS) {
    describe(name, () => {
      const { overlay } = readCanonRole(name);

      it('asks for a proposal, not a menu', () => {
        assert.match(overlay, phrase('Rekommendation'));
        assert.match(overlay, /\bGO\b|never as a menu|Never a menu|not a menu/u);
        assert.match(overlay, /menu/u);
      });

      it('no longer tells the session to list the options', () => {
        assert.doesNotMatch(overlay, phrase('the options one line each'));
        assert.doesNotMatch(overlay, phrase('with the options and your recommendation'));
        assert.doesNotMatch(overlay, phrase('question, options, recommendation'));
      });

      it('forbids the file when the question is not ready', () => {
        assert.match(overlay, /unclear/u);
        assert.match(overlay, /\bread\b/u);
      });
    });
  }

  /**
   * `step` is the session the runner gives an answered decision to. If it
   * only "applies" the answer in code, the plan still reads as waiting and
   * the deletion rule keeps the file forever; if it writes the answer into
   * PLAN.md, the file has done its job and can go.
   */
  it('step writes the answer into the plan, and the runner never reads one', () => {
    const { overlay } = readCanonRole('step');
    assert.match(overlay, phrase('into PLAN.md'));
    assert.match(overlay, phrase('so the plan carries it on its own'));
    assert.match(overlay, phrase('The runner never reads decision files'));
    assert.match(overlay, phrase('a plan comes back by being `ready`'));
    assert.doesNotMatch(overlay, phrase('read them first, apply the answer, set'));
  });

  /**
   * The brief is the other side of the same rule: it is the session sitting
   * in front of Martin, and it is the one that failed on 2026-08-29.
   */
  it('brief refuses the menu and refuses an unread question', () => {
    const { overlay } = readCanonRole('brief');
    assert.match(overlay, phrase('says GO to'));
    assert.match(overlay, phrase('Never lay out options for him to choose between'));
    assert.match(overlay, phrase('Present a decision as a menu of options'));
    assert.doesNotMatch(overlay, phrase('the options in one line each'));
  });
});
