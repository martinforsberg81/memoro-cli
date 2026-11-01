import assert from 'node:assert/strict';
import { it } from 'node:test';
import { handoffPredecessor } from '../../src/mc/autonomous-publish.js';

const runs = ['first', 'second', 'now'].map(run_id => ({ run_id, role: 'step' }));

it('a retry after attempts that wrote no handoff has no predecessor', () => {
  assert.equal(handoffPredecessor({ current_handoff: null, runs }, 'now'), null);
});

it('a continuation follows the last other step run', () => {
  assert.equal(handoffPredecessor({ current_handoff: 'artifact', runs: [...runs, { run_id: 'reviewer', role: 'review' }] }, 'now'), 'second');
});
