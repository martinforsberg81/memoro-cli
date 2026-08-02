/**
 * THE server-side liveness judgment: a server-active record is bypassed
 * only with positive local proof of the exact generation's exit; stale
 * records are repairable; everything else stays active-elsewhere.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  judgeServerActiveRecord,
  serverActiveRecordRepairable,
} from '../../../src/core/liveness/server-presence.js';

const GENERATION = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const OTHER = '9937ac60-46ce-42dd-9302-6533f1c6c38c';

describe('server-active judgment', () => {
  test('no record → clear', () => {
    assert.deepEqual(
      judgeServerActiveRecord({ active: null, localPresence: { verdict: 'exited' } }),
      { decision: 'clear' },
    );
  });

  test('local exit proof of the exact generation → exited-match (bypass safe)', () => {
    assert.deepEqual(judgeServerActiveRecord({
      active: { runtime_generation: GENERATION },
      localPresence: { verdict: 'exited', runtime_generation: GENERATION },
    }), { decision: 'exited-match', runtimeGeneration: GENERATION });
  });

  test('a generationless record with local exit proof → repairable-stale', () => {
    assert.deepEqual(judgeServerActiveRecord({
      active: { runtime_generation: null },
      localPresence: { verdict: 'exited', runtime_generation: GENERATION },
    }), { decision: 'repairable-stale', runtimeGeneration: GENERATION });
  });

  test('a different generation, or no local proof, stays active-elsewhere', () => {
    for (const [active, localPresence] of [
      [{ runtime_generation: OTHER }, { verdict: 'exited', runtime_generation: GENERATION }],
      [{ runtime_generation: GENERATION }, { verdict: 'unreachable', runtime_generation: GENERATION }],
      [{ runtime_generation: GENERATION }, { verdict: 'exited', runtime_generation: null }],
      [{ runtime_generation: GENERATION }, { verdict: 'unknown' }],
      [{ runtime_generation: null }, { verdict: 'live', runtime_generation: GENERATION }],
    ]) {
      assert.equal(
        judgeServerActiveRecord({ active, localPresence }).decision,
        'active-elsewhere',
        JSON.stringify({ active, localPresence }),
      );
    }
  });

  test('repairable covers both the stale and the exact-match record', () => {
    assert.equal(serverActiveRecordRepairable({
      active: { runtime_generation: null },
      localPresence: { verdict: 'exited', runtime_generation: GENERATION },
    }), true);
    assert.equal(serverActiveRecordRepairable({
      active: { runtime_generation: GENERATION },
      localPresence: { verdict: 'exited', runtime_generation: GENERATION },
    }), true);
    assert.equal(serverActiveRecordRepairable({
      active: { runtime_generation: OTHER },
      localPresence: { verdict: 'exited', runtime_generation: GENERATION },
    }), false);
    assert.equal(serverActiveRecordRepairable({
      active: null,
      localPresence: { verdict: 'exited', runtime_generation: GENERATION },
    }), false);
  });
});
