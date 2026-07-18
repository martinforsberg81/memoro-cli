import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  materialiseVaultForWrap,
  resolvePolicyForWrap,
  resolveRequestedToolForWrap,
  resolveWrapFocus,
  startupMessageFromGroundingParts,
} from '../../src/mc/wrap-start.js';

describe('resolveRequestedToolForWrap', () => {
  test('session env tool wins over persisted default', () => {
    assert.equal(resolveRequestedToolForWrap({
      env: { MC_GROUNDING_TOOL: 'codex' },
      config: { defaultTool: 'claude-code' },
    }), 'codex');
  });

  test('bare mc uses persisted default tool when no session tool is set', () => {
    assert.equal(resolveRequestedToolForWrap({
      env: {},
      config: { defaultTool: 'codex' },
    }), 'codex');
  });

  test('falls back to codex when neither env nor config selects a tool', () => {
    assert.equal(resolveRequestedToolForWrap({ env: {}, config: {} }), 'codex');
  });
});

describe('resolveWrapFocus', () => {
  test('wrap label wins over focus env', () => {
    assert.equal(resolveWrapFocus({
      label: 'audit',
      env: { MC_GROUNDING_FOCUS: 'from-new' },
    }), 'audit');
  });

  test('uses MC_GROUNDING_FOCUS when no label is set', () => {
    assert.equal(resolveWrapFocus({
      label: null,
      env: { MC_GROUNDING_FOCUS: 'from-new' },
    }), 'from-new');
  });

  test('returns null when no focus source is available', () => {
    assert.equal(resolveWrapFocus({ label: null, env: {} }), null);
  });
});

describe('resolvePolicyForWrap', () => {
  test('uses session entry + repo policy + explicit launch tool', () => {
    const policy = resolvePolicyForWrap({
      sessionName: 'data',
      cwd: '/repo',
      tool: 'codex',
      config: { policy: { permissions: { workspace: 'read-only' } } },
      deps: {
        findEntry: (name) => ({
          name,
          tool: 'claude',
          policy: { permissions: { approval: 'never' } },
        }),
        readRepoPolicy: () => ({ permissions: { workspace: 'full' } }),
      },
    });
    assert.equal(policy.permissions.rendered_for, 'codex');
    assert.equal(policy.permissions.source, 'session');
    assert.equal(policy.permissions.approval, 'never');
    assert.equal(policy.permissions.workspace, 'worktree');
    assert.deepEqual(policy.explicit_permissions, ['approval']);
  });

  test('falls through to repo policy when there is no session entry', () => {
    const policy = resolvePolicyForWrap({
      sessionName: 'missing',
      cwd: '/repo',
      tool: 'codex',
      deps: {
        findEntry: () => null,
        readRepoPolicy: () => ({ permissions: { workspace: 'read-only' } }),
      },
    });
    assert.equal(policy.permissions.source, 'repo');
    assert.equal(policy.permissions.workspace, 'read-only');
    assert.deepEqual(policy.explicit_permissions, ['workspace']);
  });
});

describe('materialiseVaultForWrap', () => {
  test('skips when new/resume already ran vault startup before re-exec', async () => {
    let called = false;
    const res = await materialiseVaultForWrap({
      codingSessionId: 'sess_abc',
      cwd: '/repo',
      launchAdapter: { TOOL_NAME: 'codex' },
      env: { MC_VAULT_STARTUP_DONE: '1' },
      deps: {
        materialiseVaultBeforeLaunch: async () => {
          called = true;
          return { ok: true };
        },
      },
    });
    assert.equal(called, false);
    assert.equal(res.ok, true);
    assert.equal(res.shouldShredOnExit, false);
    assert.equal(res.skipped[0].reason, 'already-materialised');
  });

  test('bare mc materialises against the coding session id and shreds on exit', async () => {
    const seen = [];
    const adapter = { TOOL_NAME: 'claude' };
    const res = await materialiseVaultForWrap({
      codingSessionId: 'sess_abc',
      cwd: '/repo',
      launchAdapter: adapter,
      env: {},
      deps: {
        materialiseVaultBeforeLaunch: async (arg) => {
          seen.push(arg);
          return { ok: true, materialised: [{ tool: 'claude' }] };
        },
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.sessionId, 'sess_abc');
    assert.equal(res.shouldShredOnExit, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sessionId, 'sess_abc');
    assert.equal(seen[0].worktreePath, '/repo');
    assert.deepEqual(seen[0].adapters, [adapter]);
  });

  test('named wrap session uses MC_SESSION_NAME and leaves shredding to lifecycle', async () => {
    const seen = [];
    const res = await materialiseVaultForWrap({
      codingSessionId: 'sess_runtime',
      cwd: '/repo',
      launchAdapter: { TOOL_NAME: 'claude' },
      env: { MC_SESSION_NAME: 'data' },
      deps: {
        materialiseVaultBeforeLaunch: async (arg) => {
          seen.push(arg);
          return { ok: true, materialised: [] };
        },
      },
    });
    assert.equal(res.sessionId, 'data');
    assert.equal(res.shouldShredOnExit, false);
    assert.equal(seen[0].sessionId, 'data');
  });

  test('prints soft-degrade hints from vault startup', async () => {
    const writes = [];
    const res = await materialiseVaultForWrap({
      codingSessionId: 'sess_abc',
      cwd: '/repo',
      launchAdapter: { TOOL_NAME: 'claude' },
      env: {},
      stderr: { write: (s) => writes.push(s) },
      deps: {
        materialiseVaultBeforeLaunch: async () => ({
          ok: false,
          reason: 'vault-locked',
          hint: 'vault locked',
          materialised: [],
        }),
      },
    });
    assert.equal(res.ok, false);
    assert.deepEqual(writes, ['mc: vault locked\n']);
  });
});

describe('startupMessageFromGroundingParts', () => {
  test('does not synthesize legacy MEMORO.md startup prompts', () => {
    const msg = startupMessageFromGroundingParts({
      map: null,
      lifecycle: 'This repo has no `MEMORO.md` yet',
    });
    assert.equal(msg, null);
  });

  test('does not send a startup message when a map exists', () => {
    const msg = startupMessageFromGroundingParts({
      map: '# MEMORO.md\nnorth star',
      lifecycle: 'Keeping the map current',
    });
    assert.equal(msg, null);
  });

  test('does not send a startup message for unrelated grounding output', () => {
    assert.equal(startupMessageFromGroundingParts({ map: null, lifecycle: 'role only' }), null);
    assert.equal(startupMessageFromGroundingParts(null), null);
  });
});
