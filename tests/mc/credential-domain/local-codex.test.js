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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';

import {
  LOCAL_CODEX_BOUNDARY_UNAVAILABLE,
  abortLocalCodexCredentialDomain,
  buildManagedCodexProviderEnv,
  closeLocalCodexCredentialDomain,
  inspectCodexRelease,
  loadCustodyCodexAuth,
  managedBoundarySocketPath,
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
import { importVaultKey } from '../../../src/mc/vault/client-crypto.js';
import {
  decryptEnvelopeSecret,
  encryptEnvelopeSecret,
  mintCustodyRoot,
} from '../../../src/mc/vault/custody-crypto.js';

const AUTH_CANARY = 'codex-managed-auth-canary';
const AUTH_BODY = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: AUTH_CANARY },
});

describe('local Codex credential domain', () => {
  test('verifies release and boundary before custody, then returns only safe launch metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-local-domain-'));
    const cwd = mkdtempSync(join(tmpdir(), 'mc-local-workspace-'));
    const nativeBinary = join(root, 'codex');
    writeFileSync(nativeBinary, 'signed-binary', { mode: 0o500 });
    const calls = [];
    let persisted = null;
    try {
      const prepared = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_managed1',
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
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
          verifyBoundary: ({ codexHome }) => {
            calls.push('boundary');
            const config = readFileSync(join(codexHome, 'config.toml'), 'utf8');
            assert.match(config, new RegExp(`default_permissions = "${MANAGED_CODEX_PROFILE}"`));
            assert.ok(config.includes([
              `[projects."${cwd}"]`,
              'trust_level = "untrusted"',
            ].join('\n')));
            assert.doesNotMatch(config, /trust_level = "trusted"/);
            assert.match(config, /hooks = true/);
            assert.doesNotMatch(config, /memoro-canary|codex-managed-auth-canary/);
            return { ok: true };
          },
          loadCustodyAuth: () => {
            calls.push('custody');
            return { ok: true, secretId: 'secret_1', authBody: AUTH_BODY };
          },
        },
      });

      assert.equal(prepared.ok, true);
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

      const overlapping = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_managed1',
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
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
        providerArtifact: {
          coding_session_id: 'sess_managed1',
          provider_session_id: providerSessionId,
          transcript_path: transcriptPath,
        },
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

      const resumed = await prepareLocalCodexCredentialDomain({
        codingSessionId: 'sess_managed1',
        providerSessionId,
        cwd,
        tool: 'codex',
        portal: { apiUrl: 'https://memoro.test', token: 'memoro-canary' },
        root,
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

  test('renders a permission profile with root deny, minimal runtime, no network, and no inherited env', () => {
    const config = renderManagedCodexConfig({
      domainPath: '/private/credential',
      executorRoot: '/private/executor',
      workspaceRoot: '/private/workspace',
      executorHome: '/private/executor/home',
      executorTmp: '/private/executor/tmp',
      safePath: '/usr/bin:/bin',
      forbiddenPaths: ['/Users/test/.memoro', '/Users/test/.codex'],
    });

    assert.match(config, /default_permissions = "mc-managed-portable"/);
    assert.match(config, /inherit = "none"/);
    assert.match(config, /":root" = "deny"/);
    assert.match(config, /":minimal" = "read"/);
    assert.match(config, /"\/private\/credential" = "deny"/);
    assert.match(config, /"\/private\/workspace" = true/);
    assert.match(config, /enabled = false/);
    assert.match(config, /hooks = true/);
    assert.doesNotMatch(config, /\bsandbox_mode\b|danger-full-access/);
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
      unlockVault: async () => ({ ok: true }),
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
