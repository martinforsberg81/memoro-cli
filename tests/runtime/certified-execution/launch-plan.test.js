import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  acceptRuntimeGenerationSync,
  beginRuntimeGenerationSync,
  bindRuntimeConversationSync,
  completeRuntimeGenerationSync,
  inspectSessionRuntimeSync,
  markRuntimeGenerationLiveSync,
  recordRuntimeGenerationExitSync,
} from '../../../src/mc/session-runtime-journal.js';
import { createSessionHomeSync } from '../../../src/mc/session-home.js';
import { createWorkspaceAssociationSync } from '../../../src/mc/workspace-record.js';
import {
  prepareCertifiedLaunchPlan,
} from '../../../src/runtime/certified-execution/launch-plan.js';

const mcSessionId = 'mcs_000000000000000000000001';
const generationId = 'mcg_000000000000000000000001';
const previousGenerationId = 'mcg_000000000000000000000000';
const conversationId = 'mcc_000000000000000000000001';
const workspaceId = 'mcw_000000000000000000000001';
let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('prepares an opaque certified plan and launches through the session runtime host', async () => {
  const mcHomeDir = home();
  planned(mcHomeDir, { action: 'start', tool: 'codex' });
  const fixture = adapterFixture();
  const prepared = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    sessionName: 'runtime-test',
    generationId,
    registry: fixture.registry,
    portal: { apiUrl: 'https://example.invalid', token: 'portal-secret' },
    baseEnv: { GH_TOKEN: 'github-secret', SAFE: 'yes' },
    deps: dependencies(),
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.plan.summary(), {
    mc_session_id: mcSessionId,
    generation_id: generationId,
    action: 'start',
    tool: 'codex',
    expected_conversation_handle: null,
    github_transport: 'unavailable',
    state: 'prepared',
  });
  const serialized = JSON.stringify(prepared.plan);
  for (const forbidden of ['portal-secret', 'github-secret', '/certified-tool', 'args', 'env']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(fixture.calls.map((call) => call.name), [
    'argv', 'readiness', 'boundary', 'process',
  ]);

  const pty = new FakePty();
  const host = await prepared.plan.startRuntime({
    ptyFactory: {
      spawn(command, args, options) {
        assert.equal(command, '/certified-tool');
        assert.deepEqual(args, ['certified']);
        assert.equal(options.cwd, '/workspace/one');
        assert.deepEqual(options.env, {
          CERTIFIED: '1',
          MC_SESSION_ID: mcSessionId,
          MC_SESSION_NAME: 'runtime-test',
        });
        return pty;
      },
    },
    hostPid: 51001,
    now: clock(),
  });
  assert.equal(host.status().state, 'live');
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation.phase,
    'live');
  await host.close();
});

test('captures one exact bounded conversation artifact after runtime claim', async () => {
  const mcHomeDir = home();
  planned(mcHomeDir, { action: 'start', tool: 'codex' });
  const fixture = adapterFixture();
  const prepared = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: fixture.registry,
    deps: {
      ...dependencies(),
      captureArtifactContext: () => ({ exact: true }),
      observeProviderArtifact: ({ context, cwd }) => ({
        ok: context.exact && cwd === '/workspace/one',
        evidence: {
          providerSessionId: 'conversation-exact',
          transcriptPath: '/bounded/conversation.jsonl',
        },
      }),
      validateProviderArtifact: ({ evidence }) => ({
        ok: evidence.providerSessionId === 'conversation-exact',
        transcriptPath: evidence.transcriptPath,
      }),
    },
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.plan.captureConversationArtifact().reason, 'certified-runtime-not-claimed');
  const runtime = await prepared.plan.startRuntime({
    ptyFactory: { spawn: () => new FakePty() },
    hostPid: 51005,
    now: clock(),
  });
  const captured = prepared.plan.captureConversationArtifact({
    now: () => '2026-08-03T02:00:20.000Z',
  });
  assert.equal(captured.ok, true);
  assert.equal(captured.handle, 'conversation-exact');
  assert.deepEqual(captured.artifact, {
    schema: 'mc-provider-artifact-v1',
    coding_session_id: mcSessionId,
    runtime_generation: fixture.calls.find((call) => call.name === 'boundary').options
      .domainGeneration,
    tool: 'codex',
    provider_session_id: 'conversation-exact',
    transcript_path: '/bounded/conversation.jsonl',
    captured_at: '2026-08-03T02:00:20.000Z',
  });
  assert.equal((await prepared.plan.closeBoundary({ providerArtifact: captured.artifact })).ok, true);
  await runtime.close();
});

test('a stopped claimed runtime can abort its exact credential boundary', async () => {
  const mcHomeDir = home();
  planned(mcHomeDir, { action: 'start', tool: 'codex' });
  const fixture = adapterFixture();
  const prepared = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: fixture.registry,
    deps: dependencies(),
  });
  const pty = new FakePty();
  const runtime = await prepared.plan.startRuntime({
    ptyFactory: { spawn: () => pty },
    hostPid: 51006,
    now: clock(),
  });

  assert.equal((await prepared.plan.abortClaimedRuntime()).reason,
    'certified-runtime-not-terminal');
  const exited = new Promise((resolve) => runtime.once('exit', resolve));
  pty.emitExit({ exitCode: 1, signal: null });
  await exited;
  assert.equal((await prepared.plan.abortClaimedRuntime()).ok, true);
  assert.equal(fixture.calls.at(-1).name, 'abort');
  assert.equal(prepared.plan.summary().state, 'aborted');
  assert.equal((await prepared.plan.abortClaimedRuntime()).reason,
    'certified-runtime-not-claimed');
  await runtime.close();
});

test('resume uses the one durable handle and never creates a replacement', async () => {
  const mcHomeDir = home();
  completedConversation(mcHomeDir);
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    action: 'resume',
    tool: 'codex',
    launchCwd: '/workspace/two',
    resumeConversationId: conversationId,
    now: () => '2026-08-03T02:00:07.000Z',
  });
  const fixture = adapterFixture();
  const prepared = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: fixture.registry,
    deps: dependencies(),
  });
  assert.equal(prepared.ok, true);
  const argvCall = fixture.calls.find((call) => call.name === 'argv');
  assert.equal(argvCall.action, 'resume');
  assert.equal(argvCall.conversationHandle, 'provider-handle-1');
  assert.equal(prepared.plan.summary().expected_conversation_handle, 'provider-handle-1');
  assert.equal(fixture.calls.filter((call) => call.name === 'argv').length, 1);
  await prepared.plan.abort();
});

test('missing readiness and GitHub transport fail before boundary preparation', async () => {
  const mcHomeDir = home();
  planned(mcHomeDir, { action: 'start', tool: 'codex' });
  const notReady = adapterFixture({ readiness: false });
  const refused = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: notReady.registry,
    deps: dependencies(),
  });
  assert.equal(refused.reason, 'readiness-missing');
  assert.equal(notReady.calls.some((call) => call.name === 'boundary'), false);

  const ready = adapterFixture();
  const githubRefused = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: ready.registry,
    githubCapabilities: readyGitHubCapabilities(),
    deps: dependencies(),
  });
  assert.equal(githubRefused.reason, 'certified-github-transport-unavailable');
  assert.equal(ready.calls.some((call) => call.name === 'boundary'), false);
});

test('corrupt runtime reads and throwing readiness fail closed with stable reasons', async () => {
  assert.deepEqual(await prepareCertifiedLaunchPlan({
    mcHomeDir: '/tmp/certified-corrupt',
    mcSessionId,
    generationId,
    deps: { inspectRuntime: () => { throw new Error('host detail'); } },
  }), { ok: false, reason: 'certified-runtime-state-unavailable' });

  const mcHomeDir = home();
  planned(mcHomeDir, { action: 'start', tool: 'codex' });
  const fixture = adapterFixture();
  fixture.registry.forTool('codex').inspect_readiness = async () => {
    throw new Error('readiness detail');
  };
  const result = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: fixture.registry,
    deps: dependencies(),
  });
  assert.deepEqual(result, { ok: false, reason: 'certified-readiness-unavailable' });
  assert.equal(fixture.calls.some((call) => call.name === 'boundary'), false);
});

test('starts the exact GitHub socket before the tool and closes it with the runtime', async () => {
  const mcHomeDir = home();
  workspace(mcHomeDir);
  planned(mcHomeDir, { action: 'start', tool: 'codex', workspaceId });
  const fixture = adapterFixture();
  const order = [];
  const githubConnectionClient = { withGrant() {} };
  const paths = (await import('../../../src/mc/session-home-paths.js')).sessionHomePaths({
    mcHomeDir,
    mcSessionId,
  });
  const prepared = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: fixture.registry,
    portal: { apiUrl: 'https://memoro.invalid', token: 'portal-secret' },
    githubCapabilities: readyGitHubCapabilities(),
    githubConnectionClient,
    deps: {
      ...dependencies(),
      prepareGitHub: async () => ({
        env: { MC_GITHUB_BROKER_SOCKET: paths.githubCapabilitySocketPath },
      }),
      publishGitHubProjection: async (options) => {
        assert.equal(options.generation.intent.workspace_id, workspaceId);
        return { ok: true, source_id: 'machine_test', workspace_id: workspaceId };
      },
      createGitHubSocketHost(options) {
        assert.equal(options.socketPath, paths.githubCapabilitySocketPath);
        assert.equal(options.connectionClient, githubConnectionClient);
        assert.equal(options.sourceId, 'machine_test');
        assert.equal(options.workspaceId, workspaceId);
        return {
          async start() { order.push('github'); },
          async close() { order.push('github-close'); },
        };
      },
    },
  });
  assert.equal(prepared.ok, true);
  const pty = new FakePty();
  const runtime = await prepared.plan.startRuntime({
    ptyFactory: {
      spawn() { order.push('tool'); return pty; },
    },
    hostPid: 51003,
    now: clock(),
  });
  assert.deepEqual(order, ['github', 'tool']);
  await runtime.close();
  assert.deepEqual(order, ['github', 'tool', 'github-close']);
});

test('switch requires the exact bounded handoff digest', async () => {
  const mcHomeDir = home();
  completedConversation(mcHomeDir);
  const handoff = 'Continue from the verified source conversation.';
  const digest = await sha256(handoff);
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    action: 'switch',
    tool: 'claude',
    launchCwd: '/workspace/two',
    previousConversationId: conversationId,
    handoffSha256: digest,
    now: () => '2026-08-03T02:00:07.000Z',
  });
  const fixture = adapterFixture({ tool: 'claude' });
  assert.equal((await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: fixture.registry,
    handoffMessage: 'different',
    deps: dependencies(),
  })).reason, 'certified-handoff-conflict');
  assert.equal(fixture.calls.length, 0);

  const prepared = await prepareCertifiedLaunchPlan({
    mcHomeDir,
    mcSessionId,
    generationId,
    registry: fixture.registry,
    handoffMessage: handoff,
    deps: dependencies(),
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.plan.takeHandoffMessage(), handoff);
  assert.equal(prepared.plan.takeHandoffMessage(), null);
  await prepared.plan.abort();
});

function adapterFixture({ tool = 'codex', readiness = true } = {}) {
  const calls = [];
  const adapter = {
    tool,
    provider_tool: tool === 'claude' ? 'claude-code' : tool,
    resolve_argv(options) {
      calls.push({ name: 'argv', ...options });
      return {
        ok: true,
        argv: options.action === 'resume' ? ['resume', options.conversationHandle] : [],
        expected_handle: options.conversationHandle,
      };
    },
    async inspect_readiness() {
      calls.push({ name: 'readiness' });
      return readiness ? { ok: true } : { ok: false, reason: 'readiness-missing' };
    },
    async prepare_boundary(options) {
      calls.push({ name: 'boundary', options });
      return {
        ok: true,
        descriptor: { session_id: mcSessionId, generation: options.domainGeneration },
        env: { BOUNDARY: '1' },
      };
    },
    resolve_process(options) {
      calls.push({ name: 'process', options });
      return {
        ok: true,
        command: '/certified-tool',
        args: ['certified'],
        env: { CERTIFIED: '1' },
      };
    },
    async abort_boundary() { calls.push({ name: 'abort' }); return { ok: true }; },
    async close_boundary() { calls.push({ name: 'close' }); return { ok: true }; },
  };
  return {
    calls,
    registry: { forTool: (value) => (value === tool ? adapter : null) },
  };
}

function dependencies() {
  return {
    resolveToolLaunch: (tool) => ({ ok: true, id: tool, adapter: {} }),
    prepareGitHub: async ({ baseEnv }) => ({ env: { ...baseEnv } }),
  };
}

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-certified-plan-'));
  roots.push(root);
  createSessionHomeSync({
    mcHomeDir: root,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'certified-test',
    now: () => '2026-08-03T02:00:00.000Z',
  });
  return root;
}

function planned(mcHomeDir, { action, tool, workspaceId: launchWorkspaceId = null }) {
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    action,
    tool,
    workspaceId: launchWorkspaceId,
    launchCwd: '/workspace/one',
    now: () => '2026-08-03T02:00:01.000Z',
  });
}

function workspace(mcHomeDir) {
  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    kind: 'worktree',
    currentPath: '/workspace/one',
    repository: {
      repository_identity: 'github:1',
      public_ref: 'owner/repo',
      git_common_dir: '/workspace/.git',
    },
    checkout: {
      git_dir: '/workspace/one/.git',
      branch: 'feature/certified',
      head_sha: 'a'.repeat(40),
    },
    now: () => '2026-08-03T02:00:00.500Z',
  });
}

function completedConversation(mcHomeDir) {
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: previousGenerationId,
    action: 'start',
    tool: 'codex',
    launchCwd: '/workspace/one',
    now: () => '2026-08-03T02:00:01.000Z',
  });
  acceptRuntimeGenerationSync({
    mcHomeDir, mcSessionId, generationId: previousGenerationId,
    now: () => '2026-08-03T02:00:02.000Z',
  });
  markRuntimeGenerationLiveSync({
    mcHomeDir, mcSessionId, generationId: previousGenerationId,
    now: () => '2026-08-03T02:00:03.000Z',
  });
  bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: previousGenerationId,
    conversationId,
    handle: 'provider-handle-1',
    now: () => '2026-08-03T02:00:04.000Z',
  });
  recordRuntimeGenerationExitSync({
    mcHomeDir,
    mcSessionId,
    generationId: previousGenerationId,
    exitCode: 0,
    now: () => '2026-08-03T02:00:05.000Z',
  });
  completeRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: previousGenerationId,
    conversationId,
    now: () => '2026-08-03T02:00:06.000Z',
  });
}

function readyGitHubCapabilities() {
  return {
    schema: 1,
    github: {
      state: 'ready',
      transport: 'mc-broker-v1',
      actor: 'installation',
      account: 'owner',
      repository: {
        id: 1,
        full_name: 'owner/repo',
        owner: 'owner',
        name: 'repo',
        private: true,
        archived: false,
        account: 'owner',
      },
      operations: ['pull_request.list'],
    },
  };
}

async function sha256(value) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}

function clock() {
  let time = Date.parse('2026-08-03T02:00:08.000Z');
  return () => {
    const value = new Date(time).toISOString();
    time += 1000;
    return value;
  };
}

class FakePty extends EventEmitter {
  constructor() {
    super();
    this.pid = 51002;
  }
  onData(handler) { this.on('data', handler); }
  onExit(handler) { this.on('exit', handler); }
  emitExit(event) { this.emit('exit', event); }
  write() {}
  resize() {}
  kill() {}
}
