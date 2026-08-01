import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  brokerConnectOutputIndicatesReady,
  CLOUD_RUNTIME_CONTRACT_VERSION,
  parseArgs,
  prepareWorkspace,
  runCloudRuntimeWith as runCloudRuntimeWithDefault,
  runProcessDefault,
  validateCloudRuntimeOptions,
  verifyRuntimeRelease,
} from '../../../src/cli/cloud-runtime.js';
import {
  captureCodingBinSnapshot,
  restoreCodingBinSnapshot,
} from '../../../src/mc/cloud-runtime-snapshot.js';

function io() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      columns: 100,
      rows: 30,
      write: (s) => { stdout += String(s); },
    },
    stderr: {
      write: (s) => { stderr += String(s); },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

function manifest(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-cloud-runtime-'));
  return {
    contract_version: CLOUD_RUNTIME_CONTRACT_VERSION,
    account_id: 'usr_runtime1',
    cloud_session_id: 'cld_runtime1',
    coding_session_id: 'sess_runtime1',
    source: {
      id: 'cloud:cld_runtime1',
      kind: 'cloud',
      name: 'Memoro Cloud',
    },
    authorization: {
      runtime_generation: 'rtg_0123456789abcdef',
      authorization_digest: 'a'.repeat(64),
    },
    launch: {
      name: 'cloud-runtime',
      task: 'Build cloud runtime',
      tool: 'codex',
      policy: 'workspace-write',
    },
    repo: {
      id: 'repo_memoro',
      ref: 'martinforsberg81/memoro',
      workspace_ref: 'main',
      access: 'private_capability',
      grant_kind: 'explicit',
      credential_source: 'runtime_env',
      git_auth: {
        access: 'private_capability',
        grant_kind: 'explicit',
        credential_source: 'runtime_env',
        ready: true,
        repair_required: false,
        secret_boundary: 'status_only',
      },
    },
    runtime: {
      api_url: 'https://meetmemoro.test',
      sandbox_id: 'mc-runtime',
      process_id: 'mc-cld-runtime1',
      entrypoint: 'mc cloud-runtime run',
      cwd: join(dir, 'repo'),
      paths: {
        dir,
        manifest: join(dir, 'manifest.json'),
        status: join(dir, 'status.json'),
        events: join(dir, 'events.jsonl'),
        readiness: join(dir, 'readiness.json'),
      },
    },
    ...overrides,
  };
}

function runtimeEnv(m, overrides = {}) {
  return {
    MC_CLOUD_RUNTIME_GENERATION: m.authorization.runtime_generation,
    MC_CLOUD_AUTHORIZATION_DIGEST: m.authorization.authorization_digest,
    ...overrides,
  };
}

// Later lifecycle tests explicitly opt into a synthetic, approved release
// gate. Production uses the default fail-closed gate.
function runCloudRuntimeWith(opts, deps = {}) {
  return runCloudRuntimeWithDefault(opts, {
    ...deps,
    verifyRuntimeRelease: deps.verifyRuntimeRelease || (async () => ({ ok: true })),
  });
}

describe('mc cloud-runtime parseArgs', () => {
  test('parses run manifest fields', () => {
    const opts = parseArgs([
      'run',
      '--cloud-session-id',
      'cld_123456',
      '--manifest',
      '/workspace/mc-runtime/manifest.json',
      '--json',
    ]);

    assert.equal(opts.verb, 'run');
    assert.equal(opts.cloudSessionId, 'cld_123456');
    assert.equal(opts.manifestPath, '/workspace/mc-runtime/manifest.json');
    assert.equal(opts.json, true);
    assert.equal(validateCloudRuntimeOptions(opts).ok, true);
  });

  test('rejects missing cloud session id and manifest', () => {
    assert.match(validateCloudRuntimeOptions(parseArgs(['run'])).error, /cloud session id/);
    assert.match(
      validateCloudRuntimeOptions(parseArgs(['run', '--cloud-session-id', 'cld_123456'])).error,
      /--manifest/,
    );
    assert.match(parseArgs(['run', '--cmd', 'bash']).error, /unknown flag/);
  });

  test('detects broker-connect ready output without treating arbitrary JSON as ready', () => {
    assert.equal(brokerConnectOutputIndicatesReady('mc broker: connected to cloud (worker-1)\n'), true);
    assert.equal(brokerConnectOutputIndicatesReady('{"ok":true,"machine_id":"worker-1"}\n'), true);
    assert.equal(brokerConnectOutputIndicatesReady('{\n  "ok": true,\n  "machine_id": "worker-1"\n}\n'), true);
    assert.equal(brokerConnectOutputIndicatesReady('prefix\n{\n  "ok": true,\n  "machine_id": "worker-1"\n}\n'), true);
    assert.equal(brokerConnectOutputIndicatesReady('{"ok":true}\n'), false);
    assert.equal(brokerConnectOutputIndicatesReady('{"ok":false,"machine_id":"worker-1"}\n'), false);
  });
});

describe('mc cloud-runtime workspace', () => {
  test('uses an isolated credential-free Git environment for a cloud clone', async () => {
    const calls = [];
    const m = manifest();
    const result = await prepareWorkspace(m, {
      env: {
        MC_CLOUD_GIT_TOKEN: 'ghp_private_secret',
        MC_CLOUD_GIT_SECRET_CAPABILITY: 'opaque-git-authority',
        MC_GIT_CLONE_TOKEN: 'clone-secret',
        GITHUB_TOKEN: 'github-secret',
        GH_TOKEN: 'gh-secret',
        GH_CONFIG_DIR: '/private/gh-config',
        GIT_ASKPASS: '/private/askpass',
        SSH_ASKPASS: '/private/ssh-askpass',
        SSH_AUTH_SOCK: '/private/agent.sock',
        GIT_SSH_COMMAND: 'ssh -F /private/ssh-config',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '!steal-credentials',
        GIT_TEMPLATE_DIR: '/private/templates',
        GIT_PROXY_COMMAND: '/private/git-proxy',
        HTTPS_PROXY: 'http://proxy.example',
        NO_PROXY: 'localhost',
        HOME: '/private/home-with-netrc',
        XDG_CONFIG_HOME: '/private/xdg-git-config',
      },
      deps: {
        runProcess: async (cmd, args, options) => {
          calls.push({ cmd, args, options });
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.cloned, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.deepEqual(calls[0].args.slice(0, 22), [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'init.templateDir=',
      '-c',
      'http.proxy=',
      '-c',
      'http.sslVerify=true',
      '-c',
      'protocol.file.allow=never',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'protocol.version=2',
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--single-branch',
      '--no-tags',
    ]);
    assert.deepEqual(calls[0].args.slice(-2), ['https://github.com/martinforsberg81/memoro.git', m.runtime.cwd]);
    assert.equal(JSON.stringify(calls[0].args).includes('ghp_private_secret'), false);
    for (const name of [
      'MC_CLOUD_GIT_TOKEN', 'MC_CLOUD_GIT_SECRET_CAPABILITY', 'MC_GIT_CLONE_TOKEN',
      'GITHUB_TOKEN', 'GH_TOKEN',
      'GH_CONFIG_DIR', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK',
      'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0', 'GIT_TEMPLATE_DIR', 'GIT_PROXY_COMMAND',
      'HTTPS_PROXY', 'NO_PROXY',
    ]) {
      assert.equal(calls[0].options.env[name], undefined, `${name} must not reach git`);
    }
    assert.equal(calls[0].options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(calls[0].options.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(calls[0].options.env.HOME, '/dev/null');
    assert.equal(calls[0].options.env.XDG_CONFIG_HOME, '/dev/null');
    assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(calls[0].options.env.GIT_LFS_SKIP_SMUDGE, '1');
    assert.equal(calls[0].options.timeoutMs, 90_000);
  });

  test('fails a repository-required session with no usable clone target before side effects', async () => {
    const base = manifest();
    const m = manifest({
      repo: {
        ...base.repo,
        ref: 'not a clone target',
      },
    });
    const result = await prepareWorkspace(m, {
      deps: {
        existsSync: () => assert.fail('must not inspect or replace a workspace'),
        runProcess: async () => assert.fail('must not initialize an empty workspace'),
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'repository_clone_target_missing');
    assert.equal(result.initialized_empty, false);
    assert.match(result.error, /valid clone target/);
  });

  test('rejects SSH and insecure HTTP clone targets before workspace side effects', async () => {
    const base = manifest();
    for (const ref of [
      'git@github.com:martinforsberg81/memoro.git',
      'http://github.com/martinforsberg81/memoro.git',
      'https://token@github.com/martinforsberg81/memoro.git',
      'https://github.com/martinforsberg81/memoro.git?token=secret',
    ]) {
      const m = manifest({ repo: { ...base.repo, ref } });
      const result = await prepareWorkspace(m, {
        deps: {
          existsSync: () => assert.fail(`must not inspect workspace for ${ref}`),
          runProcess: async () => assert.fail(`must not invoke git for ${ref}`),
        },
      });

      assert.equal(result.ok, false, ref);
      assert.equal(result.code, 'repository_clone_target_missing', ref);
      assert.equal(result.initialized_empty, false, ref);
    }
  });

  test('resolves the function-shaped cwd supplied by the CLI entrypoint', async () => {
    const calls = [];
    const result = await prepareWorkspace(manifest(), {
      deps: {
        cwd: () => '/workspace/runtime',
        runProcess: async (cmd, args, options) => {
          calls.push({ cmd, args, options });
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls[0].options.cwd, '/workspace/runtime');
  });

  test('fails explicitly instead of launching against an empty repo after clone timeout', async () => {
    const calls = [];
    const m = manifest();
    const result = await prepareWorkspace(m, {
      deps: {
        workspaceCloneTimeoutMs: 25,
        runProcess: async (cmd, args, options) => {
          calls.push({ cmd, args, options });
          return { code: 124, timedOut: true, error: 'process timed out' };
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'workspace_clone_timeout');
    assert.equal(result.clone_failed, true);
    assert.equal(result.initialized_empty, false);
    assert.match(result.error, /timed out after 1s/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.timeoutMs, 25);
  });

  test('terminates subprocesses that exceed their timeout', async () => {
    const result = await runProcessDefault(process.execPath, [
      '-e',
      'setTimeout(() => {}, 1000)',
    ], { timeoutMs: 20 });

    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    assert.match(result.error, /timed out/);
  });

  test('terminates descendant processes that keep inherited pipes open', {
    skip: process.platform === 'win32',
  }, async () => {
    const started = Date.now();
    const result = await runProcessDefault(process.execPath, [
      '-e',
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
        'setTimeout(() => {}, 3000);',
      ].join(' '),
    ], { timeoutMs: 20 });

    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 1_000, 'the inherited pipe should not delay timeout completion');
  });

  test('terminates a subprocess when an outer watchdog aborts it', {
    skip: process.platform === 'win32',
  }, async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcessDefault(process.execPath, [
      '-e',
      'setTimeout(() => {}, 3000)',
    ], { timeoutMs: 3_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    const result = await pending;

    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 1_000, 'abort should not wait for the subprocess timeout');
  });

  test('reuses an existing git workspace instead of replacing it', async () => {
    const m = manifest();
    const result = await prepareWorkspace(m, {
      deps: {
        existsSync: (path) => path.endsWith('/.git'),
        runProcess: async () => assert.fail('must not clone an existing workspace'),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.reused_existing, true);
  });
});

describe('mc cloud-runtime coding bin snapshots', () => {
  test('restores a latest coding bin snapshot payload before provider launch', async () => {
    const m = manifest({
      coding_bin_id: 'cbin_runtime1',
      coding_bin: {
        id: 'cbin_runtime1',
        root: null,
        snapshot: { enabled: true, max_bytes: 1024 * 1024, max_files: 100 },
        latest_snapshot: {
          id: 'cbsnap_restore123',
          status: 'ready',
          payload: {
            method: 'GET',
            url: 'https://meetmemoro.test/api/mc/cloud-sessions/cld_runtime1/coding-bin-snapshots/cbsnap_restore123/payload',
            content_type: 'application/zstd',
          },
          file_count: 1,
          byte_count: 12,
          skipped_count: 0,
          base_ref: 'main',
          head_ref: 'abc123',
        },
      },
    });
    const calls = [];
    const removed = [];

    const res = await restoreCodingBinSnapshot(m, {
      token: 'mem_runtime_secret',
      cwd: m.runtime.cwd,
      paths: m.runtime.paths,
      runtimeGeneration: m.authorization.runtime_generation,
      authorizationDigest: m.authorization.authorization_digest,
      deps: {
        existsSync: (path) => path.endsWith('.mc-coding-bin-snapshot.json'),
        readFile: (path, enc) => {
          if (path.endsWith('.mc-coding-bin-snapshot.json')) {
            return JSON.stringify({ schema: 'mc-coding-bin-snapshot-v1', deleted_paths: ['src/removed.js'] });
          }
          return readFileSync(path, enc);
        },
        rm: (path) => { removed.push(path); },
        fetchImpl: async (url, opts) => {
          assert.equal(url, m.coding_bin.latest_snapshot.payload.url);
          assert.equal(opts.headers.Authorization, 'Bearer mem_runtime_secret');
          assert.equal(opts.headers['X-MC-Runtime-Generation'], m.authorization.runtime_generation);
          assert.equal(opts.headers['X-MC-Authorization-Digest'], m.authorization.authorization_digest);
          return new Response(Buffer.from('archive bytes'), {
            status: 200,
            headers: { 'Content-Length': '13' },
          });
        },
        runProcess: async (cmd, args) => {
          calls.push({ cmd, args });
          if (cmd === 'tar' && args.includes('-tf')) return { code: 0, stdout: '.mc-coding-bin-snapshot.json\nsrc/index.js\n', stderr: '' };
          if (cmd === 'tar' && args.includes('-xf')) return { code: 0, stdout: '', stderr: '' };
          return { code: 1, stderr: 'unexpected command' };
        },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.restored, true);
    assert.equal(res.snapshot.id, 'cbsnap_restore123');
    assert.equal(res.snapshot.status, 'restored');
    assert.equal(res.deleted_count, 1);
    assert.equal(calls.some((call) => call.cmd === 'tar' && call.args.includes('-xf')), true);
    assert.deepEqual(removed, [
      join(m.runtime.cwd, 'src/removed.js'),
      join(m.runtime.cwd, '.mc-coding-bin-snapshot.json'),
    ]);
  });

  test('captures and uploads a filtered coding bin snapshot without token-bearing argv', async () => {
    const m = manifest({
      coding_bin_id: 'cbin_runtime1',
      coding_bin: {
        id: 'cbin_runtime1',
        root: null,
        snapshot: {
          enabled: true,
          format: 'tar.zst',
          root: null,
          max_bytes: 1024 * 1024,
          max_files: 10,
          upload: {
            method: 'PUT',
            url_template: 'https://meetmemoro.test/api/mc/cloud-sessions/cld_runtime1/coding-bin-snapshots/{snapshot_id}/payload',
            content_type: 'application/zstd',
          },
          exclude: {
            paths: ['.git', '.env', 'node_modules'],
            globs: ['**/*token*', '**/*secret*', '**/*auth*.json'],
          },
        },
        latest_snapshot: null,
      },
    });
    const writes = [];
    const calls = [];
    const uploads = [];
    const removed = [];

    const res = await captureCodingBinSnapshot(m, {
      token: 'mem_runtime_secret',
      cwd: m.runtime.cwd,
      paths: m.runtime.paths,
      runtimeGeneration: m.authorization.runtime_generation,
      authorizationDigest: m.authorization.authorization_digest,
      deps: {
        randomUUID: () => '12345678-1234-1234-1234-123456789abc',
        writeFile: (path, value) => { writes.push({ path, value: String(value) }); },
        readFile: () => Buffer.from('archive bytes'),
        rm: (path) => { removed.push(path); },
        stat: () => ({ size: 13 }),
        fetchImpl: async (url, opts) => {
          uploads.push({ url, opts });
          return new Response(JSON.stringify({ ok: true }), { status: 201 });
        },
        runProcess: async (cmd, args) => {
          calls.push({ cmd, args });
          if (cmd === 'git' && args.includes('ls-files')) {
            return {
              code: 0,
              stdout: ['src/app.js', '.env', 'node_modules/pkg/index.js', 'notes-token.txt', 'docs/spec.md'].join('\0'),
              stderr: '',
            };
          }
          if (cmd === 'git' && args.includes('diff')) {
            return { code: 0, stdout: ['src/removed.js', '.env'].join('\0'), stderr: '' };
          }
          if (cmd === 'tar') return { code: 0, stdout: '', stderr: '' };
          if (cmd === 'git' && args.includes('--abbrev-ref')) return { code: 0, stdout: 'main\n', stderr: '' };
          if (cmd === 'git' && args.at(-1) === 'HEAD') return { code: 0, stdout: 'abc123\n', stderr: '' };
          return { code: 1, stderr: 'unexpected command' };
        },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.captured, true);
    assert.equal(res.snapshot.id, 'cbsnap_123456781234123412341234');
    assert.equal(res.snapshot.status, 'ready');
    assert.equal(res.file_count, 3);
    assert.equal(res.skipped_count, 4);
    assert.equal(res.deleted_count, 1);

    const fileList = writes.find((entry) => entry.path.endsWith('.files'));
    const snapshotManifest = writes.find((entry) => entry.path.endsWith('.mc-coding-bin-snapshot.json'));
    assert.ok(fileList);
    assert.ok(snapshotManifest);
    assert.equal(fileList.value.includes('src/app.js'), true);
    assert.equal(fileList.value.includes('docs/spec.md'), true);
    assert.equal(fileList.value.includes('.mc-coding-bin-snapshot.json'), true);
    assert.equal(fileList.value.includes('.env'), false);
    assert.equal(fileList.value.includes('node_modules'), false);
    assert.equal(fileList.value.includes('notes-token.txt'), false);
    assert.deepEqual(JSON.parse(snapshotManifest.value).deleted_paths, ['src/removed.js']);
    assert.deepEqual(removed, [join(m.runtime.cwd, '.mc-coding-bin-snapshot.json')]);

    const allArgs = JSON.stringify(calls.map((call) => call.args));
    assert.equal(allArgs.includes('mem_runtime_secret'), false);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].url.endsWith('/cbsnap_123456781234123412341234/payload'), true);
    assert.equal(uploads[0].opts.headers.Authorization, 'Bearer mem_runtime_secret');
    assert.equal(uploads[0].opts.headers['X-MC-Snapshot-File-Count'], '3');
    assert.equal(uploads[0].opts.headers['X-MC-Snapshot-Base-Ref'], 'main');
    assert.equal(uploads[0].opts.headers['X-MC-Snapshot-Head-Ref'], 'abc123');
    assert.equal(uploads[0].opts.headers['X-MC-Runtime-Generation'], m.authorization.runtime_generation);
    assert.equal(uploads[0].opts.headers['X-MC-Authorization-Digest'], m.authorization.authorization_digest);
  });
});

describe('mc cloud-runtime run', () => {
  test('fails closed before every credential or runtime side effect without trusted release inputs', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const calls = [];
    const code = await runCloudRuntimeWithDefault(parseArgs([
      'run', '--cloud-session-id', m.cloud_session_id, '--manifest', m.runtime.paths.manifest, '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, { MEMORO_TOKEN: 'mem_runtime_secret', MEMORO_BROKER_TOKEN: 'mem_broker_secret' }),
      resolveRuntimeToken: async () => { calls.push('token'); return 'must-not-resolve'; },
      getSecret: async () => { calls.push('secret'); return 'must-not-read'; },
      reportRuntimeStatus: async () => { calls.push('status'); return { ok: true }; },
      prepareWorkspace: async () => { calls.push('workspace'); return { ok: true }; },
      hydrateToolAuth: async () => { calls.push('hydrate'); return { ok: true }; },
      connectBroker: async () => { calls.push('broker'); return 0; },
      runCloudSessionWith: async () => { calls.push('provider'); return 0; },
    });

    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    const rendered = `${streams.out()}${streams.err()}`;
    assert.match(rendered, /release verification blocked/);
    assert.match(rendered, /platform_identity_unavailable/);
    assert.equal(rendered.includes('mem_runtime_secret'), false);
    assert.equal(rendered.includes('mem_broker_secret'), false);
  });

  test('maps a missing installed-byte verifier result to release_artifact_mismatch', async () => {
    const result = await verifyRuntimeRelease({
      manifest: manifest(),
      runtimeAuthorization: {
        runtimeGeneration: 'rtg_0123456789abcdef',
        authorizationDigest: 'a'.repeat(64),
      },
      deps: {
        loadTrustedReleaseInputs: async () => ({ release_trust_inputs: { opaque: true } }),
        verifyReleaseTrust: async () => ({ ok: true, release_id: 'rel_1', release_epoch: 1, next_state: {} }),
        verifyInstalledReleaseArtifacts: async () => ({ ok: false }),
        commitTrustedReleaseState: async () => true,
      },
    });
    assert.deepEqual(result, { ok: false, code: 'release_artifact_mismatch' });
  });

  test('builds release identity and nonce from the local manifest and supervisor authorization', async () => {
    const m = manifest();
    const calls = [];
    const result = await verifyRuntimeRelease({
      manifest: m,
      runtimeAuthorization: {
        runtimeGeneration: m.authorization.runtime_generation,
        authorizationDigest: m.authorization.authorization_digest,
      },
      deps: {
        now: () => Date.parse('2026-07-26T12:00:00Z'),
        loadTrustedReleaseInputs: async (binding) => {
          calls.push(['load', binding]);
          return { release_trust_inputs: { now_ms: 0, expected_platform: {} } };
        },
        verifyReleaseTrust: async (input) => {
          calls.push(['verify', input]);
          assert.equal(input.now_ms, Date.parse('2026-07-26T12:00:00Z'));
          assert.deepEqual(input.expected_platform, {
            account_id: m.account_id,
            cloud_session_id: m.cloud_session_id,
            coding_session_id: m.coding_session_id,
            runtime_generation: m.authorization.runtime_generation,
            authorization_digest: m.authorization.authorization_digest,
            nonce: m.authorization.authorization_digest,
          });
          return { ok: true, release_id: 'rel_1', release_epoch: 1, artifact_descriptor: {}, next_state: { release_epochs: { stable: 1 } } };
        },
        verifyInstalledReleaseArtifacts: async (input) => {
          calls.push(['artifacts', input]);
          return { ok: true };
        },
        commitTrustedReleaseState: async (input) => {
          calls.push(['commit', input]);
          assert.deepEqual(input, {
            binding: {
              account_id: m.account_id,
              cloud_session_id: m.cloud_session_id,
              coding_session_id: m.coding_session_id,
              runtime_generation: m.authorization.runtime_generation,
              authorization_digest: m.authorization.authorization_digest,
              nonce: m.authorization.authorization_digest,
            },
            next_state: { release_epochs: { stable: 1 } },
          });
          return { ok: true };
        },
      },
    });
    assert.deepEqual(result, { ok: true, release_id: 'rel_1', release_epoch: 1 });
    assert.deepEqual(calls.map(([name]) => name), ['load', 'verify', 'artifacts', 'commit']);
  });

  test('requires an atomic trusted watermark commit before token or runtime side effects', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const calls = [];
    const code = await runCloudRuntimeWithDefault(parseArgs([
      'run', '--cloud-session-id', m.cloud_session_id, '--manifest', m.runtime.paths.manifest,
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, { MEMORO_TOKEN: 'mem_runtime_secret', MEMORO_BROKER_TOKEN: 'mem_broker_secret' }),
      loadTrustedReleaseInputs: async () => ({ release_trust_inputs: {} }),
      verifyReleaseTrust: async () => ({ ok: true, release_id: 'rel_1', release_epoch: 1, next_state: { release_epochs: { stable: 1 } } }),
      verifyInstalledReleaseArtifacts: async () => ({ ok: true }),
      resolveRuntimeToken: async () => { calls.push('token'); return 'must-not-resolve'; },
      prepareWorkspace: async () => { calls.push('workspace'); return { ok: true }; },
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.match(streams.err(), /platform_identity_unavailable/);
  });

  test('maps rejected or throwing trusted watermark commits to the stable blocked code', async () => {
    for (const commitTrustedReleaseState of [async () => false, async () => { throw new Error('commit canary'); }]) {
      const result = await verifyRuntimeRelease({
        manifest: manifest(),
        runtimeAuthorization: { runtimeGeneration: 'rtg_0123456789abcdef', authorizationDigest: 'a'.repeat(64) },
        deps: {
          loadTrustedReleaseInputs: async () => ({ release_trust_inputs: {} }),
          verifyReleaseTrust: async () => ({ ok: true, release_id: 'rel_1', release_epoch: 1, next_state: {} }),
          verifyInstalledReleaseArtifacts: async () => ({ ok: true }),
          commitTrustedReleaseState,
        },
      });
      assert.deepEqual(result, { ok: false, code: 'platform_identity_unavailable' });
    }
  });

  test('does not expose trusted-loader errors at the release gate', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const canary = 'Bearer mem_release_loader_canary_0123456789';
    const code = await runCloudRuntimeWithDefault(parseArgs([
      'run', '--cloud-session-id', m.cloud_session_id, '--manifest', m.runtime.paths.manifest, '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m),
      loadTrustedReleaseInputs: async () => { throw new Error(canary); },
    });
    const rendered = `${streams.out()}${streams.err()}`;
    assert.equal(code, 1);
    assert.match(rendered, /platform_identity_unavailable/);
    assert.equal(rendered.includes('loader_canary'), false);
    assert.equal(rendered.includes('Bearer'), false);
  });

  test('rejects missing or unknown manifest contract before token or workspace side effects', async () => {
    for (const contractVersion of [undefined, 'mc-cloud-runtime-v0']) {
      const streams = io();
      const m = manifest();
      if (contractVersion === undefined) delete m.contract_version;
      else m.contract_version = contractVersion;
      writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
      let keychainRead = false;
      const code = await runCloudRuntimeWith(parseArgs([
        'run', '--cloud-session-id', m.cloud_session_id, '--manifest', m.runtime.paths.manifest,
      ]), {
        stdout: streams.stdout,
        stderr: streams.stderr,
        env: runtimeEnv(m),
        getSecret: async () => { keychainRead = true; return 'must-not-read'; },
        runProcess: async () => assert.fail('must not prepare workspace for an invalid manifest contract'),
        prepareWorkspace: async () => assert.fail('must not prepare workspace for an invalid manifest contract'),
      });

      assert.equal(code, 2);
      assert.match(streams.err(), /unsupported manifest contract/);
      assert.equal(keychainRead, false);
    }
  });

  test('requires matching supervisor authorization metadata before token or workspace side effects', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    let keychainRead = false;
    const code = await runCloudRuntimeWith(parseArgs([
      'run', '--cloud-session-id', m.cloud_session_id, '--manifest', m.runtime.paths.manifest,
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { MEMORO_TOKEN: 'mem_runtime_secret', MEMORO_BROKER_TOKEN: 'mem_broker_secret' },
      getSecret: async () => { keychainRead = true; return 'must-not-read'; },
      runProcess: async () => assert.fail('must not prepare workspace without supervisor authorization metadata'),
      prepareWorkspace: async () => assert.fail('must not prepare workspace without supervisor authorization metadata'),
      runCloudSessionWith: async () => assert.fail('must not launch without supervisor authorization metadata'),
      connectBroker: async () => assert.fail('must not connect without supervisor authorization metadata'),
    });

    assert.equal(code, 2);
    assert.match(streams.err(), /missing from supervisor environment/);
    assert.equal(keychainRead, false);
  });

  test('rejects mismatched supervisor authorization metadata without leaking the digest', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const code = await runCloudRuntimeWith(parseArgs([
      'run', '--cloud-session-id', m.cloud_session_id, '--manifest', m.runtime.paths.manifest, '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, {
        MEMORO_TOKEN: 'mem_runtime_secret',
        MEMORO_BROKER_TOKEN: 'mem_broker_secret',
        MC_CLOUD_AUTHORIZATION_DIGEST: 'b'.repeat(64),
      }),
      runProcess: async () => assert.fail('must not prepare workspace after authorization mismatch'),
    });

    const rendered = `${streams.out()}${streams.err()}`;
    assert.equal(code, 2);
    assert.match(rendered, /does not match supervisor environment/);
    assert.equal(rendered.includes(m.authorization.authorization_digest), false);
    assert.equal(rendered.includes('b'.repeat(64)), false);
  });

  test('runs the production Codex isolation preflight before workspace, provider, or broker spawn', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const reports = [];
    const code = await runCloudRuntimeWith(parseArgs([
      'run', '--cloud-session-id', m.cloud_session_id, '--manifest', m.runtime.paths.manifest,
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, { MEMORO_TOKEN: 'mem_runtime_secret', MEMORO_BROKER_TOKEN: 'mem_broker_secret' }),
      reportRuntimeStatus: async (report) => { reports.push(report); return { ok: true }; },
      runProcess: async () => assert.fail('Codex isolation failure must stop before workspace process spawn'),
      prepareWorkspace: async () => assert.fail('Codex isolation failure must stop before workspace preparation'),
      runCloudSessionWith: async () => assert.fail('Codex isolation failure must stop before provider spawn'),
      launchBrokerOwnedSession: async () => assert.fail('Codex isolation failure must stop before provider launch'),
      connectBroker: async () => assert.fail('Codex isolation failure must stop before broker spawn'),
    });

    assert.equal(code, 1);
    assert.match(streams.err(), /disabled until provider credentials are isolated/);
    assert.ok(reports.some((entry) => entry.report?.error_code === 'cloud-codex-auth-isolation-unavailable'));
    assert.equal(`${streams.out()}${streams.err()}`.includes(m.authorization.authorization_digest), false);
  });

  test('never reaches readiness for a repository-required manifest without a clone target', async () => {
    const streams = io();
    const m = manifest();
    m.launch.tool = 'claude';
    m.repo.ref = 'not a clone target';
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const reports = [];

    const code = await runCloudRuntimeWith(parseArgs([
      'run',
      '--cloud-session-id',
      m.cloud_session_id,
      '--manifest',
      m.runtime.paths.manifest,
      '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, { MEMORO_TOKEN: 'mem_runtime_secret', MEMORO_BROKER_TOKEN: 'mem_broker_secret' }),
      reportRuntimeStatus: async (report) => { reports.push(report); return { ok: true }; },
      runProcess: async () => assert.fail('must not initialize or clone a workspace'),
      runCloudSessionWith: async () => assert.fail('must not launch a cloud session'),
      connectBroker: async () => assert.fail('must not connect a broker'),
    });

    assert.equal(code, 1);
    assert.match(streams.err(), /valid clone target/);
    const failed = reports.map((entry) => entry.report || entry).find((report) => (
      report.error_code === 'repository_clone_target_missing'
    ));
    assert.ok(failed);
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.process_status, 'exited');
    assert.equal(JSON.parse(readFileSync(m.runtime.paths.status, 'utf8')).phase, 'failed');
  });

  test('fails explicitly when workspace preparation never settles', async () => {
    const streams = io();
    const m = manifest();
    m.launch.tool = 'claude';
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const reports = [];
    const started = Date.now();

    const code = await runCloudRuntimeWith(parseArgs([
      'run',
      '--cloud-session-id',
      m.cloud_session_id,
      '--manifest',
      m.runtime.paths.manifest,
      '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, { MEMORO_TOKEN: 'mem_runtime_secret', MEMORO_BROKER_TOKEN: 'mem_broker_secret' }),
      workspacePrepareTimeoutMs: 20,
      prepareWorkspace: async () => new Promise(() => {}),
      reportRuntimeStatus: async (report) => { reports.push(report); return { ok: true }; },
    });

    assert.equal(code, 1);
    assert.ok(Date.now() - started < 1_000);
    assert.match(streams.err(), /workspace prepare timed out/);
    const failed = reports.map((entry) => entry.report || entry).find((report) => (
      report.error_code === 'workspace_prepare_timeout'
    ));
    assert.ok(failed);
    assert.equal(failed.process_status, 'exited');
    assert.equal(failed.events[0].type, 'workspace.prepare.failed');
  });

  test('prepares workspace, launches typed cloud-session, reports status, then connects broker', async () => {
    const streams = io();
    const m = manifest();
    m.launch.tool = 'claude';
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const reports = [];
    const launchCalls = [];
    const providerLaunches = [];
    const brokerCalls = [];
    const gitCalls = [];
    const persistWatchers = [];

    const code = await runCloudRuntimeWith(parseArgs([
      'run',
      '--cloud-session-id',
      m.cloud_session_id,
      '--manifest',
      m.runtime.paths.manifest,
      '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, {
        MEMORO_TOKEN: 'mem_runtime_secret',
        MEMORO_BROKER_TOKEN: 'mem_broker_secret',
        MC_CLOUD_GIT_TOKEN: 'ghp_private_secret',
        MC_CODEX_API_KEY: 'sk_codex_private_secret',
        OPENAI_API_KEY: 'sk_product_secret',
      }),
      now: () => '2026-07-13T12:00:00.000Z',
      reportRuntimeStatus: async (report) => { reports.push(report); return { ok: true }; },
      runProcess: async (cmd, args, options) => {
        gitCalls.push({ cmd, args, options });
        return { code: 0, stdout: '', stderr: '' };
      },
      runCloudSessionWith: async (opts, deps) => {
        launchCalls.push({ opts, deps });
        await deps.launchBrokerOwnedSession({
          attachAfterLaunch: true,
          cloudBroker: { sourceKind: 'cloud' },
        });
        deps.stdout.write(JSON.stringify({
          ok: true,
          cloud_session_id: m.cloud_session_id,
          coding_session_id: 'sess_runtime1',
          source_id: 'cloud:cld_runtime1',
        }));
        return 0;
      },
      launchBrokerOwnedSession: async (args) => {
        providerLaunches.push(args);
        return { code: 0, codingSessionId: 'sess_runtime1', attached: false };
      },
      connectBroker: async (args) => {
        brokerCalls.push(args);
        await args.onConnected();
        await persistWatchers[0].onResult({
          ok: true,
          tool: 'codex',
          label: 'tool_auth.codex',
          present: true,
          hydrated: true,
          persisted: true,
          repair_required: false,
        });
        return 0;
      },
      hydrateToolAuth: async () => ({
        ok: true,
        tool: 'codex',
        label: 'tool_auth.codex',
        present: true,
        hydrated: true,
        repair_required: false,
        env: { CODEX_HOME: '/tmp/mc-cloud-codex-home' },
      }),
      startToolAuthPersistWatcher: (args) => {
        persistWatchers.push(args);
        return async () => null;
      },
    });

    assert.equal(code, 0);
    assert.equal(streams.err(), '');
    assert.equal(gitCalls.length, 1);
    assert.equal(JSON.stringify(gitCalls[0].args).includes('ghp_private_secret'), false);
    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].deps.env.MEMORO_TOKEN, undefined);
    assert.equal(launchCalls[0].deps.env.MEMORO_BROKER_TOKEN, undefined);
    assert.equal(launchCalls[0].deps.env.CODEX_HOME, '/tmp/mc-cloud-codex-home');
    assert.equal(launchCalls[0].deps.env.MC_CLOUD_GIT_TOKEN, undefined);
    assert.equal(launchCalls[0].deps.env.MC_CODEX_API_KEY, undefined);
    assert.equal(launchCalls[0].deps.env.OPENAI_API_KEY, undefined);
    assert.equal(launchCalls[0].deps.env.MC_CLOUD_RUNTIME_GENERATION, undefined);
    assert.equal(launchCalls[0].deps.env.MC_CLOUD_AUTHORIZATION_DIGEST, undefined);
    assert.equal(providerLaunches.length, 1);
    assert.equal(providerLaunches[0].attachAfterLaunch, false);
    assert.equal((await providerLaunches[0].ensureCloudBroker()).supervisor_managed, true);
    assert.equal(brokerCalls.length, 1);
    assert.equal(brokerCalls[0].env.MEMORO_TOKEN, undefined);
    assert.equal(brokerCalls[0].env.MEMORO_BROKER_TOKEN, 'mem_broker_secret');
    assert.equal(brokerCalls[0].env.MC_CLOUD_RUNTIME_GENERATION, undefined);
    assert.equal(brokerCalls[0].env.MC_CLOUD_AUTHORIZATION_DIGEST, undefined);
    assert.equal(JSON.stringify(launchCalls[0].opts).includes('mem_runtime_secret'), false);
    assert.equal(JSON.stringify(launchCalls[0].opts).includes('mem_broker_secret'), false);
    assert.equal(typeof brokerCalls[0].onConnected, 'function');
    assert.equal(persistWatchers.length, 1);
    assert.equal(persistWatchers[0].env.CODEX_HOME, '/tmp/mc-cloud-codex-home');
    assert.equal(brokerCalls[0].manifest.cloud_session_id, m.cloud_session_id);
    assert.ok(reports.length >= 4);
    assert.ok(reports.every((entry) => entry.token === 'mem_runtime_secret'));
    assert.ok(reports.every((entry) => entry.runtimeGeneration === m.authorization.runtime_generation));
    assert.ok(reports.every((entry) => entry.authorizationDigest === m.authorization.authorization_digest));
    assert.equal(reports.some((entry) => JSON.stringify(entry.report).includes('mem_runtime_secret')), false);
    assert.equal(reports.some((entry) => JSON.stringify(entry.report).includes('mem_broker_secret')), false);
    assert.equal(reports.some((entry) => JSON.stringify(entry.report).includes(m.authorization.authorization_digest)), false);
    assert.equal(reports.at(-1).cloudSessionId, m.cloud_session_id);
    const reportPayloads = reports.map((entry) => entry.report || entry);
    const readyReport = reportPayloads.find((report) => report.phase === 'ready' && report.runtime_state === 'ready');
    assert.ok(readyReport);
    assert.equal(readyReport.readiness.broker.connected, true);
    const persistReport = reportPayloads.find((report) => (
      report.phase === 'ready'
      && report.events?.some((event) => event.type === 'tool.auth_persist.finished')
    ));
    assert.ok(persistReport);
    assert.equal(persistReport.readiness.broker.connected, true);

    const status = JSON.parse(readFileSync(m.runtime.paths.status, 'utf8'));
    const events = readFileSync(m.runtime.paths.events, 'utf8');
    const readiness = JSON.parse(readFileSync(m.runtime.paths.readiness, 'utf8'));
    const eventTypes = events.trim().split('\n').map((line) => JSON.parse(line).type);
    const rendered = JSON.stringify({ status, events, readiness });
    assert.equal(rendered.includes('mem_runtime_secret'), false);
    assert.equal(rendered.includes('mem_broker_secret'), false);
    assert.equal(rendered.includes('ghp_private_secret'), false);
    assert.equal(rendered.includes('sk_product_secret'), false);
    assert.equal(rendered.includes(m.authorization.authorization_digest), false);
    assert.equal(readiness.repo.cloned, true);
    assert.equal(readiness.git.ready, true);
    assert.equal(readiness.git_auth.ready, true);
    assert.equal(readiness.vault.exposes_secrets_to_llm, false);
    assert.equal(readiness.tool_auth.ready, true);
    assert.equal(readiness.broker.connected, true);
    assert.ok(eventTypes.includes('workspace.prepare.started'));
    assert.ok(eventTypes.includes('workspace.prepare.inspecting'));
    assert.ok(eventTypes.includes('workspace.clone.started'));
    assert.ok(eventTypes.includes('workspace.clone.finished'));
    assert.ok(eventTypes.includes('workspace.prepare.finished'));
    assert.ok(eventTypes.includes('provider.launch.started'));
    assert.ok(eventTypes.includes('provider.launch.finished'));
    assert.ok(eventTypes.includes('broker.connecting'));
    assert.ok(eventTypes.includes('broker.connected'));
    assert.ok(eventTypes.includes('runtime.ready'));
  });

  test('fails before launch when the runtime token is missing', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const reports = [];
    let keychainRead = false;

    const code = await runCloudRuntimeWith(parseArgs([
      'run',
      '--cloud-session-id',
      m.cloud_session_id,
      '--manifest',
      m.runtime.paths.manifest,
      '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m),
      getSecret: async () => { keychainRead = true; return 'must-not-read'; },
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      reportRuntimeStatus: async (report) => { reports.push(report); return { ok: true }; },
      runProcess: async () => assert.fail('must not prepare workspace without a runtime token'),
      runCloudSessionWith: async () => assert.fail('must not launch without a runtime token'),
      connectBroker: async () => assert.fail('must not connect broker without a runtime token'),
    });

    assert.equal(code, 1);
    assert.match(streams.err(), /runtime token missing/);
    assert.equal(keychainRead, false);
    assert.equal(reports.length, 0);
    const status = JSON.parse(readFileSync(m.runtime.paths.status, 'utf8'));
    assert.equal(status.phase, 'failed');
    assert.equal(JSON.stringify(status).includes('runtime token missing'), true);
  });

  test('fails closed when the broker token is absent and never borrows the runtime token', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const reports = [];

    const code = await runCloudRuntimeWith(parseArgs([
      'run',
      '--cloud-session-id',
      m.cloud_session_id,
      '--manifest',
      m.runtime.paths.manifest,
      '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, { MEMORO_TOKEN: 'mem_runtime_secret' }),
      reportRuntimeStatus: async (report) => { reports.push(report); return { ok: true }; },
      runProcess: async () => assert.fail('must not prepare workspace without a broker token'),
      runCloudSessionWith: async () => assert.fail('must not launch without a broker token'),
      connectBroker: async () => assert.fail('must not connect with the runtime token'),
    });

    assert.equal(code, 1);
    assert.match(streams.err(), /broker token missing/);
    assert.ok(reports.length >= 2);
    assert.ok(reports.every((entry) => entry.token === 'mem_runtime_secret'));
    const status = JSON.parse(readFileSync(m.runtime.paths.status, 'utf8'));
    const readiness = JSON.parse(readFileSync(m.runtime.paths.readiness, 'utf8'));
    const rendered = JSON.stringify({ status, readiness, stdout: streams.out(), stderr: streams.err() });
    assert.equal(status.error_code, 'broker_token_missing');
    assert.equal(rendered.includes('mem_runtime_secret'), false);
    assert.equal(rendered.includes('MEMORO_TOKEN'), false);
  });

  test('captures a coding bin snapshot and reports sleeping on runtime shutdown', async () => {
    const streams = io();
    const m = manifest({
      coding_bin_id: 'cbin_runtime1',
      coding_bin: {
        id: 'cbin_runtime1',
        root: null,
        latest_snapshot: null,
        snapshot: {
          enabled: true,
          max_bytes: 1024 * 1024,
          max_files: 10,
          upload: {
            method: 'PUT',
            url_template: 'https://meetmemoro.test/api/mc/cloud-sessions/cld_runtime1/coding-bin-snapshots/{snapshot_id}/payload',
            content_type: 'application/zstd',
          },
          exclude: { paths: ['.env'], globs: ['**/*token*'] },
        },
      },
    });
    m.launch.tool = 'claude';
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const reports = [];
    const signalHandlers = {};
    const exits = [];

    const code = await runCloudRuntimeWith(parseArgs([
      'run',
      '--cloud-session-id',
      m.cloud_session_id,
      '--manifest',
      m.runtime.paths.manifest,
      '--json',
    ]), {
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: runtimeEnv(m, {
        MEMORO_TOKEN: 'mem_runtime_secret',
        MEMORO_BROKER_TOKEN: 'mem_broker_secret',
        MC_CLOUD_GIT_TOKEN: 'ghp_private_secret',
      }),
      now: () => '2026-07-13T12:00:00.000Z',
      process: {
        once: (signal, handler) => { signalHandlers[signal] = handler; },
        off: () => {},
        exit: (exitCode) => { exits.push(exitCode); },
      },
      reportRuntimeStatus: async (report) => { reports.push(report.report); return { ok: true }; },
      runProcess: async (cmd, args) => {
        if (cmd === 'git' && args.includes('ls-files')) {
          return { code: 0, stdout: ['src/app.js', '.env', 'notes-token.txt'].join('\0'), stderr: '' };
        }
        if (cmd === 'git' && args.includes('--abbrev-ref')) return { code: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'git' && args.at(-1) === 'HEAD') return { code: 0, stdout: 'abc123\n', stderr: '' };
        if (cmd === 'git') return { code: 0, stdout: '', stderr: '' };
        if (cmd === 'tar') return { code: 0, stdout: '', stderr: '' };
        return { code: 1, stderr: 'unexpected command' };
      },
      runCloudSessionWith: async (opts, deps) => {
        deps.stdout.write(JSON.stringify({
          ok: true,
          cloud_session_id: m.cloud_session_id,
          coding_session_id: 'sess_runtime1',
          source_id: 'cloud:cld_runtime1',
        }));
        return 0;
      },
      connectBroker: async () => {
        signalHandlers.SIGTERM('SIGTERM');
        return 0;
      },
      hydrateToolAuth: async () => ({
        ok: true,
        tool: 'codex',
        label: 'tool_auth.codex',
        present: true,
        hydrated: true,
        repair_required: false,
        env: { CODEX_HOME: '/tmp/mc-cloud-codex-home' },
      }),
      startToolAuthPersistWatcher: () => async () => null,
      randomUUID: () => '87654321-4321-4321-4321-cba987654321',
      readFile: (path, enc) => {
        if (path === m.runtime.paths.manifest) return readFileSync(path, enc);
        return Buffer.from('archive bytes');
      },
      stat: () => ({ size: 13 }),
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
    });

    assert.equal(code, 0);
    assert.deepEqual(exits, [0]);
    const sleeping = reports.find((report) => report.phase === 'sleeping' && report.coding_bin_snapshot);
    assert.ok(sleeping);
    assert.equal(sleeping.coding_bin_snapshot.id, 'cbsnap_87654321432143214321cba9');
    assert.equal(sleeping.coding_bin_snapshot.status, 'ready');
    assert.equal(sleeping.coding_bin_snapshot.fileCount, 1);
    assert.equal(sleeping.coding_bin_snapshot.skippedCount, 2);
    const status = JSON.parse(readFileSync(m.runtime.paths.status, 'utf8'));
    assert.equal(status.phase, 'sleeping');
    assert.equal(status.coding_bin_snapshot_id, 'cbsnap_87654321432143214321cba9');
  });
});
