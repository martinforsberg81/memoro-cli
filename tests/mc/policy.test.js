import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEffectivePolicy } from '../../src/mc/policy.js';

describe('resolveEffectivePolicy', () => {
  test('Codex defaults to tool-owned native auth and no vault target', () => {
    const policy = resolveEffectivePolicy({ entry: { tool: 'codex' } });
    assert.equal(policy.permissions.rendered_for, 'codex');
    assert.equal(policy.permissions.source, 'default');
    assert.equal(policy.secrets.vault_required, false);
    assert.equal(policy.secrets.native_auth_owned_by_tool, true);
    assert.deepEqual(policy.secrets.materialisation_targets, []);
  });

  test('Claude reports the current legacy Anthropic provider mapping', () => {
    const policy = resolveEffectivePolicy({ entry: { tool: 'claude' } });
    assert.equal(policy.permissions.rendered_for, 'claude');
    assert.equal(policy.secrets.vault_required, true);
    assert.equal(policy.secrets.native_auth_owned_by_tool, false);
    assert.deepEqual(policy.secrets.materialisation_targets, [{
      tool: 'claude',
      provider: 'anthropic',
      source: 'legacy-provider-mapping',
      target_auth_mode: 'api_key',
    }]);
  });

  test('session policy overrides config/default permission profile without changing selected tool', () => {
    const policy = resolveEffectivePolicy({
      entry: {
        tool: 'codex',
        policy: { permissions: { profile: 'trusted', approval: 'never' } },
      },
      config: {
        policy: { permissions: { profile: 'cautious' } },
      },
    });
    assert.equal(policy.permissions.source, 'session');
    assert.equal(policy.permissions.profile, 'trusted');
    assert.equal(policy.permissions.approval, 'never');
    assert.equal(policy.permissions.rendered_for, 'codex');
  });

  test('adapter ids normalise to registry tool names', () => {
    assert.equal(resolveEffectivePolicy({ tool: 'claude-code' }).permissions.rendered_for, 'claude');
    assert.equal(resolveEffectivePolicy({ tool: 'gemini-cli' }).permissions.rendered_for, 'gemini');
  });
});
