import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  CLOUD_LIFECYCLE,
  CLOUD_RUNTIME_CONTRACT_VERSION,
  cloudRuntimePhaseSemantics,
} from '../../src/mc/cloud-runtime-contract.js';

describe('cloud runtime contract', () => {
  test('exposes the v1 contract version and lifecycle constants', () => {
    assert.equal(CLOUD_RUNTIME_CONTRACT_VERSION, 'mc-cloud-runtime-v1');
    assert.equal(CLOUD_LIFECYCLE.RUNTIME_PENDING, 'runtime_pending');
    assert.equal(CLOUD_LIFECYCLE.READY, 'ready');
    assert.equal(CLOUD_LIFECYCLE.SLEEPING, 'sleeping');
  });

  test('maps phases to continue semantics', () => {
    assert.deepEqual(cloudRuntimePhaseSemantics('ready'), {
      phase: 'ready',
      live: true,
      wakeable: false,
      canContinue: true,
      continueAction: 'live',
      stopped: false,
      failed: false,
      sleeping: false,
    });
    assert.equal(cloudRuntimePhaseSemantics('broker_connecting').continueAction, 'wait');
    assert.equal(cloudRuntimePhaseSemantics('runtime_pending').continueAction, 'wake');
    assert.equal(cloudRuntimePhaseSemantics('sleeping').continueAction, 'wake');
    assert.equal(cloudRuntimePhaseSemantics('failed').canContinue, false);
    assert.equal(cloudRuntimePhaseSemantics('stopped').continueAction, null);
  });
});
