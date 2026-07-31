import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test, { describe } from 'node:test';

import {
  LOCAL_CODEX_BOUNDARY_UNAVAILABLE,
  abortLocalCodexCredentialDomain,
  buildManagedCodexProviderEnv,
  closeLocalCodexCredentialDomain,
  confirmLocalCodexCredentialDomainAbsent,
  inspectCodexRelease,
  inspectLegacyLocalCodexResumeAbsence,
  inspectLocalCodexProviderAbsence,
  inspectPreparedLocalCodexCredentialDomain,
  inspectQuarantinedLocalCodexCredentialDomain,
  loadCustodyCodexAuth,
  managedBoundarySocketPath,
  persistManagedCodexSessionState,
  persistCustodyCodexAuth,
  prepareLocalCodexCredentialDomain,
  renderManagedCodexConfig,
  validateBoundaryReport,
} from '../../../src/mc/credential-domain/local-codex.js';
import {
  MANAGED_CODEX_PROFILE,
  MANAGED_CODEX_TEAM_ID,
  MANAGED_CODEX_VERSION,
} from '../../../src/mc/provider-adapters/codex-managed.js';
import { RUNTIME_SECRET_ENV_NAMES } from '../../../src/mc/runtime-secrets.js';
import { importVaultKey } from '../../../src/mc/vault/client-crypto.js';
import {
  decryptEnvelopeSecret,
  encryptEnvelopeSecret,
  mintCustodyRoot,
} from '../../../src/mc/vault/custody-crypto.js';
import {
  appendManagedGenerationReceiptSync,
  beginManagedGenerationSync,
  inspectManagedGenerationSync,
  managedTransactionFromIntent,
} from '../../../src/mc/managed-generation-journal.js';
import {
  finalizeManagedCredentialDomain,
} from '../../../src/mc/managed-provider-registry.js';

const AUTH_CANARY = 'codex-managed-auth-canary';
const DOMAIN_GENERATION = '687c338a-1ed4-4c20-9828-1f9a39d37067';
const AUTH_BODY = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: AUTH_CANARY },
});

describe('local Codex credential domain', () => {
  test('recovers a legacy domain after Codex appends native project trust', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-local-domain-legacy-config-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mc-local-workspace-legacy-config-'));
    const nativeBinary = join(root, 'codex');
    writeFileSync(nativeBinary, 'signed-binary', { mode: 0o500 });
    try {
      const prepared = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_legacy_config',
        domainGeneration: DOMAIN_GENERATION,
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: join(root, 'missing-user-codex-home') },
        deps: {
          inspectCodexRelease: () => ({
            ok: true,
            nativeBinary,
            version: MANAGED_CODEX_VERSION,
            teamId: MANAGED_CODEX_TEAM_ID,
            sha256: 'a'.repeat(64),
          }),
          verifyBoundary: () => ({ ok: true }),
          loadCustodyAuth: () => ({
            ok: true,
            secretId: 'secret_legacy_config',
            authBody: AUTH_BODY,
          }),
        },
      });
      assert.equal(prepared.ok, true);

      const legacyConfigPath = join(prepared.descriptor.codex_home, 'config.toml');
      const originalConfig = readFileSync(legacyConfigPath, 'utf8');
      const manifest = JSON.parse(readFileSync(prepared.descriptor.manifest_path, 'utf8'));
      manifest.provider_config_path = legacyConfigPath;
      manifest.provider_config_sha256 = createHash('sha256')
        .update(originalConfig)
        .digest('hex');
      writeFileSync(
        prepared.descriptor.manifest_path,
        `${JSON.stringify(manifest)}\n`,
        { mode: 0o600 },
      );
      writeFileSync(legacyConfigPath, [
        originalConfig,
        `[projects."${cwd}"]`,
        'trust_level = "trusted"',
        '',
      ].join('\n'), { mode: 0o600 });

      const recovered = inspectPreparedLocalCodexCredentialDomain({
        root,
        codingSessionId: 'sess_legacy_config',
      });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.descriptor.provider_config_path, legacyConfigPath);

      const relativeTranscriptPath = join(
        'sessions',
        '2026',
        '07',
        '29',
        'rollout-2026-07-29T10-00-00-provider_legacy.jsonl',
      );
      const sessionPart = `sess_legacy_config-${
        createHash('sha256').update('sess_legacy_config').digest('hex').slice(0, 12)
      }`;
      const stateRoot = join(root, 'provider-session-state', 'codex', sessionPart);
      const archivedTranscriptPath = join(stateRoot, relativeTranscriptPath);
      const restoredTranscriptPath = join(
        prepared.descriptor.codex_home,
        relativeTranscriptPath,
      );
      mkdirSync(dirname(archivedTranscriptPath), { recursive: true, mode: 0o700 });
      mkdirSync(dirname(restoredTranscriptPath), { recursive: true, mode: 0o700 });
      writeFileSync(archivedTranscriptPath, '{"type":"session_meta"}\n', { mode: 0o600 });
      writeFileSync(restoredTranscriptPath, '{"type":"session_meta"}\n', { mode: 0o600 });
      writeFileSync(join(stateRoot, 'manifest.json'), `${JSON.stringify({
        schema: 'mc-managed-codex-session-state/v1',
        coding_session_id: 'sess_legacy_config',
        provider_session_id: 'provider_legacy',
        relative_transcript_path: relativeTranscriptPath,
      })}\n`, { mode: 0o600 });

      const absence = inspectLegacyLocalCodexResumeAbsence({
        root,
        descriptor: recovered.descriptor,
        providerSessionId: 'provider_legacy',
      });
      assert.equal(absence.ok, true);
      assert.equal(absence.transcript_path, restoredTranscriptPath);
      assert.match(absence.evidence_digest, /^[a-f0-9]{64}$/u);

      writeFileSync(restoredTranscriptPath, '{"type":"changed"}\n', { mode: 0o600 });
      assert.equal(inspectLegacyLocalCodexResumeAbsence({
        root,
        descriptor: recovered.descriptor,
        providerSessionId: 'provider_legacy',
      }).reason, 'managed-legacy-absence-restored-state-changed');

      writeFileSync(prepared.descriptor.provider_hook_path, '{}\n', { mode: 0o600 });
      assert.equal(inspectPreparedLocalCodexCredentialDomain({
        root,
        codingSessionId: 'sess_legacy_config',
      }).reason, 'managed-recovery-domain-mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('does not mistake a broken lease symlink for confirmed cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-local-domain-absence-'));
    const codingSessionId = 'sess_absence';
    const domainGeneration = '687c338a-1ed4-4c20-9828-1f9a39d37067';
    const sessionPart = `${codingSessionId}-${
      createHash('sha256').update(codingSessionId).digest('hex').slice(0, 12)
    }`;
    const leaseRoot = join(root, 'credential-domain-leases', 'codex');
    const leasePath = join(leaseRoot, `${sessionPart}.json`);
    mkdirSync(leaseRoot, { recursive: true });
    symlinkSync(join(root, 'missing-target'), leasePath);
    try {
      assert.deepEqual(confirmLocalCodexCredentialDomainAbsent({
        root,
        codingSessionId,
        domainGeneration,
      }), {
        ok: false,
        reason: 'managed-domain-cleanup-descriptor-required',
      });
      unlinkSync(leasePath);
      assert.deepEqual(confirmLocalCodexCredentialDomainAbsent({
        root,
        codingSessionId,
        domainGeneration,
      }), {
        ok: true,
        absent: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('verifies release and boundary before custody, then returns only safe launch metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-local-domain-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mc-local-workspace-'));
    const userCodexHome = join(root, 'user-codex-home');
    const userRules = join(userCodexHome, 'rules');
    mkdirSync(userRules, { recursive: true, mode: 0o700 });
    writeFileSync(join(userCodexHome, 'config.toml'), [
      'approvals_reviewer = "guardian_subagent"',
      'model = "user-selected-model"',
      '',
    ].join('\n'), { mode: 0o600 });
    writeFileSync(join(userCodexHome, 'hooks.json'), `${JSON.stringify({
      hooks: {
        SessionStart: [{
          _memoro: 'memoro-cli',
          matcher: 'startup|resume',
          hooks: [{
            type: 'command',
            command: 'memoro-cli provider-artifact capture --tool codex',
          }],
        }],
        Stop: [{
          hooks: [{
            type: 'command',
            command: '/usr/bin/true',
          }],
        }],
      },
    })}\n`, { mode: 0o600 });
    writeFileSync(join(userRules, 'default.rules'), 'prefix_rule(pattern=["git"], decision="allow")\n', {
      mode: 0o600,
    });
    const nativeBinary = join(root, 'codex');
    writeFileSync(nativeBinary, 'signed-binary', { mode: 0o500 });
    const calls = [];
    let persisted = null;
    try {
      const prepared = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_managed1',
        domainGeneration: DOMAIN_GENERATION,
        githubCapability: true,
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: userCodexHome },
        deps: {
          inspectCodexRelease: () => {
            calls.push('release');
            return {
              ok: true,
              nativeBinary,
              version: MANAGED_CODEX_VERSION,
              teamId: MANAGED_CODEX_TEAM_ID,
              sha256: 'a'.repeat(64),
            };
          },
          resolveVaultProbeTarget: () => ({
            binPath: '/opt/homebrew/bin/mc',
            nodePath: '/opt/homebrew/bin/node',
            entryPath: '/opt/homebrew/lib/node_modules/memoro-cli/src/mc-cli.js',
          }),
          verifyBoundary: ({ codexHome }) => {
            calls.push('boundary');
            const userConfig = readFileSync(join(codexHome, 'config.toml'), 'utf8');
            const managedConfig = readFileSync(
              join(codexHome, `${MANAGED_CODEX_PROFILE}.config.toml`),
              'utf8',
            );
            assert.match(userConfig, /approvals_reviewer = "guardian_subagent"/);
            assert.match(userConfig, /model = "user-selected-model"/);
            assert.doesNotMatch(userConfig, /default_permissions/);
            assert.equal(realpathSync(join(codexHome, 'rules')), realpathSync(userRules));
            assert.match(
              readFileSync(join(codexHome, 'rules', 'default.rules'), 'utf8'),
              /decision="allow"/,
            );
            assert.match(
              managedConfig,
              new RegExp(`default_permissions = "${MANAGED_CODEX_PROFILE}"`),
            );
            assert.ok(managedConfig.includes([
              `[projects."${cwd}"]`,
              'trust_level = "untrusted"',
            ].join('\n')));
            assert.doesNotMatch(managedConfig, /trust_level = "trusted"/);
            assert.doesNotMatch(managedConfig, /hooks\s*=/);
            assert.deepEqual(
              JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')),
              {
                hooks: {
                  Stop: [{
                    hooks: [{
                      type: 'command',
                      command: '/usr/bin/true',
                    }],
                  }],
                },
              },
            );
            assert.ok(managedConfig.includes(`"${join(root, 'sess_managed1.sock')}" = "allow"`));
            assert.ok(managedConfig.includes(
              '"/opt/homebrew/lib/node_modules/memoro-cli" = "deny"',
            ));
            assert.ok(managedConfig.includes(
              '"/opt/homebrew/bin/mc" = "deny"',
            ));
            assert.ok(managedConfig.includes(
              '"/opt/homebrew/lib/node_modules/memoro-cli/src/mc-cli.js" = "deny"',
            ));
            assert.match(
              managedConfig,
              /\/src\/mc\/github-shim\.js" = "read"/,
            );
            assert.doesNotMatch(
              managedConfig,
              /\/src\/mc-cli\.js" = "read"/,
            );
            assert.doesNotMatch(managedConfig, /memoro-canary|codex-managed-auth-canary/);
            return { ok: true };
          },
          loadCustodyAuth: () => {
            calls.push('custody');
            return { ok: true, secretId: 'secret_1', authBody: AUTH_BODY };
          },
        },
      });

      assert.equal(prepared.ok, true);
      assert.equal(prepared.descriptor.generation, DOMAIN_GENERATION);
      assert.deepEqual(calls, ['release', 'boundary', 'custody']);
      assert.equal(prepared.portable, true);
      assert.equal(prepared.state, 'managed-ready');
      assert.equal(prepared.env.CODEX_HOME, prepared.descriptor.codex_home);
      assert.equal(prepared.env.MEMORO_TOKEN, undefined);
      assert.equal(JSON.stringify(prepared).includes(AUTH_CANARY), false);
      assert.equal(
        createHash('sha256')
          .update(readFileSync(prepared.descriptor.provider_hook_path, 'utf8'))
          .digest('hex'),
        prepared.descriptor.provider_hook_sha256,
      );
      assert.equal(JSON.parse(readFileSync(
        join(prepared.descriptor.codex_home, 'auth.json'),
        'utf8',
      )).tokens.access_token, AUTH_CANARY);
      const freshAbsence = inspectLocalCodexProviderAbsence({
        root,
        descriptor: prepared.descriptor,
        generation: {
          intent: {
            data: {
              mode: 'fresh',
              tool: 'codex',
              resume_provider_session_id: null,
            },
          },
        },
      });
      assert.equal(freshAbsence.ok, true);
      assert.match(freshAbsence.evidence_digest, /^[a-f0-9]{64}$/u);
      const providerSessionId = '019fade4-e16b-70f0-9e5f-559cf9454cf8';
      const transcriptPath = join(
        prepared.descriptor.codex_home,
        'sessions',
        '2026',
        '07',
        '29',
        `rollout-2026-07-29T10-00-00-${providerSessionId}.jsonl`,
      );
      mkdirSync(dirname(transcriptPath), { recursive: true, mode: 0o700 });
      writeFileSync(transcriptPath, '{"type":"session_meta"}\n', { mode: 0o600 });
      assert.equal(inspectLocalCodexProviderAbsence({
        root,
        descriptor: prepared.descriptor,
        generation: {
          intent: {
            data: {
              mode: 'fresh',
              tool: 'codex',
              resume_provider_session_id: null,
            },
          },
        },
      }).reason, 'managed-provider-absence-artifact-present');
      const quarantined = inspectQuarantinedLocalCodexCredentialDomain({
        root,
        codingSessionId: 'sess_managed1',
        providerArtifact: {
          coding_session_id: 'sess_managed1',
          runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
          provider_session_id: providerSessionId,
          transcript_path: transcriptPath,
        },
      });
      assert.equal(quarantined.ok, true);
      assert.equal(quarantined.descriptor.manifest_path, prepared.descriptor.manifest_path);
      assert.equal(quarantined.descriptor.manifest_sha256, prepared.descriptor.manifest_sha256);

      const providerArtifact = {
        coding_session_id: 'sess_managed1',
        runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
        provider_session_id: providerSessionId,
        transcript_path: transcriptPath,
      };
      const archived = persistManagedCodexSessionState({
        root,
        descriptor: prepared.descriptor,
        providerArtifact,
      });
      assert.equal(archived.ok, true);
      let archiveRoot = dirname(archived.state.transcript_path);
      while (basename(archiveRoot) !== providerArtifact.runtime_generation) {
        archiveRoot = dirname(archiveRoot);
      }
      rmSync(join(archiveRoot, 'manifest.json'));
      const resumedAfterTranscriptPublication = persistManagedCodexSessionState({
        root,
        descriptor: prepared.descriptor,
        providerArtifact,
      });
      assert.equal(resumedAfterTranscriptPublication.ok, true);
      assert.equal(
        resumedAfterTranscriptPublication.state.archive_digest,
        archived.state.archive_digest,
      );
      rmSync(join(dirname(dirname(archiveRoot)), 'current.json'));
      const resumedAfterManifestPublication = persistManagedCodexSessionState({
        root,
        descriptor: prepared.descriptor,
        providerArtifact,
      });
      assert.equal(resumedAfterManifestPublication.ok, true);
      assert.equal(
        resumedAfterManifestPublication.state.archive_digest,
        archived.state.archive_digest,
      );
      const managed = beginManagedGenerationSync({
        mcHomeDir: root,
        codingSessionId: 'sess_managed1',
        runtimeGeneration: providerArtifact.runtime_generation,
        mode: 'fresh',
        tool: 'codex',
        recordedAt: '2026-07-29T10:00:00.000Z',
      });
      const appendReceipt = (phase, data) => appendManagedGenerationReceiptSync({
        mcHomeDir: root,
        phase,
        codingSessionId: 'sess_managed1',
        runtimeGeneration: providerArtifact.runtime_generation,
        intentDigest: managed.intent.intent_digest,
        recordedAt: '2026-07-29T10:00:00.000Z',
        data,
      });
      appendReceipt('domain-ready', {
        domain_generation: prepared.descriptor.generation,
        manifest_digest: prepared.descriptor.manifest_sha256,
      });
      appendReceipt('broker-accepted', {});
      appendReceipt('live', {});
      appendReceipt('provider-artifact', {
        provider_session_id: providerSessionId,
        artifact_digest: 'a'.repeat(64),
        tool: 'codex',
        transcript_path: transcriptPath,
        captured_at: '2026-07-29T10:00:00.000Z',
      });
      appendReceipt('exited', { exit_code: 0, signal: null });

      const overlapping = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_managed1',
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: userCodexHome },
        deps: {
          inspectCodexRelease: () => ({
            ok: true,
            nativeBinary,
            version: MANAGED_CODEX_VERSION,
            teamId: MANAGED_CODEX_TEAM_ID,
            sha256: 'a'.repeat(64),
          }),
          verifyBoundary: () => assert.fail('an owned generation must block before boundary setup'),
          loadCustodyAuth: () => assert.fail('an owned generation must block before custody'),
        },
      });
      assert.equal(overlapping.ok, false);
      assert.equal(overlapping.reason, 'managed-portable-domain-quarantined');

      const closed = await closeLocalCodexCredentialDomain({
        descriptor: prepared.descriptor,
        providerArtifact,
        managedTransaction: managedTransactionFromIntent(managed.intent),
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        deps: {
          persistCustodyAuth: ({ secretId, authBody }) => {
            persisted = { secretId, authBody };
            return { ok: true };
          },
        },
      });
      assert.equal(closed.ok, true);
      assert.equal(closed.persisted, true);
      assert.equal(persisted.secretId, 'secret_1');
      assert.equal(JSON.parse(persisted.authBody).tokens.access_token, AUTH_CANARY);
      assert.equal(existsSync(prepared.descriptor.domain_path), false);
      assert.equal(existsSync(prepared.descriptor.executor_root), false);
      assert.equal(existsSync(prepared.descriptor.lease_path), false);
      const finalized = inspectManagedGenerationSync({
        mcHomeDir: root,
        codingSessionId: 'sess_managed1',
        runtimeGeneration: providerArtifact.runtime_generation,
      });
      assert.equal(finalized.phase, 'ready');
      assert.equal(finalized.terminal, true);

      const resumed = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_managed1',
        providerSessionId,
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: userCodexHome },
        deps: {
          inspectCodexRelease: () => ({
            ok: true,
            nativeBinary,
            version: MANAGED_CODEX_VERSION,
            teamId: MANAGED_CODEX_TEAM_ID,
            sha256: 'a'.repeat(64),
          }),
          verifyBoundary: ({ codexHome }) => {
            const restored = join(
              codexHome,
              'sessions',
              '2026',
              '07',
              '29',
              `rollout-2026-07-29T10-00-00-${providerSessionId}.jsonl`,
            );
            assert.equal(readFileSync(restored, 'utf8'), '{"type":"session_meta"}\n');
            return { ok: true };
          },
          loadCustodyAuth: () => ({
            ok: true,
            secretId: 'secret_1',
            authBody: AUTH_BODY,
          }),
        },
      });
      assert.equal(resumed.ok, true);
      assert.deepEqual(abortLocalCodexCredentialDomain({
        descriptor: resumed.descriptor,
      }), {
        ok: true,
        quarantined: false,
        reason: 'managed-domain-aborted',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('never opens custody when the platform boundary probe fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-local-domain-fail-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mc-local-workspace-fail-'));
    const nativeBinary = join(root, 'codex');
    writeFileSync(nativeBinary, 'signed-binary', { mode: 0o500 });
    let custodyCalls = 0;
    try {
      const result = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_managed2',
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: join(root, 'missing-user-codex-home') },
        deps: {
          inspectCodexRelease: () => ({
            ok: true,
            nativeBinary,
            version: MANAGED_CODEX_VERSION,
            teamId: MANAGED_CODEX_TEAM_ID,
            sha256: 'b'.repeat(64),
          }),
          verifyBoundary: () => ({ ok: false, reason: LOCAL_CODEX_BOUNDARY_UNAVAILABLE }),
          loadCustodyAuth: () => {
            custodyCalls += 1;
            return { ok: true, secretId: 'should-not-open', authBody: AUTH_BODY };
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, LOCAL_CODEX_BOUNDARY_UNAVAILABLE);
      assert.equal(custodyCalls, 0);
      assert.equal(existsSync(join(root, 'credential-domains')), true);
      const credentialSessions = readdirSync(join(root, 'credential-domains', 'codex'));
      assert.equal(credentialSessions.length, 1);
      const credentialSession = join(
        root,
        'credential-domains',
        'codex',
        credentialSessions[0],
      );
      assert.equal(existsSync(credentialSession), true);
      assert.deepEqual(
        readFileTreeNames(credentialSession),
        [],
        'failed generations leave no credential files',
      );
      assert.deepEqual(
        readFileTreeNames(join(root, 'credential-domain-leases')),
        ['codex'],
        'failed generations release their lease',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('central finalization closes a fresh early exit only after Codex proves no session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-local-domain-empty-exit-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mc-local-workspace-empty-exit-'));
    const nativeBinary = join(root, 'codex');
    writeFileSync(nativeBinary, 'signed-binary', { mode: 0o500 });
    try {
      const prepared = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_empty_exit',
        domainGeneration: DOMAIN_GENERATION,
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: join(root, 'missing-user-codex-home') },
        deps: {
          inspectCodexRelease: () => ({
            ok: true,
            nativeBinary,
            version: MANAGED_CODEX_VERSION,
            teamId: MANAGED_CODEX_TEAM_ID,
            sha256: 'd'.repeat(64),
          }),
          verifyBoundary: () => ({ ok: true }),
          loadCustodyAuth: () => ({
            ok: true,
            secretId: 'secret_empty_exit',
            authBody: AUTH_BODY,
          }),
        },
      });
      assert.equal(prepared.ok, true);
      const started = beginManagedGenerationSync({
        mcHomeDir: root,
        codingSessionId: 'sess_empty_exit',
        runtimeGeneration: DOMAIN_GENERATION,
        mode: 'fresh',
        tool: 'codex',
        recordedAt: '2026-07-29T10:00:00.000Z',
      });
      const append = (phase, data) => appendManagedGenerationReceiptSync({
        mcHomeDir: root,
        phase,
        codingSessionId: 'sess_empty_exit',
        runtimeGeneration: DOMAIN_GENERATION,
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
        root,
        descriptor: prepared.descriptor,
        providerArtifact: null,
        managedTransaction: managedTransactionFromIntent(started.intent),
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        deps: {
          persistCustodyAuth: () => ({ ok: true }),
        },
      });
      assert.equal(finalized.ok, true);
      assert.equal(finalized.provider_session_state, null);
      assert.equal(existsSync(prepared.descriptor.domain_path), false);
      assert.equal(existsSync(prepared.descriptor.executor_root), false);
      const generationState = inspectManagedGenerationSync({
        mcHomeDir: root,
        codingSessionId: 'sess_empty_exit',
        runtimeGeneration: DOMAIN_GENERATION,
      });
      assert.equal(generationState.phase, 'ready');
      assert.equal(generationState.receipts.ready.data.provider_session_id, null);
      assert.equal('archive-ready' in generationState.receipts, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('keeps the lease and credential generation quarantined when refresh cannot persist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-local-domain-quarantine-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mc-local-workspace-quarantine-'));
    const nativeBinary = join(root, 'codex');
    writeFileSync(nativeBinary, 'signed-binary', { mode: 0o500 });
    try {
      const prepared = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_quarantine',
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: join(root, 'missing-user-codex-home') },
        deps: {
          inspectCodexRelease: () => ({
            ok: true,
            nativeBinary,
            version: MANAGED_CODEX_VERSION,
            teamId: MANAGED_CODEX_TEAM_ID,
            sha256: 'c'.repeat(64),
          }),
          verifyBoundary: () => ({ ok: true }),
          loadCustodyAuth: () => ({
            ok: true,
            secretId: 'secret_quarantine',
            authBody: AUTH_BODY,
          }),
        },
      });
      assert.equal(prepared.ok, true);

      const closed = await closeLocalCodexCredentialDomain({
        descriptor: prepared.descriptor,
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        deps: {
          persistCustodyAuth: () => ({
            ok: false,
            reason: 'managed-domain-refresh-not-persisted',
          }),
        },
      });
      assert.equal(closed.ok, false);
      assert.equal(closed.quarantined, true);
      assert.equal(existsSync(prepared.descriptor.domain_path), true);
      assert.equal(existsSync(prepared.descriptor.executor_root), true);
      assert.equal(existsSync(prepared.descriptor.lease_path), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('refuses cleanup paths that are not an owned credential generation', () => {
    const target = mkdtempSync(join(tmpdir(), 'mc-local-domain-cleanup-target-'));
    writeFileSync(join(target, 'keep'), 'user-data');
    try {
      const result = abortLocalCodexCredentialDomain({
        descriptor: {
          schema: 'mc-local-codex-credential-domain/v1',
          provider_adapter: 'codex-managed-local-v1',
          session_id: 'sess_malicious',
          generation: '00000000-0000-4000-8000-000000000000',
          domain_path: target,
          provider_home: join(target, 'home'),
          codex_home: join(target, 'home', '.codex'),
          provider_tmp: join(target, 'tmp'),
          executor_root: join(target, 'executor'),
          executor_home: join(target, 'executor', 'home'),
          executor_tmp: join(target, 'executor', 'tmp'),
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'managed-domain-descriptor-invalid');
      assert.equal(existsSync(join(target, 'keep')), true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test('renders a permissive development profile with only secret paths denied', () => {
    const config = renderManagedCodexConfig({
      domainPath: '/private/credential',
      executorRoot: '/private/executor',
      workspaceRoot: '/private/workspace',
      executorHome: '/private/executor/home',
      executorTmp: '/private/executor/tmp',
      safePath: '/usr/bin:/bin',
      forbiddenPaths: ['/Users/test/.memoro', '/Users/test/.codex'],
      deniedUnixSocketPaths: ['/tmp/credential.sock'],
      allowedUnixSocketPaths: ['/tmp/github-session.sock'],
    });

    assert.match(config, /default_permissions = "mc-managed-portable"/);
    assert.match(config, /inherit = "all"/);
    assert.match(config, /exclude = \[/);
    for (const name of [...RUNTIME_SECRET_ENV_NAMES, 'MC_BOUNDARY_CANARY']) {
      assert.match(config, new RegExp(`  "${name}",`));
    }
    assert.match(config, /":root" = "write"/);
    assert.doesNotMatch(config, /":minimal"/);
    assert.match(config, /"\/private\/credential" = "deny"/);
    assert.match(config, /"\/Users\/test\/\.memoro" = "deny"/);
    assert.match(config, /"\/" = true/);
    assert.match(config, /"\/private\/workspace" = true/);
    assert.match(config, /enabled = true/);
    assert.match(config, /network_proxy = true/);
    assert.match(config, /allow_local_binding = true/);
    assert.match(config, /dangerously_allow_all_unix_sockets = false/);
    assert.match(config, /\[permissions\.mc-managed-portable\.network\.domains\]\n"\*" = "allow"/);
    assert.match(config, /\[permissions\.mc-managed-portable\.network\.unix_sockets\]\n"\/tmp\/credential\.sock" = "deny"/);
    assert.match(config, /"\/tmp\/github-session\.sock" = "allow"/);
    assert.doesNotMatch(config, /hooks\s*=/);
    assert.ok(config.includes([
      '[projects]',
      '[projects."/private/workspace"]',
      'trust_level = "untrusted"',
    ].join('\n')));
    assert.doesNotMatch(config, /trust_level = "trusted"/);
    assert.doesNotMatch(config, /approval_policy|allow_login_shell|web_search/);
    assert.doesNotMatch(config, /multi_agent = false|skill_mcp_dependency_install = false/);
    assert.doesNotMatch(config, /\*\*\/\*secret\*|\*\*\/\.env\*/);
  });

  test('records the managed workspace as untrusted without trusting repository config', () => {
    const config = renderManagedCodexConfig({
      domainPath: '/private/credential',
      executorRoot: '/private/executor',
      workspaceRoot: '/private/workspace',
      executorHome: '/private/executor/home',
      executorTmp: '/private/executor/tmp',
      safePath: '/usr/bin:/bin',
    });

    assert.ok(config.includes([
      '[projects]',
      '[projects."/private/workspace"]',
      'trust_level = "untrusted"',
    ].join('\n')));
    assert.doesNotMatch(config, /trust_level = "trusted"/);
  });

  test('requires the exact hostile boundary report schema', () => {
    const complete = {
      schema: 1,
      file_readable: false,
      canary_in_environment: false,
      canary_in_argv: false,
      parent_process_exposes_canary: false,
      detached_boundary_reachable: false,
      credential_socket_reachable: false,
      external_network_reachable: false,
      workspace_write_blocked: false,
      vault_admin_via_bin_callable: false,
      vault_admin_via_node_callable: false,
    };
    assert.equal(validateBoundaryReport(complete), true);
    assert.equal(validateBoundaryReport({ schema: 1 }), false);
    assert.equal(validateBoundaryReport({ ...complete, file_readable: null }), false);
    assert.equal(validateBoundaryReport({ ...complete, unexpected: false }), false);
  });

  test('keeps the hostile probe socket below the macOS Unix path limit', () => {
    const socketPath = managedBoundarySocketPath({ nonce: 'a'.repeat(24) });
    assert.match(socketPath, /^\/tmp\/mccb-[a-f0-9]+\.sock$/);
    assert.ok(Buffer.byteLength(socketPath) < 104);
  });

  test('accepts only the checksum-pinned official macOS Codex release', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-codex-release-'));
    const binary = join(root, 'codex');
    writeFileSync(binary, 'signed-codex', { mode: 0o755 });
    try {
      const result = inspectCodexRelease({
        launcherPath: binary,
        deps: {
          platform: () => 'darwin',
          arch: () => 'arm64',
          releaseDigests: {
            'darwin-arm64': createHash('sha256').update('signed-codex').digest('hex'),
          },
          spawnSync: (command, args) => {
            if (command === 'codesign') {
              return {
                status: 0,
                stdout: '',
                stderr: `Identifier=codex\nTeamIdentifier=${MANAGED_CODEX_TEAM_ID}\n`,
              };
            }
            if (command === realpathSync(binary)) {
              return { status: 0, stdout: `codex-cli ${MANAGED_CODEX_VERSION}\n`, stderr: '' };
            }
            assert.fail(`unexpected command: ${command}`);
          },
        },
      });
      assert.equal(result.ok, true);
    assert.equal(result.nativeBinary, realpathSync(binary));
      assert.match(result.sha256, /^[a-f0-9]{64}$/);

      const rejected = inspectCodexRelease({
        launcherPath: binary,
        deps: {
          platform: () => 'darwin',
          arch: () => 'arm64',
          spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
        },
      });
      assert.equal(rejected.ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('provider env contains no inherited credential-shaped values', () => {
    const env = buildManagedCodexProviderEnv({
      providerHome: '/credential/home',
      codexHome: '/credential/home/.codex',
      providerTmp: '/credential/tmp',
      safePath: '/usr/bin:/bin',
      env: {
        LANG: 'sv_SE.UTF-8',
        TERM: 'xterm-256color',
        MEMORO_TOKEN: 'memoro-canary',
        OPENAI_API_KEY: 'openai-canary',
        SSH_AUTH_SOCK: '/secret/socket',
      },
    });
    assert.deepEqual(Object.keys(env).sort(), [
      'CODEX_HOME', 'COLORTERM', 'HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR',
    ]);
    assert.doesNotMatch(JSON.stringify(env), /memoro-canary|openai-canary|secret\/socket/);
  });

  test('opens and refreshes the same encrypted Codex custody record', async () => {
    const vaultKey = await importVaultKey(new Uint8Array(32).fill(17));
    const custody = await mintCustodyRoot(vaultKey);
    const original = await encryptEnvelopeSecret(custody.crk, {
      secretClass: 'tool-auth',
      label: 'tool-auth:codex',
      data: {
        kind: 'tool_auth',
        tool: 'codex',
        source: 'file',
        body: AUTH_BODY,
      },
    });
    let wire = {
      id: 'secret_1',
      ...envelopeToWire(original),
    };
    let unlockCount = 0;
    let updateCount = 0;
    const api = {
      getStatus: async () => ({
        ok: true,
        vault: {
          setup: true,
          wrapped_crk: custody.wrapped_crk,
          crk_iv: custody.crk_iv,
        },
      }),
      unlockVault: async (_portal, body) => {
        assert.deepEqual(body, {
          authHash: 'hash-only-test',
          deviceId: 'device-test',
        });
        unlockCount += 1;
        return { ok: true };
      },
      listSecrets: async () => ({ ok: true, secrets: [wire] }),
      updateSecret: async (_portal, secretId, body) => {
        assert.equal(secretId, 'secret_1');
        updateCount += 1;
        wire = {
          id: secretId,
          encrypted_label: body.encryptedLabel,
          label_iv: body.labelIv,
          encrypted_data: body.encryptedData,
          iv: body.iv,
          wrapped_dek: body.wrappedDek,
          dek_iv: body.dekIv,
          class: body.secretClass,
          schema_version: body.schemaVersion,
        };
        return { ok: true };
      },
    };
    const deps = {
      readCachedVaultKey: async () => ({
        vaultKey,
        authHash: 'hash-only-test',
        deviceId: 'device-test',
      }),
      api,
    };
    const portal = { apiUrl: 'https://memoro.test', token: 'memoro-test-token' };

    const loaded = await loadCustodyCodexAuth({ portal, deps });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.secretId, 'secret_1');
    assert.equal(loaded.authBody, AUTH_BODY);

    const refreshed = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'refreshed-auth-canary' },
    });
    const persisted = await persistCustodyCodexAuth({
      portal,
      secretId: loaded.secretId,
      authBody: refreshed,
      deps,
    });
    assert.equal(persisted.ok, true);
    assert.equal(unlockCount, 2);
    assert.equal(updateCount, 1);
    const opened = await decryptEnvelopeSecret(custody.crk, wire);
    assert.equal(opened.label, 'tool-auth:codex');
    assert.equal(opened.data.body, refreshed);
  });
});

function readFileTreeNames(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true });
}

function envelopeToWire(envelope) {
  return {
    encrypted_label: envelope.encryptedLabel,
    label_iv: envelope.labelIv,
    encrypted_data: envelope.encryptedData,
    iv: envelope.iv,
    wrapped_dek: envelope.wrapped_dek,
    dek_iv: envelope.dek_iv,
    class: envelope.class,
    schema_version: envelope.schema_version,
  };
}
