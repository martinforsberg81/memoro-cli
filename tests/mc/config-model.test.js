import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  effectiveConfigValues,
  readRepoLocalConfig,
  readRepoPolicyConfig,
  resolveEffectiveConfig,
} from '../../src/mc/config-model.js';

describe('resolveEffectiveConfig', () => {
  test('preference fields use CLI/env/session/local/repo/global/default precedence shape', () => {
    const effective = resolveEffectiveConfig({
      globalConfig: { defaultTool: 'claude-code', language: 'English' },
      repoPolicy: { defaultTool: 'claude-code', language: 'Spanish' },
      localConfig: { defaultTool: 'codex' },
      cliConfig: { language: 'Swedish' },
    });
    assert.deepEqual(effective.defaultTool, {
      value: 'codex',
      source: '.mc/local.json',
    });
    assert.deepEqual(effective.language, {
      value: 'Swedish',
      source: 'cli',
    });
  });

  test('package defaults select codex when no user config exists', () => {
    const effective = resolveEffectiveConfig({});
    assert.deepEqual(effective.defaultTool, {
      value: 'codex',
      source: 'package-defaults',
    });
  });

  test('global legacy config.policy.permissions is normalised into permissions', () => {
    const effective = resolveEffectiveConfig({
      globalConfig: {
        policy: { permissions: { approval: 'on-request' } },
      },
    });
    assert.equal(effective.permissions.approval.value, 'on-request');
    assert.equal(effective.permissions.approval.source, '~/.memoro/config.json');
    assert.equal('rank' in effective.permissions.approval, false);
  });

  test('safety floors cannot be silently weakened by local config', () => {
    const effective = resolveEffectiveConfig({
      repoPolicy: {
        permissions: { approval: 'on-request' },
        dataAccess: { cloudflare: { guard: 'block-all' } },
      },
      localConfig: {
        permissions: { approval: 'never' },
        dataAccess: { cloudflare: { guard: 'off' } },
      },
    });
    assert.equal(effective.permissions.approval.value, 'on-request');
    assert.equal(effective.permissions.approval.source, '.mc/policy.json');
    assert.equal(effective.dataAccess.cloudflare.guard.value, 'block-all');
    assert.equal(effective.dataAccess.cloudflare.guard.source, '.mc/policy.json');
    assert.equal(effective.warnings.filter((w) => w.code === 'safety-weakening-ignored').length, 2);
  });

  test('local config can tighten safety policy', () => {
    const effective = resolveEffectiveConfig({
      repoPolicy: {
        permissions: { approval: 'on-request' },
        dataAccess: { cloudflare: { guard: 'block-sensitive' } },
      },
      localConfig: {
        permissions: { approval: 'untrusted' },
        dataAccess: { cloudflare: { guard: 'block-all' } },
      },
    });
    assert.equal(effective.permissions.approval.value, 'untrusted');
    assert.equal(effective.permissions.approval.source, '.mc/local.json');
    assert.equal(effective.dataAccess.cloudflare.guard.value, 'block-all');
    assert.equal(effective.dataAccess.cloudflare.guard.source, '.mc/local.json');
    assert.deepEqual(effective.warnings, []);
  });

  test('repo policy can allow local weakening down to the package safety floor', () => {
    const effective = resolveEffectiveConfig({
      repoPolicy: {
        dataAccess: {
          cloudflare: {
            guard: 'block-all',
            allowLocalWeakening: true,
          },
        },
      },
      localConfig: {
        dataAccess: { cloudflare: { guard: 'block-sensitive' } },
      },
    });
    assert.equal(effective.dataAccess.cloudflare.guard.value, 'block-sensitive');
    assert.equal(effective.dataAccess.cloudflare.guard.source, '.mc/local.json');
    assert.deepEqual(effective.warnings, []);
  });

  test('repo allowLocalWeakening still cannot weaken below package defaults', () => {
    const effective = resolveEffectiveConfig({
      repoPolicy: {
        dataAccess: {
          cloudflare: {
            guard: 'block-all',
            allowLocalWeakening: true,
          },
        },
      },
      localConfig: {
        dataAccess: { cloudflare: { guard: 'off' } },
      },
    });
    assert.equal(effective.dataAccess.cloudflare.guard.value, 'block-all');
    assert.equal(effective.warnings[0].code, 'safety-weakening-ignored');
  });

  test('returns plain effective values for callers that need a value-only shape', () => {
    const effective = resolveEffectiveConfig({
      globalConfig: { defaultTool: 'codex' },
      repoPolicy: { permissions: { workspace: 'read-only' } },
    });
    assert.deepEqual(effectiveConfigValues(effective), {
      defaultTool: 'codex',
      grounding: {
        includeRoadmap: true,
        includeCoordinatorRole: true,
        includeLens: true,
      },
      permissions: {
        profile: 'default',
        workspace: 'read-only',
        network: 'tool-default',
        approval: 'tool-default',
        secrets: 'mc-vault-explicit',
      },
      dataAccess: {
        cloudflare: {
          guard: 'block-sensitive',
          approvedScripts: [],
          allowLocalWeakening: false,
        },
      },
      instructions: { mode: 'preserve' },
    });
  });

  test('unknown safety values are ignored with warnings', () => {
    const effective = resolveEffectiveConfig({
      repoPolicy: { permissions: { workspace: 'moon' } },
    });
    assert.equal(effective.permissions.workspace.value, 'worktree');
    assert.equal(effective.permissions.workspace.source, 'package-defaults');
    assert.deepEqual(effective.warnings, [{
      code: 'unknown-config-value',
      path: 'permissions.workspace',
      source: '.mc/policy.json',
      value: 'moon',
    }]);
  });
});

describe('repo config readers', () => {
  test('readRepoLocalConfig reads .mc/local.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-local-config-'));
    try {
      mkdirSync(join(dir, '.mc'), { recursive: true });
      writeFileSync(join(dir, '.mc', 'local.json'), JSON.stringify({
        defaultTool: 'codex',
      }));
      const res = readRepoLocalConfig({ worktreePath: dir });
      assert.equal(res.config.defaultTool, 'codex');
      assert.deepEqual(res.warnings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readRepoPolicyConfig reports malformed JSON as a warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-policy-config-'));
    try {
      mkdirSync(join(dir, '.mc'), { recursive: true });
      writeFileSync(join(dir, '.mc', 'policy.json'), '{bad json');
      const res = readRepoPolicyConfig({ worktreePath: dir });
      assert.equal(res.config, null);
      assert.equal(res.warnings[0].code, 'invalid-config-json');
      assert.equal(res.warnings[0].path, '.mc/policy.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
