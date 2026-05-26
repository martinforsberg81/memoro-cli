/**
 * TDD spec for the open-question heuristic (§9a).
 *
 * The heuristic, per the plan + hint in the brief:
 *   - ends with `?`
 *   - contains "Vill du" (Swedish "do you want")
 *   - contains "Want me to"
 *   - contains "A or B" style choice
 *   - contains numbered choices ("1. … 2. …")
 *
 * The implementation may live anywhere — likely
 * `src/mc/open-question.js` exporting a pure
 * `detectOpenQuestion(text) → boolean`. If the file isn't there yet,
 * this test fails on import, which is the right signal for TDD.
 *
 * Implementation hint: keep it a pure string function so this test
 * (and `mc status` / `mc list --rich`) can call it cheaply.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

let detectOpenQuestion;
try {
  ({ detectOpenQuestion } = await import('../../../src/mc/open-question.js'));
} catch (err) {
  // Surface a clear failure mode for the impl session.
  detectOpenQuestion = () => {
    throw new Error(
      'src/mc/open-question.js not implemented yet — must export ' +
      '`detectOpenQuestion(text: string): boolean`. Original import ' +
      `error: ${err.message}`,
    );
  };
}

describe('detectOpenQuestion', () => {
  const positives = [
    'Should I update the schema?',
    'Vill du att jag fortsätter?',
    'Vill du jag pushar?',
    'Want me to push the changes?',
    'Want me to refactor it now?',
    'Should I go with A or B?',
    'Should I go with option A or option B?',
    'Options:\n  1. Add a guard\n  2. Refactor caller\n  3. Hold',
    'Ja eller nej — fortsätter jag?',
  ];

  const negatives = [
    'Changes have been committed.',
    'All done. Branch merged.',
    'Tests pass. PR opened.',
    '', // empty
    'Looks good.',
    // A question mark in a URL shouldn't trigger:
    'See https://example.com/path?foo=1 for details.',
    // A "1." that's a version number, not a numbered list:
    'Upgraded to version 1.2.3 and ran tests.',
  ];

  for (const text of positives) {
    test(`positive: ${JSON.stringify(text.slice(0, 60))}`, () => {
      assert.equal(detectOpenQuestion(text), true,
        `expected open question for: ${JSON.stringify(text)}`);
    });
  }

  for (const text of negatives) {
    test(`negative: ${JSON.stringify(text.slice(0, 60))}`, () => {
      assert.equal(detectOpenQuestion(text), false,
        `expected NOT open question for: ${JSON.stringify(text)}`);
    });
  }
});
