import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  abortLocalClaudeCredentialDomain,
  closeLocalClaudeCredentialDomain,
  inspectLocalClaudeCredentialDomainPresence,
  loadManagedClaudeUserPermissions,
  prepareLocalClaudeCredentialDomain,
} from '../../../src/mc/credential-domain/local-claude.js';
import {
  validateManagedClaudeDescriptor,
} from '../../../src/mc/provider-adapters/claude-managed.js';
import {
  managedClaudeC1SourceClosureDigest,
} from '../../../src/mc/provider-adapters/claude-managed-certification.js';
import {
  appendManagedGenerationReceiptSync,
  beginManagedGenerationSync,
  inspectManagedGenerationSync,
  managedTransactionFromIntent,
} from '../../../src/mc/managed-generation-journal.js';
import {
  finalizeManagedCredentialDomain,
} from '../../../src/mc/managed-provider-registry.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-claude-domain-')));
  chmodSync(root, 0o700);
  const workspace = join(root, 'workspace');
  const artifacts = join(root, 'artifacts');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const claude = join(artifacts, 'claude');
  const srt = join(artifacts, 'srt.js');
  const certification = join(root, 'certification.json');
  writeFileSync(claude, 'claude\n', { mode: 0o600 });
  writeFileSync(srt, 'srt\n', { mode: 0o600 });
  writeFileSync(certification, '{}\n', { mode: 0o600 });
  const artifactResult = {
    ok: true,
    artifacts: {
      claudeBinary: claude,
      claudeSha256: 'a'.repeat(64),
      claudeVersion: '2.1.220',
      srtModule: srt,
      srtTreeSha256:
        'a3f7a83ffcf7c9308366a731e6914d45b72ba4af91de9ead12d9d2a3ba226578',
      srtVersion: '0.0.67',
    },
  };
  const deps = {
    inspectCertification: () => ({ ok: true, path: certification }),
    verifyArtifacts: () => artifactResult,
    inspectCustody: async () => ({
      ok: true,
      secretId: 'vault-secret',
      revision: 7,
    }),
    loadUserClaudePermissions: () => ({
      ok: true,
      permissions: {
        defaultMode: 'auto',
        allow: ['Bash(git status)'],
        ask: ['Bash(git push *)'],
        deny: ['Read(./.env)'],
        disableBypassPermissionsMode: 'disable',
      },
    }),
  };
  return {
    root,
    workspace,
    deps,
    artifactResult,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('managed Claude domain is isolated, resumable, and removed only after archive', async () => {
  const built = fixture();
  const codingSessionId = 'sess_managed_claude';
  const firstGeneration = '687c338a-1ed4-4c20-9828-1f9a39d37067';
  const runtimeGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
  try {
    const prepared = await prepareLocalClaudeCredentialDomain({
      codingSessionId,
      domainGeneration: firstGeneration,
      cwd: built.workspace,
      tool: 'claude-code',
      root: built.root,
      env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
      deps: built.deps,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.env.CLAUDE_CONFIG_DIR, prepared.descriptor.claude_config_dir);
    assert.equal(prepared.env.MEMORO_TOKEN, undefined);
    assert.equal(validateManagedClaudeDescriptor(prepared.descriptor, {
      verifyArtifacts: () => built.artifactResult,
    }).ok, true);

    const transcript = join(
      prepared.descriptor.claude_config_dir,
      'projects',
      '-workspace',
      'native-session.jsonl',
    );
    mkdirSync(dirname(transcript), { recursive: true, mode: 0o700 });
    writeFileSync(transcript, '{"type":"session"}\n', { mode: 0o600 });
    const closed = await closeLocalClaudeCredentialDomain({
      descriptor: prepared.descriptor,
      providerArtifact: {
        schema: 'mc-provider-artifact-v1',
        coding_session_id: codingSessionId,
        runtime_generation: runtimeGeneration,
        tool: 'claude-code',
        provider_session_id: 'native-session',
        transcript_path: transcript,
        captured_at: '2026-07-29T10:00:00.000Z',
      },
      deps: built.deps,
    });
    assert.equal(closed.ok, true);
    assert.equal(existsSync(prepared.descriptor.domain_path), false);
    assert.equal(existsSync(prepared.descriptor.executor_root), false);

    const resumed = await prepareLocalClaudeCredentialDomain({
      codingSessionId,
      domainGeneration: 'd5e6439f-54e2-493b-a10f-5e5e014a2904',
      providerSessionId: 'native-session',
      cwd: built.workspace,
      tool: 'claude-code',
      root: built.root,
      env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
      deps: built.deps,
    });
    assert.equal(resumed.ok, true);
    const restored = join(
      resumed.descriptor.claude_config_dir,
      'projects',
      '-workspace',
      'native-session.jsonl',
    );
    assert.equal(readFileSync(restored, 'utf8'), '{"type":"session"}\n');
    assert.equal(abortLocalClaudeCredentialDomain({
      descriptor: resumed.descriptor,
    }).ok, true);
    assert.deepEqual(inspectLocalClaudeCredentialDomainPresence({
      root: built.root,
      codingSessionId,
      deps: built.deps,
    }), { kind: 'absent' });
  } finally {
    built.cleanup();
  }
});

test('managed Claude preparation fails before domain creation without C1 certification', async () => {
  const built = fixture();
  try {
    const result = await prepareLocalClaudeCredentialDomain({
      codingSessionId: 'sess_managed_claude',
      domainGeneration: '687c338a-1ed4-4c20-9828-1f9a39d37067',
      cwd: built.workspace,
      tool: 'claude-code',
      root: built.root,
      deps: {
        ...built.deps,
        inspectCertification: () => ({
          ok: false,
          reason: 'managed-claude-certification-missing',
        }),
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'managed-claude-certification-missing');
    assert.deepEqual(inspectLocalClaudeCredentialDomainPresence({
      root: built.root,
      codingSessionId: 'sess_managed_claude',
      deps: built.deps,
    }), { kind: 'absent' });
  } finally {
    built.cleanup();
  }
});

test('managed Claude reads only bounded user permissions from settings', () => {
  const built = fixture();
  const settingsPath = join(built.root, 'user-settings.json');
  try {
    writeFileSync(settingsPath, `${JSON.stringify({
      permissions: {
        defaultMode: 'auto',
        allow: ['Bash(git status)'],
        ask: ['Bash(git push *)'],
        deny: ['Read(./.env)'],
      },
      hooks: { PreToolUse: [{ command: 'must-not-cross' }] },
      env: { SECRET: 'must-not-cross' },
      skipDangerousModePermissionPrompt: true,
    })}\n`, { mode: 0o600 });
    assert.deepEqual(loadManagedClaudeUserPermissions({ settingsPath }), {
      ok: true,
      permissions: {
        defaultMode: 'auto',
        allow: ['Bash(git status)'],
        ask: ['Bash(git push *)'],
        deny: ['Read(./.env)'],
        disableBypassPermissionsMode: 'disable',
      },
    });

    writeFileSync(settingsPath, `${JSON.stringify({
      permissions: { defaultMode: 'bypassPermissions' },
    })}\n`, { mode: 0o600 });
    assert.equal(loadManagedClaudeUserPermissions({ settingsPath }).reason,
      'managed-provider-user-permissions-invalid');
  } finally {
    built.cleanup();
  }
});

test('central finalization closes a fresh Claude exit only after an empty transcript proof', async () => {
  const built = fixture();
  const codingSessionId = 'sess_claude_empty';
  const runtimeGeneration = '687c338a-1ed4-4c20-9828-1f9a39d37067';
  try {
    const prepared = await prepareLocalClaudeCredentialDomain({
      codingSessionId,
      domainGeneration: runtimeGeneration,
      cwd: built.workspace,
      tool: 'claude-code',
      root: built.root,
      deps: built.deps,
    });
    assert.equal(prepared.ok, true);
    const started = beginManagedGenerationSync({
      mcHomeDir: built.root,
      codingSessionId,
      runtimeGeneration,
      mode: 'fresh',
      tool: 'claude-code',
      recordedAt: '2026-07-29T10:00:00.000Z',
    });
    const append = (phase, data) => appendManagedGenerationReceiptSync({
      mcHomeDir: built.root,
      phase,
      codingSessionId,
      runtimeGeneration,
      intentDigest: started.intent.intent_digest,
      recordedAt: '2026-07-29T10:00:00.000Z',
      data,
    });
    append('domain-ready', {
      domain_generation: prepared.descriptor.generation,
      manifest_digest: prepared.descriptor.manifest_sha256,
    });
    append('broker-accepted', {});
    append('live', {});
    append('exited', { exit_code: 0, signal: null });

    const finalized = await finalizeManagedCredentialDomain({
      root: built.root,
      descriptor: prepared.descriptor,
      providerArtifact: null,
      managedTransaction: managedTransactionFromIntent(started.intent),
      deps: built.deps,
    });
    assert.equal(finalized.ok, true);
    assert.equal(finalized.provider_session_state, null);
    const state = inspectManagedGenerationSync({
      mcHomeDir: built.root,
      codingSessionId,
      runtimeGeneration,
    });
    assert.equal(state.phase, 'ready');
    assert.equal(state.receipts.ready.data.provider_session_id, null);
    assert.equal(existsSync(prepared.descriptor.domain_path), false);
  } finally {
    built.cleanup();
  }
});
