import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MANAGED_CLAUDE_DOMAIN_SCHEMA,
  MANAGED_CLAUDE_PROFILE,
  MANAGED_CLAUDE_PROVIDER_ID,
  renderManagedClaudeSettings,
  resolveManagedClaudeLaunch,
  sanitizeManagedClaudePermissions,
  validateManagedClaudeArgv,
  validateManagedClaudeDescriptor,
} from '../../../src/mc/provider-adapters/claude-managed.js';
import {
  managedClaudeC1SourceClosureDigest,
} from '../../../src/mc/provider-adapters/claude-managed-certification.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-managed-claude-')));
  const domain = join(root, 'credential');
  const executor = join(root, 'executor');
  const executorHome = join(executor, 'home');
  const executorTmp = join(executor, 'tmp');
  const executorBin = join(executor, 'bin');
  const configDir = join(executorHome, '.claude');
  const workspace = join(root, 'workspace');
  const artifacts = join(root, 'artifacts');
  const leaseDir = join(root, 'leases');
  for (const directory of [
    domain,
    executor,
    executorHome,
    executorTmp,
    executorBin,
    configDir,
    workspace,
    artifacts,
    leaseDir,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const files = {
    certification: join(artifacts, 'certification.json'),
    native: join(artifacts, 'claude'),
    srt: join(artifacts, 'srt.js'),
    hookNode: join(artifacts, 'hook-node'),
    hookRunner: join(artifacts, 'hook-runner.js'),
    runtimeNode: join(artifacts, 'runtime-node'),
    runtimeHost: join(artifacts, 'runtime-host.js'),
    settings: join(configDir, 'settings.json'),
    lease: join(leaseDir, 'session.json'),
    manifest: join(domain, 'manifest.json'),
  };
  for (const [name, path] of Object.entries(files)) {
    if (name === 'manifest') continue;
    writeFileSync(path, name === 'settings'
      ? renderManagedClaudeSettings({
          nodePath: files.hookNode,
          hookRunnerPath: files.hookRunner,
        })
      : `${name}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const manifest = {
    allowed_unix_socket_paths: [
      join(root, 'artifact.sock'),
      join(root, 'github.sock'),
    ],
    c1_certification_path: files.certification,
    c1_certification_sha256: sha256(readFileSync(files.certification)),
    c1_source_closure_sha256: managedClaudeC1SourceClosureDigest(),
    claude_config_dir: configDir,
    claude_version: '2.1.220',
    custody_secret_id: 'vault-secret',
    denied_read_paths: [domain, join(root, 'vault-state')],
    denied_write_paths: [domain, join(root, 'vault-state')],
    domain_path: domain,
    executor_bin: executorBin,
    executor_home: executorHome,
    executor_root: executor,
    executor_tmp: executorTmp,
    generation: '687c338a-1ed4-4c20-9828-1f9a39d37067',
    launch_nonce: 'n'.repeat(43),
    lease_path: files.lease,
    native_binary: files.native,
    native_binary_sha256: 'a'.repeat(64),
    profile: MANAGED_CLAUDE_PROFILE,
    provider_adapter: MANAGED_CLAUDE_PROVIDER_ID,
    provider_hook_node_path: files.hookNode,
    provider_hook_node_sha256: sha256(readFileSync(files.hookNode)),
    provider_hook_runner_path: files.hookRunner,
    provider_hook_runner_sha256: sha256(readFileSync(files.hookRunner)),
    provider_settings_path: files.settings,
    provider_settings_sha256: sha256(readFileSync(files.settings)),
    runtime_host_path: files.runtimeHost,
    runtime_host_sha256: sha256(readFileSync(files.runtimeHost)),
    runtime_node_path: files.runtimeNode,
    runtime_node_sha256: sha256(readFileSync(files.runtimeNode)),
    safe_path: `${executorBin}:/usr/bin:/bin`,
    schema: MANAGED_CLAUDE_DOMAIN_SCHEMA,
    session_id: 'sess_managed_claude',
    srt_module: files.srt,
    srt_tree_sha256:
      'a3f7a83ffcf7c9308366a731e6914d45b72ba4af91de9ead12d9d2a3ba226578',
    srt_version: '0.0.67',
    state: 'ready',
    workspace,
  };
  const manifestBody = `${JSON.stringify(manifest)}\n`;
  writeFileSync(files.manifest, manifestBody, { mode: 0o600 });
  chmodSync(files.manifest, 0o600);
  const descriptor = {
    ...manifest,
    manifest_path: files.manifest,
    manifest_sha256: sha256(manifestBody),
  };
  const verifyArtifacts = () => ({
    ok: true,
    artifacts: {
      claudeBinary: files.native,
      claudeSha256: descriptor.native_binary_sha256,
      srtModule: files.srt,
      srtTreeSha256: descriptor.srt_tree_sha256,
    },
  });
  return {
    root,
    descriptor,
    verifyArtifacts,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('managed Claude descriptor binds release, runtime, policy, and isolated settings', () => {
  const built = fixture();
  try {
    assert.deepEqual(validateManagedClaudeDescriptor(built.descriptor, {
      verifyArtifacts: built.verifyArtifacts,
    }), { ok: true });

    writeFileSync(
      built.descriptor.provider_settings_path,
      '{}\n',
      { mode: 0o600 },
    );
    assert.equal(validateManagedClaudeDescriptor(built.descriptor, {
      verifyArtifacts: built.verifyArtifacts,
    }).reason, 'managed-provider-runtime-mismatch');
  } finally {
    built.cleanup();
  }
});

test('managed Claude launch routes through the trusted host and replaces environment', () => {
  const built = fixture();
  try {
    const launch = {
      id: 'claude-code',
      shortName: 'claude',
      spec: {
        bin: 'claude',
        args: (argv, { startupMessage } = {}) => [
          ...argv,
          ...(startupMessage
            ? ['--append-system-prompt', startupMessage]
            : []),
        ],
      },
    };
    const result = resolveManagedClaudeLaunch({
      launch,
      input: {
        argv: ['--resume', 'native-session'],
        env: {
          HOME: built.descriptor.executor_home,
          TMPDIR: built.descriptor.executor_tmp,
          CLAUDE_CONFIG_DIR: built.descriptor.claude_config_dir,
          PATH: built.descriptor.safe_path,
          TERM: 'xterm-256color',
          MEMORO_TOKEN: 'must-not-cross',
        },
        credential_domain: built.descriptor,
      },
      deps: {
        verifyArtifacts: built.verifyArtifacts,
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.environmentMode, 'replace');
    assert.equal(result.env.MEMORO_TOKEN, undefined);
    const spawned = result.launch.spec.spawn([], {
      startupMessage: 'managed grounding',
    });
    assert.equal(spawned.bin, built.descriptor.runtime_node_path);
    assert.deepEqual(spawned.args.slice(0, 4), [
      built.descriptor.runtime_host_path,
      '--manifest',
      built.descriptor.manifest_path,
      '--',
    ]);
    assert.deepEqual(spawned.args.slice(4), [
      '--resume',
      'native-session',
      '--append-system-prompt',
      'managed grounding',
    ]);
  } finally {
    built.cleanup();
  }
});

test('managed Claude argv rejects settings and plugin boundary replacement', () => {
  assert.equal(validateManagedClaudeArgv(['--settings', '/tmp/other']).reason,
    'managed-provider-argv-forbidden');
  assert.equal(validateManagedClaudeArgv(['--plugin-dir=/tmp/other']).reason,
    'managed-provider-argv-forbidden');
  for (const argv of [
    ['--permission-mode', 'bypassPermissions'],
    ['--dangerously-skip-permissions'],
    ['--allow-dangerously-skip-permissions'],
    ['--allowedTools', 'Bash'],
    ['--allowed-tools=Bash'],
    ['--setting-sources', 'project'],
  ]) {
    assert.equal(validateManagedClaudeArgv(argv).reason,
      'managed-provider-argv-forbidden');
  }
  assert.deepEqual(validateManagedClaudeArgv(['--resume', 'native-session']), {
    ok: true,
    argv: ['--resume', 'native-session'],
  });
});

test('managed Claude settings project only bounded non-bypass permissions', () => {
  const checked = sanitizeManagedClaudePermissions({
    defaultMode: 'auto',
    allow: ['Bash(git status)', 'Bash(git status)'],
    ask: ['Bash(git push *)'],
    deny: ['Read(./.env)'],
    additionalDirectories: ['/private/ignored'],
  });
  assert.deepEqual(checked, {
    ok: true,
    permissions: {
      defaultMode: 'auto',
      allow: ['Bash(git status)'],
      ask: ['Bash(git push *)'],
      deny: ['Read(./.env)'],
      disableBypassPermissionsMode: 'disable',
    },
  });

  const settings = JSON.parse(renderManagedClaudeSettings({
    nodePath: '/usr/bin/node',
    hookRunnerPath: '/opt/mc/provider-hook.js',
    permissions: checked.permissions,
  }));
  assert.deepEqual(settings.permissions, checked.permissions);
  assert.deepEqual(Object.keys(settings).sort(), ['hooks', 'permissions']);
  assert.equal(sanitizeManagedClaudePermissions({
    defaultMode: 'bypassPermissions',
  }).reason, 'managed-provider-user-permissions-invalid');
  assert.equal(sanitizeManagedClaudePermissions({
    allow: ['Bash(git status)\nBash(git push)'],
  }).reason, 'managed-provider-user-permissions-invalid');
});
