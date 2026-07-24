import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatPolicySummary,
  readRepoPolicy,
  resolveEffectivePolicy,
  unsupportedPermissionFields,
} from '../../src/mc/policy.js';

describe('resolveEffectivePolicy', () => {
  test('Codex defaults to tool-owned native auth and no vault target', () => {
    const policy = resolveEffectivePolicy({ entry: { tool: 'codex' } });
    assert.equal(policy.permissions.rendered_for, 'codex');
    assert.equal(policy.permissions.source, 'default');
    assert.deepEqual(policy.adapter_support, {
      tool: 'codex',
      permissions: {
        profile: 'unsupported',
        workspace: 'supported',
        network: 'unsupported',
        approval: 'supported',
        secrets: 'unsupported',
      },
    });
    assert.deepEqual(policy.explicit_permissions, []);
    assert.equal(policy.secrets.vault_required, false);
    assert.equal(policy.secrets.native_auth_owned_by_tool, true);
    assert.deepEqual(policy.secrets.materialisation_targets, []);
  });

  test('Claude owns native auth and has no vault materialisation target', () => {
    const policy = resolveEffectivePolicy({ entry: { tool: 'claude' } });
    assert.equal(policy.permissions.rendered_for, 'claude');
    assert.equal(policy.secrets.vault_required, false);
    assert.equal(policy.secrets.native_auth_owned_by_tool, true);
    assert.deepEqual(policy.secrets.materialisation_targets, []);
  });

  test('policy source precedence is session > repo > global > default', () => {
    const policy = resolveEffectivePolicy({
      entry: {
        tool: 'codex',
        policy: { permissions: { profile: 'trusted', approval: 'never' } },
      },
      repoPolicy: {
        permissions: { profile: 'repo' },
      },
      config: {
        policy: { permissions: { profile: 'global' } },
      },
    });
    assert.equal(policy.permissions.source, 'session');
    assert.equal(policy.permissions.profile, 'trusted');
    assert.equal(policy.permissions.approval, 'never');
    assert.deepEqual(policy.explicit_permissions, ['profile', 'approval']);
    assert.equal(policy.permissions.rendered_for, 'codex');
  });

  test('repo policy wins over global policy when session has no override', () => {
    const policy = resolveEffectivePolicy({
      entry: { tool: 'codex' },
      repoPolicy: { permissions: { profile: 'repo-trusted', network: 'enabled' } },
      config: { policy: { permissions: { profile: 'global-cautious', network: 'disabled' } } },
    });
    assert.equal(policy.permissions.source, 'repo');
    assert.equal(policy.permissions.profile, 'repo-trusted');
    assert.equal(policy.permissions.network, 'enabled');
  });

  test('global policy wins over default when no session/repo policy exists', () => {
    const policy = resolveEffectivePolicy({
      entry: { tool: 'codex' },
      config: { policy: { permissions: { profile: 'global-cautious', approval: 'on-request' } } },
    });
    assert.equal(policy.permissions.source, 'global');
    assert.equal(policy.permissions.profile, 'global-cautious');
    assert.equal(policy.permissions.approval, 'on-request');
  });

  test('adapter ids normalise to registry tool names', () => {
    assert.equal(resolveEffectivePolicy({ tool: 'claude-code' }).permissions.rendered_for, 'claude');
    assert.equal(resolveEffectivePolicy({ tool: 'gemini-cli' }).permissions.rendered_for, 'gemini');
  });

  test('tool override changes rendering target without changing permission intent', () => {
    const entry = {
      tool: 'claude',
      policy: { permissions: { profile: 'trusted', network: 'enabled', approval: 'never' } },
    };
    const claude = resolveEffectivePolicy({ entry, tool: 'claude' });
    const codex = resolveEffectivePolicy({ entry, tool: 'codex' });
    const stripRenderTarget = (policy) => {
      const { rendered_for, ...intent } = policy.permissions;
      return intent;
    };
    assert.deepEqual(stripRenderTarget(codex), stripRenderTarget(claude));
    assert.equal(claude.permissions.rendered_for, 'claude');
    assert.equal(codex.permissions.rendered_for, 'codex');
  });
});

describe('policy formatting helpers', () => {
  test('summarises native-auth and unsupported permission fields', () => {
    const policy = resolveEffectivePolicy({ entry: { tool: 'codex' } });
    assert.deepEqual(unsupportedPermissionFields(policy), [
      'profile',
      'network',
      'secrets',
    ]);
    assert.equal(
      formatPolicySummary(policy),
      'codex: native auth owned by tool; no vault target; permissions unsupported: profile, network, secrets',
    );
  });
});

describe('readRepoPolicy', () => {
  test('reads .mc/policy.json from a worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-policy-'));
    try {
      mkdirSync(join(dir, '.mc'), { recursive: true });
      writeFileSync(join(dir, '.mc', 'policy.json'), JSON.stringify({
        permissions: { profile: 'repo-trusted' },
      }));
      const policy = readRepoPolicy({ worktreePath: dir });
      assert.equal(policy.permissions.profile, 'repo-trusted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null for missing or malformed repo policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-policy-bad-'));
    try {
      assert.equal(readRepoPolicy({ worktreePath: dir }), null);
      mkdirSync(join(dir, '.mc'), { recursive: true });
      writeFileSync(join(dir, '.mc', 'policy.json'), '{bad json');
      assert.equal(readRepoPolicy({ worktreePath: dir }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
