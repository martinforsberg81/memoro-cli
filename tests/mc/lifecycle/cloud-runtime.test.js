import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  CLOUD_RUNTIME_CONTRACT_VERSION,
  parseArgs,
  prepareWorkspace,
  runCloudRuntimeWith,
  validateCloudRuntimeOptions,
} from '../../../src/mc/commands/cloud-runtime.js';
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
    cloud_session_id: 'cld_runtime1',
    coding_session_id: 'sess_runtime1',
    source: {
      id: 'cloud:cld_runtime1',
      kind: 'cloud',
      name: 'Memoro Cloud',
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
});

describe('mc cloud-runtime workspace', () => {
  test('clones GitHub shorthand refs without putting the token in argv', async () => {
    const calls = [];
    const m = manifest();
    const result = await prepareWorkspace(m, {
      env: {
        MC_CLOUD_GIT_TOKEN: 'ghp_private_secret',
        MC_CLOUD_GIT_CREDENTIAL_SOURCE: 'runtime_env',
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
    assert.deepEqual(calls[0].args.slice(-2), ['https://github.com/martinforsberg81/memoro.git', m.runtime.cwd]);
    assert.equal(JSON.stringify(calls[0].args).includes('ghp_private_secret'), false);
    assert.equal(calls[0].options.env.MC_CLOUD_GIT_TOKEN, 'ghp_private_secret');
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
  });
});

describe('mc cloud-runtime run', () => {
  test('prepares workspace, launches typed cloud-session, reports status, then connects broker', async () => {
    const streams = io();
    const m = manifest();
    writeFileSync(m.runtime.paths.manifest, JSON.stringify(m), 'utf8');
    const reports = [];
    const launchCalls = [];
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
      env: {
        MEMORO_TOKEN: 'mem_runtime_secret',
        MC_CLOUD_GIT_TOKEN: 'ghp_private_secret',
        MC_CODEX_API_KEY: 'sk_codex_private_secret',
        OPENAI_API_KEY: 'sk_product_secret',
      },
      now: () => '2026-07-13T12:00:00.000Z',
      reportRuntimeStatus: async (report) => { reports.push(report); return { ok: true }; },
      runProcess: async (cmd, args, options) => {
        gitCalls.push({ cmd, args, options });
        return { code: 0, stdout: '', stderr: '' };
      },
      runCloudSessionWith: async (opts, deps) => {
        launchCalls.push({ opts, deps });
        deps.stdout.write(JSON.stringify({
          ok: true,
          cloud_session_id: m.cloud_session_id,
          coding_session_id: 'sess_runtime1',
          source_id: 'cloud:cld_runtime1',
        }));
        return 0;
      },
      connectBroker: async (args) => {
        brokerCalls.push(args);
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
    assert.equal(launchCalls[0].deps.env.MEMORO_TOKEN, 'mem_runtime_secret');
    assert.equal(launchCalls[0].deps.env.CODEX_HOME, '/tmp/mc-cloud-codex-home');
    assert.equal(launchCalls[0].deps.env.MC_CLOUD_GIT_TOKEN, undefined);
    assert.equal(launchCalls[0].deps.env.MC_CODEX_API_KEY, undefined);
    assert.equal(launchCalls[0].deps.env.OPENAI_API_KEY, undefined);
    assert.equal(brokerCalls.length, 1);
    assert.equal(persistWatchers.length, 1);
    assert.equal(persistWatchers[0].env.CODEX_HOME, '/tmp/mc-cloud-codex-home');
    assert.equal(brokerCalls[0].manifest.cloud_session_id, m.cloud_session_id);
    assert.ok(reports.length >= 4);
    assert.equal(reports.at(-1).cloudSessionId, m.cloud_session_id);

    const status = JSON.parse(readFileSync(m.runtime.paths.status, 'utf8'));
    const events = readFileSync(m.runtime.paths.events, 'utf8');
    const readiness = JSON.parse(readFileSync(m.runtime.paths.readiness, 'utf8'));
    const eventTypes = events.trim().split('\n').map((line) => JSON.parse(line).type);
    const rendered = JSON.stringify({ status, events, readiness });
    assert.equal(rendered.includes('mem_runtime_secret'), false);
    assert.equal(rendered.includes('ghp_private_secret'), false);
    assert.equal(rendered.includes('sk_product_secret'), false);
    assert.equal(readiness.repo.cloned, true);
    assert.equal(readiness.git.ready, true);
    assert.equal(readiness.git_auth.ready, true);
    assert.equal(readiness.vault.exposes_secrets_to_llm, false);
    assert.equal(readiness.tool_auth.ready, true);
    assert.ok(eventTypes.includes('workspace.prepare.started'));
    assert.ok(eventTypes.includes('workspace.prepare.finished'));
    assert.ok(eventTypes.includes('provider.launch.started'));
    assert.ok(eventTypes.includes('provider.launch.finished'));
    assert.ok(eventTypes.includes('broker.connecting'));
  });

  test('fails before launch when the runtime token is missing', async () => {
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
      env: {},
      getSecret: async () => null,
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      reportRuntimeStatus: async (report) => { reports.push(report); return { ok: true }; },
      runProcess: async () => assert.fail('must not prepare workspace without a runtime token'),
      runCloudSessionWith: async () => assert.fail('must not launch without a runtime token'),
      connectBroker: async () => assert.fail('must not connect broker without a runtime token'),
    });

    assert.equal(code, 1);
    assert.match(streams.err(), /runtime token missing/);
    assert.equal(reports.length, 0);
    const status = JSON.parse(readFileSync(m.runtime.paths.status, 'utf8'));
    assert.equal(status.phase, 'failed');
    assert.equal(JSON.stringify(status).includes('runtime token missing'), true);
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
      env: {
        MEMORO_TOKEN: 'mem_runtime_secret',
        MC_CLOUD_GIT_TOKEN: 'ghp_private_secret',
      },
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
