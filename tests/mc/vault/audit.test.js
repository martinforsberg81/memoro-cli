import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { auditVaultExposure } from '../../../src/mc/vault/audit.js';

function writeManifest(dir, sessionId, materialised, hooks = null) {
  const path = join(dir, `${sessionId}-materialised.json`);
  writeFileSync(path, JSON.stringify({
    schema: 1,
    sessionId,
    createdAt: '2026-07-24T10:00:00.000Z',
    materialised,
    ...(hooks ? { hooks } : {}),
  }));
  return path;
}

describe('metadata-only vault exposure audit', () => {
  it('reports leftovers without opening or echoing artifact contents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-audit-'));
    const artifact = join(dir, '.env');
    const sentinel = 'secret-value-must-never-be-read-or-returned';
    writeFileSync(artifact, `API_TOKEN=${sentinel}\n`);
    const manifest = writeManifest(dir, 'sess-a', [{
      tool: 'repo',
      label: 'cloudflare-production',
      location: { type: 'dotenv-file', path: artifact, source: '.env', keys: ['API_TOKEN'], labels: ['cloudflare-production'] },
    }]);

    const result = await auditVaultExposure({
      deps: {
        stateDir: dir,
        readManifest: async (path) => {
          assert.equal(path, manifest, 'audit must only open the metadata manifest');
          return readFile(path, 'utf8');
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.summary.leftovers, 1);
    assert.equal(result.manifests[0].artifacts[0].state, 'leftover');
    assert.equal(result.manifests[0].artifacts[0].label, 'cloudflare-production');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
    assert.equal(existsSync(artifact), true);
  });

  it('cleanup removes only a manifest whose destinations are already absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-audit-clean-'));
    const manifest = writeManifest(dir, 'sess-clean', [{
      tool: 'claude',
      label: 'anthropic',
      location: { type: 'file', path: join(dir, 'already-absent.json') },
    }]);

    const result = await auditVaultExposure({ cleanup: true, deps: { stateDir: dir } });
    assert.equal(result.ok, true);
    assert.equal(result.summary.cleaned_manifests, 1);
    assert.equal(result.manifests[0].cleanup_state, 'removed');
    assert.equal(existsSync(manifest), false);
  });

  it('never follows or removes a symlinked destination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-audit-link-'));
    const target = join(dir, 'target');
    const link = join(dir, 'credential-link');
    writeFileSync(target, 'opaque');
    symlinkSync(target, link);
    const manifest = writeManifest(dir, 'sess-link', [{
      tool: 'codex',
      label: 'openai',
      location: { type: 'file', path: link },
    }]);

    const result = await auditVaultExposure({
      cleanup: true,
      deps: {
        stateDir: dir,
        lstat: async (path) => lstat(path),
      },
    });
    assert.equal(result.manifests[0].artifacts[0].state, 'symlink');
    assert.equal(result.manifests[0].cleanup_state, 'uncertain');
    assert.equal(existsSync(manifest), true);
    assert.equal(existsSync(target), true);
  });

  it('revalidates absent destinations before removing the manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-audit-race-'));
    const destination = join(dir, 'raced-auth.json');
    const manifest = writeManifest(dir, 'sess-race', [{
      tool: 'codex',
      label: 'openai',
      location: { type: 'file', path: destination },
    }]);
    let probes = 0;
    const result = await auditVaultExposure({
      cleanup: true,
      deps: {
        stateDir: dir,
        lstat: async (path) => {
          probes += 1;
          if (probes === 1) {
            const error = new Error('absent');
            error.code = 'ENOENT';
            throw error;
          }
          writeFileSync(destination, 'appeared-after-first-probe');
          return lstat(path);
        },
      },
    });

    assert.equal(result.manifests[0].cleanup_state, 'uncertain');
    assert.equal(existsSync(manifest), true);
    assert.equal(existsSync(destination), true);
  });

  it('rejects unknown manifest fields without reflecting their values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-audit-hostile-'));
    const sentinel = 'hostile-credential-value';
    writeFileSync(join(dir, 'sess-hostile-materialised.json'), JSON.stringify({
      schema: 1,
      sessionId: 'sess-hostile',
      materialised: [],
      access_token: sentinel,
    }));

    const result = await auditVaultExposure({ deps: { stateDir: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'manifest-invalid-shape');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  });

  it('reports a symlinked manifest without following it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-audit-manifest-link-'));
    const outside = join(dir, 'outside.json');
    const sentinel = 'must-not-follow-manifest-symlink';
    writeFileSync(outside, sentinel);
    symlinkSync(outside, join(dir, 'sess-linked-materialised.json'));

    const result = await auditVaultExposure({ deps: { stateDir: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'manifest-symlink');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  });

  it('does not interpret env names or settings files as credential paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-audit-nonfiles-'));
    writeManifest(dir, 'sess-nonfiles', [{
      tool: 'generic',
      label: 'provider-token',
      location: { type: 'env', name: 'PROVIDER_TOKEN' },
    }], {
      hookScriptPath: join(dir, 'absent-hook.sh'),
      installedSettingsPath: join(dir, 'settings.json'),
      settingsCreated: false,
    });
    writeFileSync(join(dir, 'settings.json'), '{}');
    const inspected = [];

    const result = await auditVaultExposure({
      deps: {
        stateDir: dir,
        lstat: async (path) => {
          inspected.push(path);
          return lstat(path);
        },
      },
    });

    assert.equal(result.manifests[0].artifacts.find((a) => a.binding_type === 'env').state, 'unknown');
    assert.equal(result.manifests[0].artifacts.find((a) => a.kind === 'hook-settings').state, 'unknown');
    assert.equal(inspected.includes('PROVIDER_TOKEN'), false);
    assert.equal(inspected.includes(join(dir, 'settings.json')), false);
  });
});
