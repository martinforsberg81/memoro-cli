import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

import {
  MANAGED_CODEX_DOMAIN_SCHEMA,
  MANAGED_CODEX_PROFILE,
  MANAGED_CODEX_PROVIDER_ID,
  MANAGED_CODEX_TEAM_ID,
  MANAGED_CODEX_VERSION,
  renderManagedCodexProviderHook,
  resolveManagedCodexLaunch,
  validateManagedCodexArgv,
} from '../../../src/mc/provider-adapters/codex-managed.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function makeDomain() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-managed-provider-')));
  const sessionPart = 'sess_managed1-47c28bc88525';
  const generation = '019dbb46-5772-4493-a627-f8ae48954a64';
  const domain = join(root, 'credential-domains', 'codex', sessionPart, generation);
  const executor = join(root, 'executor-domains', 'codex', sessionPart, generation);
  const leasePath = join(root, 'credential-domain-leases', 'codex', `${sessionPart}.json`);
  const codexHome = join(domain, 'home', '.codex');
  const providerHome = join(domain, 'home');
  const providerTmp = join(domain, 'tmp');
  const executorHome = join(executor, 'home');
  const executorTmp = join(executor, 'tmp');
  const nativeBinaryPath = join(root, 'codex');
  const manifestPath = join(domain, 'manifest.json');
  const providerConfigPath = join(codexHome, 'config.toml');
  const providerHookPath = join(codexHome, 'hooks.json');
  const providerHookNodePath = realpathSync(process.execPath);
  const providerHookRunnerPath = realpathSync(fileURLToPath(new URL(
    '../../../src/mc/provider-artifact-hook-runner.js',
    import.meta.url,
  )));
  for (const path of [
    domain, executor, codexHome, providerHome, providerTmp, executorHome, executorTmp,
    join(root, 'credential-domain-leases', 'codex'),
  ]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(leasePath, '{"schema":1}\n', { mode: 0o600 });
  writeFileSync(nativeBinaryPath, 'signed-codex-binary', { mode: 0o755 });
  const nativeBinary = realpathSync(nativeBinaryPath);
  writeFileSync(join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt"}', { mode: 0o600 });
  const providerConfigBody = 'default_permissions="mc-managed-portable"\n';
  writeFileSync(providerConfigPath, providerConfigBody, { mode: 0o600 });
  const providerHookBody = renderManagedCodexProviderHook({
    nodePath: providerHookNodePath,
    runnerPath: providerHookRunnerPath,
  });
  writeFileSync(providerHookPath, providerHookBody, { mode: 0o600 });

  const manifest = {
    schema: MANAGED_CODEX_DOMAIN_SCHEMA,
    provider_adapter: MANAGED_CODEX_PROVIDER_ID,
    state: 'ready',
    session_id: 'sess_managed1',
    generation,
    launch_nonce: 'a'.repeat(43),
    profile: MANAGED_CODEX_PROFILE,
    codex_version: MANAGED_CODEX_VERSION,
    codex_team_id: MANAGED_CODEX_TEAM_ID,
    native_binary: nativeBinary,
    native_binary_sha256: sha256('signed-codex-binary'),
    domain_path: domain,
    codex_home: codexHome,
    provider_home: providerHome,
    provider_tmp: providerTmp,
    executor_root: executor,
    executor_home: executorHome,
    executor_tmp: executorTmp,
    lease_path: leasePath,
    custody_secret_id: 'secret_1',
    provider_config_path: providerConfigPath,
    provider_config_sha256: sha256(providerConfigBody),
    provider_hook_path: providerHookPath,
    provider_hook_sha256: sha256(providerHookBody),
    provider_hook_node_path: providerHookNodePath,
    provider_hook_node_sha256: sha256(readFileSync(providerHookNodePath)),
    provider_hook_runner_path: providerHookRunnerPath,
    provider_hook_runner_sha256: sha256(readFileSync(providerHookRunnerPath)),
  };
  const manifestBody = `${JSON.stringify(manifest)}\n`;
  writeFileSync(manifestPath, manifestBody, { mode: 0o600 });
  return {
    root,
    descriptor: {
      ...manifest,
      manifest_path: manifestPath,
      manifest_sha256: sha256(manifestBody),
    },
  };
}

describe('managed Codex provider adapter', () => {
  test('re-verifies the descriptor and replaces inherited env with an allowlist', () => {
    const domain = makeDomain();
    try {
      const result = resolveManagedCodexLaunch({
        launch: {
          ok: true,
          id: 'codex',
          shortName: 'codex',
          spec: {
            bin: '/untrusted/wrapper',
            args: () => ['--native'],
            startupMessageDelivery: 'deferred-pty',
          },
        },
        input: {
          argv: ['resume', '019dbb46-5772-7493-a627-f8ae48954a64'],
          env: {
            PATH: '/safe/bin',
            TERM: 'xterm-256color',
            MEMORO_TOKEN: 'memoro-canary',
            OPENAI_API_KEY: 'openai-canary',
          },
          credential_domain: domain.descriptor,
        },
        inspectRelease: () => ({ ok: true }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.environmentMode, 'replace');
      assert.equal(result.launch.spec.bin, domain.descriptor.native_binary);
      assert.deepEqual(result.launch.spec.spawn().args, [
        '--strict-config',
        '--dangerously-bypass-hook-trust',
        'resume',
        '019dbb46-5772-7493-a627-f8ae48954a64',
      ]);
      assert.equal(result.env.CODEX_HOME, domain.descriptor.codex_home);
      assert.equal(result.env.HOME, domain.descriptor.provider_home);
      assert.equal(result.env.MEMORO_TOKEN, undefined);
      assert.equal(result.env.OPENAI_API_KEY, undefined);
      assert.doesNotMatch(JSON.stringify(result), /memoro-canary|openai-canary/);
    } finally {
      rmSync(domain.root, { recursive: true, force: true });
    }
  });

  test('rejects unsafe provider argv', () => {
    for (const argv of [
      ['--sandbox', 'danger-full-access'],
      ['--config', 'approval_policy="never"'],
      ['--remote', 'ws://attacker'],
      ['login', '--device-auth'],
      ['resume', '../auth.json'],
    ]) assert.equal(validateManagedCodexArgv(argv).ok, false, argv.join(' '));
  });

  test('fails closed on binary substitution', () => {
    const domain = makeDomain();
    try {
      chmodSync(domain.descriptor.native_binary, 0o700);
      writeFileSync(domain.descriptor.native_binary, 'substituted', { mode: 0o500 });
      const result = resolveManagedCodexLaunch({
        launch: { ok: true, id: 'codex', shortName: 'codex', spec: {} },
        input: { argv: [], env: {}, credential_domain: domain.descriptor },
        inspectRelease: () => ({ ok: true }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'managed-provider-binary-mismatch');
    } finally {
      rmSync(domain.root, { recursive: true, force: true });
    }
  });

  test('fails closed on managed provider hook substitution', () => {
    const domain = makeDomain();
    try {
      writeFileSync(domain.descriptor.provider_hook_path, '{"hooks":{}}\n', { mode: 0o600 });
      const result = resolveManagedCodexLaunch({
        launch: { ok: true, id: 'codex', shortName: 'codex', spec: {} },
        input: { argv: [], env: {}, credential_domain: domain.descriptor },
        inspectRelease: () => ({ ok: true }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'managed-provider-hook-mismatch');
    } finally {
      rmSync(domain.root, { recursive: true, force: true });
    }
  });

  test('fails closed on managed config substitution before hook trust bypass', () => {
    const domain = makeDomain();
    try {
      writeFileSync(
        domain.descriptor.provider_config_path,
        'default_permissions="danger-full-access"\n',
        { mode: 0o600 },
      );
      const result = resolveManagedCodexLaunch({
        launch: { ok: true, id: 'codex', shortName: 'codex', spec: {} },
        input: { argv: [], env: {}, credential_domain: domain.descriptor },
        inspectRelease: () => ({ ok: true }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'managed-provider-hook-mismatch');
    } finally {
      rmSync(domain.root, { recursive: true, force: true });
    }
  });
});
