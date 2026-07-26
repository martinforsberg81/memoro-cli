/**
 * Escalate-only safety verdict derivation: fresh git facts may make a
 * stored verdict less safe, never more safe. Full recomputation stays in
 * `mc end`.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { escalateSafetyVerdict } from '../../src/mc/safety-verdict.js';

describe('escalateSafetyVerdict', () => {
  test('stored SAFE_TO_END never survives observed dirty files', () => {
    assert.equal(
      escalateSafetyVerdict({ stored: 'SAFE_TO_END', dirtyFiles: 287, ahead: 0 }),
      'NEEDS_REVIEW',
    );
  });

  test('stored SAFE_TO_END never survives observed unmerged commits', () => {
    assert.equal(
      escalateSafetyVerdict({ stored: 'SAFE_TO_END', dirtyFiles: 0, ahead: 3 }),
      'HAS_UNMERGED_WORK',
    );
  });

  test('never de-escalates a stored NEEDS_REVIEW on clean facts', () => {
    assert.equal(
      escalateSafetyVerdict({ stored: 'NEEDS_REVIEW', dirtyFiles: 0, ahead: 0 }),
      'NEEDS_REVIEW',
    );
  });

  test('never de-escalates a stored HAS_UNMERGED_WORK on clean facts', () => {
    assert.equal(
      escalateSafetyVerdict({ stored: 'HAS_UNMERGED_WORK', dirtyFiles: 0, ahead: 0 }),
      'HAS_UNMERGED_WORK',
    );
  });

  test('keeps IS_SQUASH_PHANTOM for ahead-only, escalates it on dirty', () => {
    assert.equal(
      escalateSafetyVerdict({ stored: 'IS_SQUASH_PHANTOM', dirtyFiles: 0, ahead: 5 }),
      'IS_SQUASH_PHANTOM',
    );
    assert.equal(
      escalateSafetyVerdict({ stored: 'IS_SQUASH_PHANTOM', dirtyFiles: 2, ahead: 5 }),
      'NEEDS_REVIEW',
    );
  });

  test('trusts IS_ACTIVE_NOW as-is (callers clear it when unreachable)', () => {
    assert.equal(
      escalateSafetyVerdict({ stored: 'IS_ACTIVE_NOW', dirtyFiles: 12, ahead: 1 }),
      'IS_ACTIVE_NOW',
    );
  });

  test('no stored verdict derives from facts', () => {
    assert.equal(escalateSafetyVerdict({ stored: null, dirtyFiles: 0, ahead: 0 }), 'SAFE_TO_END');
    assert.equal(escalateSafetyVerdict({ stored: null, dirtyFiles: 1, ahead: 0 }), 'NEEDS_REVIEW');
    assert.equal(escalateSafetyVerdict({ stored: null, dirtyFiles: 0, ahead: 2 }), 'HAS_UNMERGED_WORK');
  });

  test('nothing known at all fails safe, never SAFE_TO_END', () => {
    assert.equal(escalateSafetyVerdict({}), 'NEEDS_REVIEW');
    assert.equal(escalateSafetyVerdict({ stored: null, dirtyFiles: null, ahead: null }), 'NEEDS_REVIEW');
  });
});
