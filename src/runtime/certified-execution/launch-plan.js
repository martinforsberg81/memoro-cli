import { createHash, randomUUID } from 'node:crypto';

import {
  certifiedToolRegistry,
} from '../../adapters/certified/registry.js';
import { resolveLaunch } from '../../adapters/index.js';
import {
  unavailableGitHubSessionCapabilities,
  prepareGitHubSessionForLaunch,
} from '../../capabilities/github/github-session.js';
import { decodeSessionCapabilities } from '../../capabilities/github/github-contract.js';
import { ensurePrivateDirectoryChainSync } from '../../mc/private-state.js';
import { sessionHomePaths } from '../../mc/session-home-paths.js';
import { SESSION_NAME_RE, assertMcSessionId } from '../../mc/session-home-schema.js';
import {
  inspectSessionRuntimeSync,
} from '../../mc/session-runtime-journal.js';
import { assertGenerationId } from '../../mc/session-record-ids.js';
import {
  managedProviderArtifactContextForLaunch,
  observeManagedProviderArtifact,
  validateManagedProviderArtifact,
} from '../../mc/managed-provider-registry.js';
import { SessionRuntimeHost } from '../session-host/runtime-host.js';
import {
  publishCertifiedGitHubProjection,
} from './github-projection.js';
import { CertifiedGitHubSocketHost } from './github-socket-host.js';

const MAX_HANDOFF_BYTES = 128 * 1024;

export async function prepareCertifiedLaunchPlan({
  mcHomeDir,
  mcSessionId,
  sessionName = null,
  generationId,
  portal,
  githubConnectionClient = null,
  baseEnv = process.env,
  githubCapabilities = unavailableGitHubSessionCapabilities(),
  launchOptions = {},
  registry = certifiedToolRegistry,
  handoffMessage = null,
  uuid = randomUUID,
  deps = {},
} = {}) {
  try {
    assertMcSessionId(mcSessionId);
    assertGenerationId(generationId);
  } catch {
    return failure('certified-generation-identity-invalid');
  }
  if (sessionName !== null && !SESSION_NAME_RE.test(sessionName || '')) {
    return failure('certified-session-name-invalid');
  }
  let snapshot;
  try {
    snapshot = (deps.inspectRuntime || inspectSessionRuntimeSync)({
      mcHomeDir,
      mcSessionId,
    });
  } catch {
    return failure('certified-runtime-state-unavailable');
  }
  if (snapshot?.kind !== 'present') {
    return failure(snapshot?.reason || 'certified-runtime-state-unavailable');
  }
  const generation = snapshot.active_generation;
  if (!generation
    || generation.intent.generation_id !== generationId
    || generation.phase !== 'planned') {
    return failure('certified-generation-not-planned');
  }
  let adapter;
  try { adapter = registry.forTool(generation.intent.tool); } catch {
    return failure('certified-tool-unsupported');
  }
  if (!adapter) return failure('certified-tool-unsupported');

  const conversation = resolveConversation(snapshot, generation.intent);
  if (!conversation.ok) return conversation;
  const handoff = validateHandoff(generation.intent, handoffMessage);
  if (!handoff.ok) return handoff;
  let toolLaunch;
  let argv;
  try {
    toolLaunch = (deps.resolveToolLaunch || resolveLaunch)(adapter.provider_tool);
    argv = adapter.resolve_argv({
      launch: toolLaunch,
      action: generation.intent.action,
      conversationHandle: conversation.handle,
      uuid,
    });
  } catch {
    return failure('certified-launch-argv-unavailable');
  }
  if (!argv?.ok) return failure(argv?.reason || 'certified-launch-argv-unavailable');

  let readiness;
  try {
    readiness = await adapter.inspect_readiness({
      portal,
      root: mcHomeDir,
      deps: deps.readiness || {},
    });
  } catch {
    readiness = null;
  }
  if (!readiness?.ok) return failure(readiness?.reason || 'certified-readiness-unavailable');

  let capabilities;
  try { capabilities = decodeSessionCapabilities(githubCapabilities); } catch {
    return failure('certified-github-capabilities-invalid');
  }
  const githubReady = capabilities.github.state === 'ready';
  if (githubReady && !githubConnectionClient?.withGrant) {
    return failure('certified-github-transport-unavailable');
  }
  let githubContext = null;
  if (githubReady) {
    try {
      githubContext = await (deps.publishGitHubProjection
        || publishCertifiedGitHubProjection)({
        mcHomeDir,
        mcSessionId,
        generation,
        capabilities,
        portal,
        memoroFetchImpl: deps.memoroFetch,
        deps: deps.githubProjection || {},
      });
    } catch {
      githubContext = null;
    }
    if (!githubContext?.ok) {
      return failure(githubContext?.reason || 'certified-github-projection-unavailable');
    }
  }

  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  let boundary = null;
  try {
    boundary = await adapter.prepare_boundary({
      codingSessionId: mcSessionId,
      domainGeneration: uuid(),
      providerSessionId: argv.expected_handle,
      cwd: generation.intent.launch_cwd,
      githubCapability: githubReady,
      githubSocketPath: githubReady ? paths.githubCapabilitySocketPath : null,
      portal,
      env: baseEnv,
      root: paths.mcHomeDir,
      deps: deps.boundary || {},
    });
    if (!boundary?.ok) {
      return failure(boundary?.reason || 'certified-boundary-unavailable');
    }
    ensurePrivateDirectoryChainSync({
      trustedRoot: paths.mcHomeDir,
      directory: paths.runtimeToolsBinPath,
    });
    const github = await (deps.prepareGitHub || prepareGitHubSessionForLaunch)({
      baseEnv: boundary.env,
      capabilities,
      sessionId: mcSessionId,
      socketPath: githubReady ? paths.githubCapabilitySocketPath : null,
      installSessionGitHubShim: false,
      shimDirectory: paths.runtimeToolsBinPath,
      mcHomeDir: paths.mcHomeDir,
      deps: deps.github || {},
    });
    const processPlan = adapter.resolve_process({
      boundary,
      argv: argv.argv,
      env: github.env,
      launch: toolLaunch,
      launchOptions: {
        ...launchOptions,
        ...(handoff.message === null ? {} : { handoffUserMessage: handoff.message }),
      },
      deps: deps.process || {},
    });
    if (!processPlan?.ok) {
      await safeAbort(adapter, boundary, deps);
      return failure(processPlan?.reason || 'certified-process-plan-unavailable');
    }
    const artifactContext = (deps.captureArtifactContext
      || managedProviderArtifactContextForLaunch)({
      tool: adapter.provider_tool,
      provider: { descriptor: boundary.descriptor },
      input: {
        argv: [...argv.argv],
        credential_domain: boundary.descriptor,
      },
    });
    return {
      ok: true,
      plan: new CertifiedLaunchPlan({
        mcHomeDir: paths.mcHomeDir,
        mcSessionId,
        generationId,
        action: generation.intent.action,
        tool: adapter.tool,
        providerTool: adapter.provider_tool,
        expectedHandle: argv.expected_handle,
        artifactContext,
        launchCwd: generation.intent.launch_cwd,
        processPlan: {
          ...processPlan,
          cwd: generation.intent.launch_cwd,
          env: {
            ...processPlan.env,
            MC_SESSION_ID: mcSessionId,
            ...(sessionName === null ? {} : { MC_SESSION_NAME: sessionName }),
          },
        },
        boundary,
        adapter,
        githubCapabilities: capabilities,
        githubConnectionClient,
        githubSocketPath: githubReady ? paths.githubCapabilitySocketPath : null,
        githubSourceId: githubContext?.source_id || null,
        githubWorkspaceId: githubContext?.workspace_id || null,
        handoffMessage: handoff.message,
        deps,
      }),
    };
  } catch {
    if (boundary?.ok) await safeAbort(adapter, boundary, deps);
    return failure('certified-launch-preparation-failed');
  }
}

export class CertifiedLaunchPlan {
  #action;
  #adapter;
  #boundary;
  #deps;
  #expectedHandle;
  #artifactContext;
  #generationId;
  #githubCapabilities;
  #githubConnectionClient;
  #githubSocketPath;
  #githubSourceId;
  #githubWorkspaceId;
  #handoffMessage;
  #mcHome;
  #mcSessionId;
  #processPlan;
  #providerTool;
  #state = 'prepared';
  #tool;

  constructor({
    mcHomeDir,
    mcSessionId,
    generationId,
    action,
    tool,
    providerTool,
    expectedHandle,
    artifactContext,
    launchCwd,
    processPlan,
    boundary,
    adapter,
    githubCapabilities,
    githubConnectionClient,
    githubSocketPath,
    githubSourceId,
    githubWorkspaceId,
    handoffMessage,
    deps,
  }) {
    this.#mcHome = mcHomeDir;
    this.#mcSessionId = mcSessionId;
    this.#generationId = generationId;
    this.#action = action;
    this.#tool = tool;
    this.#providerTool = providerTool;
    this.#expectedHandle = expectedHandle;
    this.#artifactContext = artifactContext;
    this.launchCwd = launchCwd;
    this.#processPlan = processPlan;
    this.#boundary = boundary;
    this.#adapter = adapter;
    this.#githubCapabilities = githubCapabilities;
    this.#githubConnectionClient = githubConnectionClient;
    this.#githubSocketPath = githubSocketPath;
    this.#githubSourceId = githubSourceId;
    this.#githubWorkspaceId = githubWorkspaceId;
    this.#handoffMessage = handoffMessage;
    this.#deps = deps;
    Object.seal(this);
  }

  summary() {
    return Object.freeze({
      mc_session_id: this.#mcSessionId,
      generation_id: this.#generationId,
      action: this.#action,
      tool: this.#tool,
      expected_conversation_handle: this.#expectedHandle,
      github_transport: this.#processPlan.env.MC_GITHUB_BROKER_SOCKET
        ? 'typed-session-socket'
        : 'unavailable',
      state: this.#state,
    });
  }

  async startRuntime({ ptyFactory, ...options } = {}) {
    if (this.#state !== 'prepared') throw certifiedExecutionError('certified-plan-consumed');
    let githubHost = null;
    try {
      if (this.#githubSocketPath) {
        const createGitHubHost = this.#deps.createGitHubSocketHost
          || ((input) => new CertifiedGitHubSocketHost(input));
        githubHost = createGitHubHost({
          ...this.#deps.githubSocket,
          mcHomeDir: this.#mcHome,
          mcSessionId: this.#mcSessionId,
          sourceId: this.#githubSourceId,
          workspaceId: this.#githubWorkspaceId,
          socketPath: this.#githubSocketPath,
          capabilities: this.#githubCapabilities,
          connectionClient: this.#githubConnectionClient,
        });
      }
      const host = new SessionRuntimeHost({
        ...options,
        mcHomeDir: this.#mcHome,
        mcSessionId: this.#mcSessionId,
        generationId: this.#generationId,
        spawnPlan: {
          command: this.#processPlan.command,
          args: [...this.#processPlan.args],
          cwd: this.#processPlan.cwd,
          env: { ...this.#processPlan.env },
        },
        ptyFactory,
      });
      if (githubHost) await githubHost.start();
      host.start();
      this.#state = 'claimed';
      return new CertifiedRuntimeHandle({ host, githubHost });
    } catch (error) {
      try { await githubHost?.close(); } catch {}
      await safeAbort(this.#adapter, this.#boundary, this.#deps);
      this.#state = 'failed';
      throw error;
    }
  }

  takeHandoffMessage() {
    if (this.#action !== 'switch' || this.#handoffMessage === null) return null;
    const message = this.#handoffMessage;
    this.#handoffMessage = null;
    return message;
  }

  captureConversationArtifact({ now = () => new Date().toISOString() } = {}) {
    if (!['claimed', 'closed'].includes(this.#state)) {
      return failure('certified-runtime-not-claimed');
    }
    if (!this.#artifactContext) return failure('certified-conversation-observation-unavailable');
    const observed = (this.#deps.observeProviderArtifact
      || observeManagedProviderArtifact)({
      tool: this.#providerTool,
      context: this.#artifactContext,
      cwd: this.launchCwd,
      adapterDeps: this.#deps.artifactObserver,
    });
    if (!observed?.ok || !observed.evidence) {
      return failure(observed?.reason || 'certified-conversation-not-observed');
    }
    const checked = (this.#deps.validateProviderArtifact
      || validateManagedProviderArtifact)({
      tool: this.#providerTool,
      evidence: observed.evidence,
      context: this.#artifactContext,
      adapterDeps: this.#deps.artifactValidator,
    });
    if (!checked?.ok) return failure(checked?.reason || 'certified-conversation-invalid');
    const handle = observed.evidence.providerSessionId;
    if (this.#expectedHandle && handle !== this.#expectedHandle) {
      return failure('certified-conversation-handle-conflict');
    }
    return {
      ok: true,
      handle,
      artifact: {
        schema: 'mc-provider-artifact-v1',
        coding_session_id: this.#mcSessionId,
        runtime_generation: this.#boundary.descriptor.generation,
        tool: this.#providerTool,
        provider_session_id: handle,
        transcript_path: checked.transcriptPath,
        captured_at: now(),
      },
    };
  }

  async abort() {
    if (this.#state !== 'prepared') return failure('certified-plan-already-claimed');
    const result = await this.#adapter.abort_boundary({
      descriptor: this.#boundary.descriptor,
      deps: this.#deps.boundaryLifecycle || {},
    });
    if (result?.ok) this.#state = 'aborted';
    return result;
  }

  async abortClaimedRuntime() {
    if (this.#state !== 'claimed') return failure('certified-runtime-not-claimed');
    let snapshot;
    try {
      snapshot = (this.#deps.inspectRuntime || inspectSessionRuntimeSync)({
        mcHomeDir: this.#mcHome,
        mcSessionId: this.#mcSessionId,
      });
    } catch {
      return failure('certified-runtime-state-unavailable');
    }
    const generation = snapshot?.kind === 'present'
      ? snapshot.generations.find((item) => item.intent.generation_id === this.#generationId)
      : null;
    if (!generation || !['exited', 'failed'].includes(generation.phase)) {
      return failure('certified-runtime-not-terminal');
    }
    const result = await this.#adapter.abort_boundary({
      descriptor: this.#boundary.descriptor,
      deps: this.#deps.boundaryLifecycle || {},
    });
    if (result?.ok) this.#state = 'aborted';
    return result;
  }

  async closeBoundary(options = {}) {
    if (this.#state !== 'claimed') return failure('certified-runtime-not-claimed');
    const result = await this.#adapter.close_boundary({
      ...options,
      descriptor: this.#boundary.descriptor,
      deps: this.#deps.boundaryLifecycle || {},
    });
    if (result?.ok) this.#state = 'closed';
    return result;
  }

  toJSON() { return this.summary(); }
}

export class CertifiedRuntimeHandle {
  #githubHost;
  #host;

  constructor({ host, githubHost = null }) {
    this.#host = host;
    this.#githubHost = githubHost;
    host.once('exit', () => { void this.#githubHost?.close(); });
    Object.seal(this);
  }

  get mcSessionId() { return this.#host.mcSessionId; }
  get generationId() { return this.#host.generationId; }

  status() { return this.#host.status(); }
  attach(...args) { return this.#host.attach(...args); }
  handleClientFrame(...args) { return this.#host.handleClientFrame(...args); }
  resize(...args) { return this.#host.resize(...args); }
  write(...args) { return this.#host.write(...args); }
  stop(...args) { return this.#host.stop(...args); }
  on(...args) { this.#host.on(...args); return this; }
  once(...args) { this.#host.once(...args); return this; }

  async close() {
    this.#host.close();
    await this.#githubHost?.close();
  }
}

export function certifiedExecutionError(reason) {
  const error = new Error(`mc certified execution error (${reason})`);
  error.code = 'MC_CERTIFIED_EXECUTION_ERROR';
  error.reason = reason;
  return error;
}

function resolveConversation(snapshot, intent) {
  if (intent.action !== 'resume') return { ok: true, handle: null };
  const conversation = snapshot.conversations.find(
    (item) => item.conversation_id === intent.resume_conversation_id,
  );
  if (!conversation || conversation.tool !== intent.tool || !conversation.handle) {
    return failure('certified-resume-conversation-unavailable');
  }
  return { ok: true, handle: conversation.handle };
}

function validateHandoff(intent, message) {
  if (intent.action !== 'switch') {
    return message == null
      ? { ok: true, message: null }
      : failure('certified-handoff-unexpected');
  }
  if (typeof message !== 'string'
    || message.length < 1
    || Buffer.byteLength(message, 'utf8') > MAX_HANDOFF_BYTES) {
    return failure('certified-handoff-missing');
  }
  const digest = createHash('sha256').update(message, 'utf8').digest('hex');
  return digest === intent.handoff_sha256
    ? { ok: true, message }
    : failure('certified-handoff-conflict');
}

async function safeAbort(adapter, boundary, deps) {
  try {
    return await adapter.abort_boundary({
      descriptor: boundary.descriptor,
      deps: deps.boundaryLifecycle || {},
    });
  } catch {
    return failure('certified-abort-failed');
  }
}

function failure(reason) {
  return { ok: false, reason };
}
