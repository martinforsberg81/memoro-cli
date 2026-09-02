/**
 * How every role that can put a question to Martin is told to put it.
 *
 * The overlays used to agree on a shape that produced the failure this
 * project exists to fix: "the options one line each, and a `## Rekommendation`
 * section". A brief opening with six of those is a menu of menus — Martin
 * cannot take a position on it. The shape is a proposal: one thing to do,
 * defended from the code, that he answers with a word.
 *
 * There is no decision file any more, and no answer line: what he decides is
 * written into the plan it is about, and the plan comes back to the runner by
 * its first unfinished step being `ready`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readCanonRole } from '../../src/mc/roles.js';

/**
 * Every role that may put a question to Martin. `brief` answers them.
 *
 * `plan` is not one any more. Its overlay is gone — the role is frontmatter,
 * and what a planning session is told is its first prompt and nothing else
 * (Martin, 2026-08-31) — so there is no text there to hold to a shape. It is
 * also the one session Martin is sitting in front of: a question does not have
 * to become anything to reach him, it can be asked.
 */
const AUTHORS = ['worker', 'step'];

/** Overlays wrap at 76 columns, so every phrase test has to cross newlines. */
const phrase = (words) => new RegExp(words.split(' ').join('\\s+'), 'u');

describe('the decision shape every role writes', () => {
  for (const name of AUTHORS) {
    describe(name, () => {
      const { overlay } = readCanonRole(name);

      it('asks for a proposal, not a menu', () => {
        assert.match(overlay, /\bGO\b|never as a menu|Never a menu|not a menu|never a menu/u);
        assert.match(overlay, /menu/u);
      });

      it('no longer tells the session to list the options', () => {
        assert.doesNotMatch(overlay, phrase('the options one line each'));
        assert.doesNotMatch(overlay, phrase('with the options and your recommendation'));
        assert.doesNotMatch(overlay, phrase('question, options, recommendation'));
      });

      it('forbids the question when it is not ready', () => {
        assert.match(overlay, /unclear|not ready/u);
        assert.match(overlay, /\bread\b/u);
      });
    });
  }

  /**
   * What Martin decides goes into the plan it is about — there is nowhere
   * else for it to live now that mc keeps no decision file.
   */
  it('step writes the answer into the plan, and nothing else carries it', () => {
    const { overlay } = readCanonRole('step');
    assert.match(overlay, phrase('the answer is written'));
    assert.match(overlay, phrase('into the plan'));
    assert.match(overlay, phrase('so the plan carries it on its own'));
    assert.match(overlay, phrase('a plan comes back by its first unfinished step being `ready`'));
    assert.doesNotMatch(overlay, /decision file/u);
  });

  /**
   * The boundary the runner checks on the way back in. It is in the overlay as
   * well, so a session is told before it is caught.
   */
  it('step is told which four things are its to edit, and that it is checked', () => {
    const { overlay } = readCanonRole('step');
    assert.match(overlay, phrase('You never write the plan\'s steps'));
    assert.match(overlay, phrase('its `status`, its `pr`, and its `comments`'));
    assert.match(overlay, phrase('`met` on the criteria you actually met'));
    assert.match(overlay, phrase('This is checked, not asked'));
    assert.match(overlay, phrase('a session that changed anything else leaves a PR it will not'));
  });

  /**
   * The brief is the other side of the same rule: it is the session sitting
   * in front of Martin, and it is the one that failed on 2026-08-29.
   */
  it('brief refuses the menu and refuses an unread question', () => {
    const { overlay } = readCanonRole('brief');
    assert.match(overlay, phrase('says GO to'));
    assert.match(overlay, phrase('Never lay out options for him to choose between'));
    assert.match(overlay, phrase('is not his to answer'));
  });
});
