import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultPromptUnlock,
  materialiseVaultBeforeLaunch,
  shouldOfferUnlock,
} from '../../../src/vault/engine/startup.js';

describe('credential-blind vault startup', () => {
  it('never offers to unlock a vault for a managed launch', async () => {
    assert.equal(shouldOfferUnlock(
      { ok: false, reason: 'vault-locked' },
      { stdin: { isTTY: true }, env: {} },
    ), false);
    assert.equal(await defaultPromptUnlock({
      question: 'must not be asked',
      stdin: { isTTY: true },
    }), false);
  });

  it('does not call materialisation, unlock, prompt, or output dependencies', async () => {
    const forbidden = () => {
      throw new Error('credential-bearing dependency must not be called');
    };
    const result = await materialiseVaultBeforeLaunch({
      sessionId: 'managed-session',
      worktreePath: '/worktree',
      adapters: [{ TOOL_NAME: 'generic' }],
      deps: {
        materialiseForSession: forbidden,
        unlockVault: forbidden,
        promptUnlock: forbidden,
      },
    });

    assert.deepEqual(result, {
      ok: true,
      policy: 'credential-blind-v1',
      materialised: [],
      skipped: [{ reason: 'plaintext-materialisation-disabled' }],
    });
  });
});
