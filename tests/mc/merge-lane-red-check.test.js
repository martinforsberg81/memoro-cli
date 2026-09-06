/**
 * A deliberately red test, and nothing else.
 *
 * It exists for the merge-queue project's third success criterion — a queued
 * pull request whose gate goes red gets exactly one repair from the merge lane,
 * and is then the brief's — which cannot be measured against a gate that passes.
 * It is red once, in the rounds of one pull request, and it leaves with the
 * branch that carried it. Nothing in this repository depends on it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('the merge lane meets a red gate', () => {
  it('is red on purpose (merge-queue criterion 3)', () => {
    assert.equal('red on purpose', 'green');
  });
});
