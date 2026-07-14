import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs, run as runCommand } from '../../src/mc/commands/cloud-runtime.js';
import { runCloudRuntimeSupervisor } from '../../src/mc/cloud-runtime/supervisor.js';
import { prepareCloudRuntimeRepo, repoCloneUrl } from '../../src/mc/cloud-runtime/repo.js';
import { captureCodingBinSnapshot } from '../../src/mc/cloud-runtime/snapshot.js';

describe('mc cloud-runtime command', () => {
  test('parses run arguments', () => {
    assert.deepEqual(parseArgs([
      'run',
      '--cloud-session-id', 'cld_abc123',
      '--manifest', '/workspace/mc-runtime/manifest.json',
      '--json',
      '--once',
    ]), {
      verb: 'run',
      cloudSessionId: 'cld_abc123',
      manifest: '/workspace/mc-runtime/manifest.json',
      json: true,
      once: true,
      help: false,
    });
  });

  test('run --help exits without requiring a manifest', async () => {
    let out = '';
    const code = await runCommand(['run', '--help'], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 0);
    assert.match(out, /mc cloud-runtime/);
  });
});

describe('cloud runtime repo prep', () => {
  test('maps GitHub shorthand to clone URL', () => {
    assert.equal(repoCloneUrl('martinforsberg81/memoro'), 'https://github.com/martinforsberg81/memoro.git');
  });

  test('uses an env-based credential helper without putting the token in argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-cloud-runtime-repo-'));
    const calls = [];
    try {
      const result = await prepareCloudRuntimeRepo({
        root: join(dir, 'repo'),
        manifest: { repo: { ref: 'martinforsberg81/memoro', workspace_ref: 'main' } },
        env: { MC_CLOUD_GIT_TOKEN: 'ghp_secretvalue123456789' },
        spawn: (cmd, args, opts) => {
          calls.push({ cmd, args, env: opts.env });
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(calls[0].cmd, 'git');
      assert.equal(calls[0].args.includes('ghp_secretvalue123456789'), false);
      assert.equal(calls[0].args.join(' ').includes('$MC_CLOUD_GIT_TOKEN'), true);
      assert.equal(calls[0].env.MC_CLOUD_GIT_TOKEN, 'ghp_secretvalue123456789');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runCloudRuntimeSupervisor', () => {
  test('writes files, reports ready, launches broker session, and keeps secrets out of public payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-cloud-runtime-'));
    const runtimeDir = join(dir, 'runtime');
    const repoRoot = join(dir, 'repo');
    const manifestPath = join(runtimeDir, 'manifest.json');
    const statusPath = join(runtimeDir, 'status.json');
    const readinessPath = join(runtimeDir, 'readiness.json');
    const eventsPath = join(runtimeDir, 'events.jsonl');
    const manifest = {
      contract_version: 'mc-cloud-runtime-v1',
      cloud_session_id: 'cld_test123',
      coding_session_id: 'sess_cloud123',
      coding_bin_id: 'cbin_test123',
      coding_bin: {
        root: repoRoot,
        latest_snapshot: {
          id: 'cbsnap_restore123',
          payload: { method: 'GET', url: 'https://memoro.test/snapshot', content_type: 'application/zstd' },
          base_ref: 'main',
          head_ref: 'feature',
          file_count: 3,
          byte_count: 42,
          skipped_count: 1,
        },
      },
      source: { id: 'cloud:cld_test123', name: 'Memoro Cloud' },
      launch: { name: 'cloud-main', task: 'fix the thing', tool: 'codex', policy: 'workspace-write' },
      repo: {
        ref: 'martinforsberg81/memoro',
        workspace_ref: 'main',
        access: 'private',
        git_auth: { credential_source: 'vault_capability', ready: true, secret_boundary: 'status_only' },
      },
      runtime: {
        api_url: 'https://memoro.test',
        sandbox_id: 'sbx_123',
        process_id: 'proc_123',
        paths: { dir: runtimeDir, status: statusPath, readiness: readinessPath, events: eventsPath },
      },
    };

    const posts = [];
    const brokerRequests = [];
    const spawnCalls = [];
    let stdout = '';
    try {
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

      const result = await runCloudRuntimeSupervisor({
        cloudSessionId: 'cld_test123',
        manifest: manifestPath,
        json: true,
        once: true,
      }, {
        env: {
          MEMORO_TOKEN: 'mem_runtime_secret_123456789',
          MC_CLOUD_GIT_TOKEN: 'ghp_secretvalue123456789',
        },
        readConfig: false,
        now: () => '2026-07-14T10:00:00.000Z',
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: () => {} },
        spawn: (cmd, args, opts) => {
          spawnCalls.push({ cmd, args, env: opts.env });
          return { status: 0, stdout: '', stderr: '' };
        },
        fetch: async (url, options) => {
          posts.push({ url, options, body: JSON.parse(options.body) });
          return { ok: true, status: 200, text: async () => '{"ok":true}' };
        },
        restoreSnapshot: async (snapshot, opts) => ({
          ok: true,
          restored: true,
          snapshot_id: snapshot.id,
          byte_count: 42,
          root: opts.root,
        }),
        ensureBroker: async () => ({ ok: true, started: true, broker: { pid: 1234 } }),
        request: async (message) => {
          brokerRequests.push(message);
          if (message.type === 'session_status') return { ok: false, error: 'unknown' };
          if (message.type === 'launch_session') {
            return { ok: true, session: { id: message.session.id, session_state: 'live', tool: message.session.tool } };
          }
          return { ok: true };
        },
        connectCloud: async () => ({ ok: true, once: true, machine_id: 'cloud-test', sessions_count: 1 }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.status.phase, 'ready');
      assert.equal(result.status.coding_bin_snapshot.status, 'restored');

      const status = JSON.parse(await readFile(statusPath, 'utf8'));
      const readiness = JSON.parse(await readFile(readinessPath, 'utf8'));
      const events = await readFile(eventsPath, 'utf8');
      assert.equal(status.phase, 'ready');
      assert.equal(readiness.ready, true);
      assert.match(events, /runtime.provider_launched/);

      const launch = brokerRequests.find((message) => message.type === 'launch_session');
      assert.equal(launch.session.cwd, repoRoot);
      assert.equal(launch.session.launch_options.startupMessage, 'fix the thing');
      assert.equal(launch.session.env_unset.includes('MEMORO_TOKEN'), true);
      assert.equal(launch.session.env_unset.includes('MC_CLOUD_GIT_TOKEN'), true);
      assert.equal(launch.session.env.MEMORO_TOKEN, undefined);
      assert.equal(launch.session.env.MC_CLOUD_GIT_TOKEN, undefined);

      assert.equal(spawnCalls[0].args.join(' ').includes('ghp_secretvalue123456789'), false);
      assert.equal(spawnCalls[0].args.join(' ').includes('$MC_CLOUD_GIT_TOKEN'), true);
      assert.equal(posts.length >= 2, true);
      assert.equal(posts[0].url, 'https://memoro.test/api/mc/cloud-sessions/cld_test123/runtime-status');
      assert.equal(posts[0].options.headers.Authorization, 'Bearer mem_runtime_secret_123456789');

      const publicPayload = [
        stdout,
        JSON.stringify(posts.map((post) => post.body)),
        await readFile(statusPath, 'utf8'),
        await readFile(readinessPath, 'utf8'),
        events,
      ].join('\n');
      assert.equal(publicPayload.includes('mem_runtime_secret_123456789'), false);
      assert.equal(publicPayload.includes('ghp_secretvalue123456789'), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('captures and uploads a coding bin snapshot when the cloud bridge exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-cloud-runtime-sleep-'));
    const runtimeDir = join(dir, 'runtime');
    const repoRoot = join(dir, 'repo');
    const manifestPath = join(runtimeDir, 'manifest.json');
    const statusPath = join(runtimeDir, 'status.json');
    const readinessPath = join(runtimeDir, 'readiness.json');
    const eventsPath = join(runtimeDir, 'events.jsonl');
    const manifest = {
      cloud_session_id: 'cld_sleep123',
      coding_session_id: 'sess_sleep123',
      coding_bin_id: 'cbin_sleep123',
      coding_bin: {
        root: repoRoot,
        snapshot: {
          enabled: true,
          upload: { method: 'PUT', url_template: 'https://memoro.test/snapshots/{snapshot_id}/payload' },
        },
      },
      runtime: {
        api_url: 'https://memoro.test',
        paths: { dir: runtimeDir, status: statusPath, readiness: readinessPath, events: eventsPath },
      },
    };
    const posts = [];
    let stopped = false;

    try {
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

      const result = await runCloudRuntimeSupervisor({
        cloudSessionId: 'cld_sleep123',
        manifest: manifestPath,
        json: false,
        once: false,
      }, {
        env: { MEMORO_TOKEN: 'mem_runtime_secret_123456789' },
        readConfig: false,
        now: () => '2026-07-14T12:00:00.000Z',
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        spawn: () => ({ status: 0, stdout: '', stderr: '' }),
        fetch: async (url, options) => {
          posts.push({ url, options, body: JSON.parse(options.body) });
          return { ok: true, status: 200, text: async () => '{"ok":true}' };
        },
        restoreSnapshot: async () => ({ ok: true, skipped: true, reason: 'no_payload_url' }),
        captureSnapshot: async (policy, opts) => {
          assert.equal(policy.enabled, true);
          assert.equal(opts.root, repoRoot);
          assert.equal(opts.token, 'mem_runtime_secret_123456789');
          return {
            ok: true,
            uploaded: true,
            snapshot_id: 'cbsnap_sleep123',
            file_count: 2,
            byte_count: 99,
            skipped_count: 1,
            base_ref: 'main',
            head_ref: 'abc123',
          };
        },
        ensureBroker: async () => ({ ok: true, started: true, broker: { pid: 1234 } }),
        request: async (message) => {
          if (message.type === 'session_status') return { ok: false, error: 'unknown' };
          if (message.type === 'launch_session') return { ok: true, session: { id: message.session.id, session_state: 'live' } };
          return { ok: true };
        },
        connectCloud: async () => ({
          ok: true,
          machine_id: 'cloud-test',
          wait: async () => {},
          stop: () => { stopped = true; },
        }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.sleep.status.phase, 'sleeping');
      assert.equal(result.sleep.status.coding_bin_snapshot.id, 'cbsnap_sleep123');
      assert.equal(result.sleep.status.coding_bin_snapshot.status, 'ready');
      assert.equal(stopped, true);

      const status = JSON.parse(await readFile(statusPath, 'utf8'));
      const events = await readFile(eventsPath, 'utf8');
      assert.equal(status.phase, 'sleeping');
      assert.equal(status.coding_bin_snapshot_id, 'cbsnap_sleep123');
      assert.match(events, /runtime.coding_bin_snapshot/);

      const sleepingPost = posts.at(-1).body;
      assert.equal(sleepingPost.phase, 'sleeping');
      assert.equal(sleepingPost.coding_bin_snapshot.id, 'cbsnap_sleep123');
      assert.equal(JSON.stringify(sleepingPost).includes('mem_runtime_secret_123456789'), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fails into status/readiness files when runtime token is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-cloud-runtime-missing-token-'));
    const runtimeDir = join(dir, 'runtime');
    const manifestPath = join(runtimeDir, 'manifest.json');
    const statusPath = join(runtimeDir, 'status.json');
    const readinessPath = join(runtimeDir, 'readiness.json');
    try {
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(manifestPath, JSON.stringify({
        cloud_session_id: 'cld_test123',
        coding_session_id: 'sess_cloud123',
        coding_bin_id: 'cbin_test123',
        coding_bin: { root: join(dir, 'repo') },
        runtime: { paths: { dir: runtimeDir, status: statusPath, readiness: readinessPath, events: join(runtimeDir, 'events.jsonl') } },
      }), 'utf8');

      const result = await runCloudRuntimeSupervisor({
        cloudSessionId: 'cld_test123',
        manifest: manifestPath,
        json: true,
        once: true,
      }, {
        env: {},
        readConfig: false,
        getSecret: async () => null,
        fetch: async () => { throw new Error('should not report without token'); },
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });

      assert.equal(result.ok, false);
      assert.equal(result.error_code, 'runtime_token_missing');
      const status = JSON.parse(await readFile(statusPath, 'utf8'));
      const readiness = JSON.parse(await readFile(readinessPath, 'utf8'));
      assert.equal(status.phase, 'failed');
      assert.equal(status.error_code, 'runtime_token_missing');
      assert.equal(readiness.ready, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('coding bin snapshot capture', () => {
  test('collects filtered files, creates an archive, and uploads with metadata headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-cloud-runtime-snapshot-'));
    const repoRoot = join(dir, 'repo');
    const tempDir = join(dir, 'tmp');
    const uploaded = [];
    let listedFiles = [];
    try {
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(join(repoRoot, '.codex'), { recursive: true });
      await mkdir(join(repoRoot, 'node_modules/pkg'), { recursive: true });
      await mkdir(tempDir, { recursive: true });
      await writeFile(join(repoRoot, 'README.md'), 'ok', 'utf8');
      await writeFile(join(repoRoot, 'src/app.js'), 'console.log("ok")', 'utf8');
      await writeFile(join(repoRoot, 'src/token.txt'), 'secret', 'utf8');
      await writeFile(join(repoRoot, '.env'), 'SECRET=1', 'utf8');
      await writeFile(join(repoRoot, '.codex/auth.json'), '{}', 'utf8');
      await writeFile(join(repoRoot, 'node_modules/pkg/index.js'), 'ignored', 'utf8');

      const result = await captureCodingBinSnapshot({
        enabled: true,
        max_bytes: 1024,
        max_files: 10,
        upload: {
          method: 'PUT',
          url_template: 'https://memoro.test/api/mc/cloud-sessions/cld/coding-bin-snapshots/{snapshot_id}/payload',
          content_type: 'application/zstd',
        },
        exclude: {
          paths: ['.env', '.codex', 'node_modules'],
          globs: ['**/*token*'],
        },
      }, {
        root: repoRoot,
        token: 'mem_runtime_secret_123456789',
        tempDir,
        now: () => '2026-07-14T12:00:00.000Z',
        makeSnapshotId: () => 'cbsnap_capture123',
        createArchive: async ({ archivePath, listPath }) => {
          listedFiles = String(await readFile(listPath, 'utf8')).split('\0').filter(Boolean);
          await writeFile(archivePath, 'archive-bytes', 'utf8');
          return {
            ok: true,
            spawn: (_cmd, args) => {
              if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { status: 0, stdout: 'main\n', stderr: '' };
              if (args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: 'abc123\n', stderr: '' };
              return { status: 1, stdout: '', stderr: 'unexpected' };
            },
          };
        },
        fetchImpl: async (url, options) => {
          uploaded.push({ url, options });
          return { ok: true, status: 201, text: async () => '{"ok":true}' };
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.uploaded, true);
      assert.equal(result.snapshot_id, 'cbsnap_capture123');
      assert.deepEqual(listedFiles, ['README.md', 'src/app.js']);
      assert.equal(result.file_count, 2);
      assert.equal(result.skipped_count, 4);
      assert.equal(result.byte_count, Buffer.byteLength('archive-bytes'));
      assert.equal(result.base_ref, 'main');
      assert.equal(result.head_ref, 'abc123');
      assert.equal(uploaded.length, 1);
      assert.equal(uploaded[0].url, 'https://memoro.test/api/mc/cloud-sessions/cld/coding-bin-snapshots/cbsnap_capture123/payload');
      assert.equal(uploaded[0].options.method, 'PUT');
      assert.equal(uploaded[0].options.headers.Authorization, 'Bearer mem_runtime_secret_123456789');
      assert.equal(uploaded[0].options.headers['Content-Length'], String(Buffer.byteLength('archive-bytes')));
      assert.equal(uploaded[0].options.headers['X-MC-Snapshot-File-Count'], '2');
      assert.equal(uploaded[0].options.headers['X-MC-Snapshot-Skipped-Count'], '4');
      assert.equal(uploaded[0].options.headers['X-MC-Snapshot-Base-Ref'], 'main');
      assert.equal(uploaded[0].options.headers['X-MC-Snapshot-Head-Ref'], 'abc123');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
