import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  materialiseVaultBeforeLaunch,
  shouldOfferUnlock,
} from '../../../src/mc/vault/startup.js';

describe('vault startup unlock offer', () => {
  it('offers only for an interactive locked vault outside test mode', () => {
    const locked = { ok: false, reason: 'vault-locked' };
    assert.equal(shouldOfferUnlock(locked, { stdin: { isTTY: true }, env: {} }), true);
    assert.equal(shouldOfferUnlock(locked, { stdin: { isTTY: false }, env: {} }), false);
    assert.equal(shouldOfferUnlock(locked, { stdin: { isTTY: true }, env: { MC_TEST_MODE: '1' } }), false);
    assert.equal(shouldOfferUnlock({ ok: false, reason: 'no-memoro-token' }, { stdin: { isTTY: true }, env: {} }), false);
    assert.equal(shouldOfferUnlock({ ok: true }, { stdin: { isTTY: true }, env: {} }), false);
  });

  it('decline keeps the original soft-degrade result and does not unlock', async () => {
    const calls = { materialise: 0, unlock: 0, prompt: 0 };
    const first = { ok: false, reason: 'vault-locked', hint: 'run unlock' };
    const res = await materialiseVaultBeforeLaunch({
      sessionId: 's',
      worktreePath: '/wt',
      deps: {
        env: {},
        stdin: { isTTY: true },
        stderr: { write() {} },
        materialiseForSession: async () => { calls.materialise++; return first; },
        promptUnlock: async () => { calls.prompt++; return false; },
        unlockVault: async () => { calls.unlock++; return 0; },
      },
    });
    assert.equal(res, first);
    assert.deepEqual(calls, { materialise: 1, unlock: 0, prompt: 1 });
  });

  it('accept unlocks and retries materialisation before launch', async () => {
    const calls = { materialise: 0, unlock: 0, prompt: 0 };
    const first = { ok: false, reason: 'vault-locked', hint: 'run unlock' };
    const second = { ok: true, materialised: [{ tool: 'codex' }] };
    const adapters = [{ TOOL_NAME: 'codex' }];
    const seenAdapters = [];
    const res = await materialiseVaultBeforeLaunch({
      sessionId: 's',
      worktreePath: '/wt',
      adapters,
      deps: {
        env: {},
        stdin: { isTTY: true },
        stderr: { write() {} },
        materialiseForSession: async (arg) => {
          calls.materialise++;
          seenAdapters.push(arg.adapters);
          return calls.materialise === 1 ? first : second;
        },
        promptUnlock: async () => { calls.prompt++; return true; },
        unlockVault: async () => { calls.unlock++; return 0; },
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.unlockAttempted, true);
    assert.deepEqual(calls, { materialise: 2, unlock: 1, prompt: 1 });
    assert.deepEqual(seenAdapters, [adapters, adapters]);
  });

  it('non-interactive locked vault keeps current no-prompt behavior', async () => {
    const calls = { materialise: 0, prompt: 0 };
    const first = { ok: false, reason: 'vault-locked', hint: 'run unlock' };
    const res = await materialiseVaultBeforeLaunch({
      sessionId: 's',
      worktreePath: '/wt',
      deps: {
        env: {},
        stdin: { isTTY: false },
        materialiseForSession: async () => { calls.materialise++; return first; },
        promptUnlock: async () => { calls.prompt++; return true; },
      },
    });
    assert.equal(res, first);
    assert.deepEqual(calls, { materialise: 1, prompt: 0 });
  });
});
