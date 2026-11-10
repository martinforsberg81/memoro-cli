import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultPromptUnlock,
  materialiseVaultBeforeLaunch,
  shouldOfferUnlock,
} from '../../../src/vault/engine/startup.js';

// Runs one awaited call with stdout and stderr mocked, then restores them before
// returning. The window holds only that call: the test runner's child reports
// through stdout, so any other I/O inside it would be recorded too.
async function recordWrites(t, call) {
  const writes = [];
  const recorder = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  t.mock.method(process.stdout, 'write', recorder);
  t.mock.method(process.stderr, 'write', recorder);
  let result;
  try {
    result = await call({ write: recorder });
  } finally {
    t.mock.restoreAll();
  }
  return { result, writes };
}

describe('credential-blind vault startup', () => {
  it('never offers to unlock a vault for a managed launch', async (t) => {
    assert.equal(shouldOfferUnlock(
      { ok: false, reason: 'vault-locked' },
      { stdin: { isTTY: true }, env: {} },
    ), false);
    const { result, writes } = await recordWrites(t, (output) => defaultPromptUnlock({
      question: 'must not be asked',
      stdin: { isTTY: true },
      output,
    }));
    assert.equal(result, false);
    assert.deepEqual(writes, []);
  });

  it('does not call materialisation, unlock, prompt, or output dependencies', async (t) => {
    const forbidden = () => {
      throw new Error('credential-bearing dependency must not be called');
    };
    const { result, writes } = await recordWrites(t, () => materialiseVaultBeforeLaunch({
      sessionId: 'managed-session',
      worktreePath: '/worktree',
      adapters: [{ TOOL_NAME: 'generic' }],
      deps: {
        materialiseForSession: forbidden,
        unlockVault: forbidden,
        promptUnlock: forbidden,
      },
    }));

    assert.deepEqual(result, {
      ok: true,
      policy: 'credential-blind-v1',
      materialised: [],
      skipped: [{ reason: 'plaintext-materialisation-disabled' }],
    });
    assert.deepEqual(writes, []);
  });
});
