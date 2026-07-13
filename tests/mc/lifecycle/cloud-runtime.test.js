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
});
