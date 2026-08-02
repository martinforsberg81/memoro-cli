import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { canonicalToolId } from '../../adapters/index.js';
import { CliWsClient } from '../../commands/ws-client.js';
import { createFetchTranscriptHandler } from '../../commands/handlers/fetch-transcript.js';
import { memoroFetch } from '../../lib/api.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import {
  resolveSessionSourceIdentity,
  SessionProjectionTracker,
} from '../../mc/session-projector.js';
import { scheduleSessionUpload } from '../../mc/session-upload.js';
import {
  executeGitHubControlPlaneOperation,
  fetchGitHubSessionCapabilities,
} from '../../capabilities/github/github-session.js';
import { decodeSessionCapabilities } from '../../capabilities/github/github-contract.js';
import { createConnectionClient } from '../../capabilities/connections/client.js';
import { createRefreshingIdentityBroker } from '../../capabilities/connections/identity.js';
import {
  buildSessionHeartbeatPayload,
  postHeartbeatWithRetry,
  publishLocalSessionPresence,
} from '../../mc/session-presence.js';

const TICK_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const GITHUB_REBOOTSTRAP_MIN_INTERVAL_MS = 15_000;

export class BrokerSessionSidecars {
  constructor({
    session,
    coding,
    createServerImpl = (handler) => createServer({ allowHalfOpen: true }, handler),
    wsClientFactory = (opts) => new CliWsClient(opts),
    fetchTranscriptHandlerFactory = createFetchTranscriptHandler,
    memoroFetchImpl = memoroFetch,
    sleepImpl = sleep,
    now = () => Date.now(),
    heartbeatIntervalMs = TICK_INTERVAL_MS,
    retryIntervalMs = RETRY_INTERVAL_MS,
    maxAttempts = MAX_ATTEMPTS,
    sessionUploadScheduler = scheduleSessionUpload,
    projectionTracker = null,
    connectionClient = null,
    connectionClientFactory = createConnectionClient,
    localPresencePublisher = publishLocalSessionPresence,
    logger = silentLogger(),
  } = {}) {
    if (!session) throw new TypeError('session is required');
    if (!coding?.codingSessionId) throw new TypeError('coding.codingSessionId is required');
    this.session = session;
    this.coding = coding;
    this.createServerImpl = createServerImpl;
    this.wsClientFactory = wsClientFactory;
    this.fetchTranscriptHandlerFactory = fetchTranscriptHandlerFactory;
    this.memoroFetch = memoroFetchImpl;
    const managedGitHub = managedGitHubCapabilities(coding.githubCapabilities);
    this.githubCapabilities = managedGitHub;
    this.connectionClient = connectionClient || (
      coding.apiUrl && coding.token
        ? connectionClientFactory({
            // The sidecar outlives its launch-time token: a refreshing
            // broker re-mints with the current keychain token on auth
            // failure so a rotated device identity does not strand the
            // session's GitHub capabilities until restart.
            identityBroker: createRefreshingIdentityBroker({
              token: coding.token,
              apiUrl: coding.apiUrl,
              memoroFetch: memoroFetchImpl,
            }),
            memoroFetch: memoroFetchImpl,
          })
        : managedGitHub
          ? connectionClientFactory({ memoroFetch: memoroFetchImpl })
          : null
    );
    this.localPresencePublisher = localPresencePublisher;
    this.sleep = sleepImpl;
    this.now = now;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.retryIntervalMs = retryIntervalMs;
    this.maxAttempts = maxAttempts;
    this.sessionUploadScheduler = sessionUploadScheduler;
    this.sourceIdentity = resolveSessionSourceIdentity({
      sourceId: coding.sourceId || coding.source_id,
      sourceKind: coding.sourceKind || coding.source_kind,
      sourceName: coding.sourceName || coding.source_name,
      cloudSessionId: coding.cloudSessionId || coding.cloud_session_id,
      machineId: coding.machineId,
    });
    this.projectionTracker = projectionTracker || new SessionProjectionTracker({
      cwd: session.cwd,
      now,
    });
    this.logger = logger;

    this.dispatchServer = null;
    this.wsClient = null;
    this.alive = false;
    this.stopped = false;
    this.heartbeatPromise = null;
    this.finalizationPromise = null;
    this.uploadScheduled = false;
    this.githubBootstrapAttemptedAt = null;
    // Managed sessions run against an EXACT pinned capability descriptor:
    // an unadvertised operation must be refused before any identity or
    // network use. Only a sidecar holding its own Memoro identity may
    // refresh a denying allowlist.
    this.allowCapabilityRefreshOnDeny = Boolean(coding.apiUrl && coding.token);
  }

  /**
   * GitHub capabilities are bootstrapped at launch, but a session must not
   * stay GitHub-dead — or capability-stale — for its whole life. Two
   * refresh triggers, both rate-limited:
   *   - no ready capabilities are held (failed launch bootstrap, or a
   *     connection repaired after launch), and
   *   - the cached ready list would DENY the requested operation — the
   *     capability surface may have grown since launch (a server deploy
   *     adding an operation), so re-bootstrap before deciding.
   * A failed re-bootstrap keeps the cached list (or null), so the control
   * plane remains the enforcing authority for the actual state.
   */
  async _githubOperationAllowlist(request = null) {
    const cached = this.githubCapabilities?.github?.state === 'ready'
      ? this.githubCapabilities.github.operations || []
      : null;
    if (cached && (!request?.operation || cached.includes(request.operation))) {
      return cached;
    }
    if (cached && !this.allowCapabilityRefreshOnDeny) return cached;
    if (!this.connectionClient) return cached;
    const nowMs = this.now();
    if (this.githubBootstrapAttemptedAt != null
      && nowMs - this.githubBootstrapAttemptedAt < GITHUB_REBOOTSTRAP_MIN_INTERVAL_MS) {
      return cached;
    }
    this.githubBootstrapAttemptedAt = nowMs;
    try {
      const capabilities = await fetchGitHubSessionCapabilities({
        connectionClient: this.connectionClient,
        repository: this.coding.repoRef || this.coding.repo_ref || null,
        memoroFetchImpl: this.memoroFetch,
      });
      const descriptor = managedGitHubCapabilities(capabilities);
      if (descriptor) {
        this.githubCapabilities = descriptor;
        return descriptor.github.operations || null;
      }
    } catch {}
    return cached;
  }

  start() {
    this.alive = true;
    this.stopped = false;
    this._writeMetadata();
    this._startDispatchSocket();
    this._startWsClient();
    this._startHeartbeat();
    return this;
  }

  stop({ terminal = false } = {}) {
    if (this.stopped) return this.finalizationPromise || Promise.resolve(true);
    this.stopped = true;
    this.alive = false;
    try { this.wsClient?.stop?.(); } catch {}
    try { this.dispatchServer?.close?.(); } catch {}
    this._unlink(this.coding.sockPath);
    this._unlink(this.coding.metaPath);
    this.finalizationPromise = Promise.resolve(
      terminal ? this._publishTerminalPresence() : true,
    ).finally(() => this._scheduleUpload());
    return this.finalizationPromise;
  }

  _writeMetadata() {
    if (!this.coding.metaPath) return;
    mkdirSync(dirname(this.coding.metaPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.coding.metaPath, JSON.stringify({
      runtime_manifest_version: 1,
      cleanup_owner: 'mc',
      coding_session_id: this.coding.codingSessionId,
      label: this.coding.label || null,
      tool: this.coding.tool || null,
      source: this._codingSource(),
      ...this.sourceIdentity,
      runtime_generation: this.coding.runtimeGeneration || this.coding.runtime_generation || null,
      tool_session_id: this.coding.toolSessionId || this.coding.tool_session_id || null,
      tool_transcript_path: this.coding.transcriptPath || this.coding.tool_transcript_path || null,
      sock_path: this.coding.sockPath || null,
      repo: this.coding.repo || null,
      repo_ref: this.coding.repoRef || this.coding.repo_ref || null,
      branch: this.coding.branch || null,
      cwd: this.session.cwd,
      started_at: new Date(this.now()).toISOString(),
      pid: process.pid,
      broker_owned: true,
    }, null, 2), { mode: 0o600 });
  }

  _startDispatchSocket() {
    if (!this.coding.sockPath) return;
    if (existsSync(this.coding.sockPath)) {
      try { unlinkSync(this.coding.sockPath); } catch {}
    }
    mkdirSync(dirname(this.coding.sockPath), { recursive: true, mode: 0o700 });

    const server = this.createServerImpl((conn) => {
      let buf = '';
      conn.on('error', () => {});
      conn.on('data', (chunk) => { buf += chunk.toString('utf8'); });
      conn.on('end', async () => {
        let payload;
        try { payload = JSON.parse(buf); } catch {
          conn.end(JSON.stringify({ ok: false, error: 'invalid JSON' }) + '\n');
          return;
        }
        if (payload?.type === 'github_operation') {
          const response = await executeGitHubControlPlaneOperation({
            connectionClient: this.connectionClient,
            codingSessionId: this.coding.codingSessionId,
            request: payload,
            allowedOperations: (request) => this._githubOperationAllowlist(request),
            memoroFetchImpl: this.memoroFetch,
          });
          conn.end(JSON.stringify(response) + '\n');
          return;
        }
        const message = payload?.message;
        if (typeof message !== 'string' || !message.trim()) {
          conn.end(JSON.stringify({ ok: false, error: 'message required' }) + '\n');
          return;
        }
        this.session.writeDispatchedMessage(message);
        conn.end(JSON.stringify({ ok: true, message }) + '\n');
      });
    });
    this.dispatchServer = server;
    server.listen(this.coding.sockPath, () => {
      try { chmodSync(this.coding.sockPath, 0o600); } catch {}
    });
  }

  _startWsClient() {
    if (!this.coding.apiUrl || !this.coding.token) return;
    const transcriptAccess = this.coding.transcriptAccess !== false
      && this.coding.transcript_access !== false;
    this.wsClient = this.wsClientFactory({
      apiUrl: this.coding.apiUrl,
      token: this.coding.token,
      codingSessionId: this.coding.codingSessionId,
      handlers: {
        ...(transcriptAccess
          ? {
              fetch_transcript: this.fetchTranscriptHandlerFactory({
                transcriptPath: this.coding.transcriptPath || null,
                source: this._codingSource(),
              }),
            }
          : {}),
        dispatch_message: async (args) => {
          const message = typeof args?.message === 'string' ? args.message : null;
          if (!message?.trim()) throw new Error('message required');
          this.session.writeDispatchedMessage(message);
          return { ok: true, delivered_at: new Date(this.now()).toISOString() };
        },
      },
      logger: this.logger,
    });
    this.wsClient.start();
  }

  _startHeartbeat() {
    if (this.coding.heartbeat === false || !this._hasPresenceIdentity()) return;
    this.heartbeatPromise = this._runHeartbeat();
  }

  async _runHeartbeat() {
    while (this.alive) {
      const now = this.now();
      await this._publishPresence(buildSessionHeartbeatPayload({
          codingSessionId: this.coding.codingSessionId,
          runtimeGeneration: this.coding.runtimeGeneration || this.coding.runtime_generation || null,
          presenceState: 'active',
          machineId: this.coding.machineId || null,
          sourceIdentity: this.sourceIdentity,
          source: this._codingSource(),
          repo: this.coding.repoRef || this.coding.repo_ref || this.coding.repo || null,
          branch: this.coding.branch || null,
          idleSeconds: Math.max(0, Math.floor((now - (this.session.lastOutputAt || now)) / 1000)),
          at: new Date(now).toISOString(),
          sessionProjection: this.currentProjection({ now }),
          label: this.coding.label || null,
        }), {
        retryIntervalMs: this.retryIntervalMs,
        maxAttempts: this.maxAttempts,
        shouldContinue: () => this.alive,
      });
      if (!this.alive || this.heartbeatIntervalMs == null) break;
      try { await this.sleep(this.heartbeatIntervalMs); } catch {}
    }
  }

  _unlink(path) {
    if (!path) return;
    try { unlinkSync(path); } catch {}
  }

  currentProjection({ now = this.now() } = {}) {
    const status = typeof this.session.status === 'function'
      ? this.session.status()
      : {
          started_at: this.session.startedAt ? new Date(this.session.startedAt).toISOString() : null,
          last_output_at: this.session.lastOutputAt ? new Date(this.session.lastOutputAt).toISOString() : null,
          last_input_at: this.session.lastInputAt ? new Date(this.session.lastInputAt).toISOString() : null,
          exit: this.session.exit || null,
        };
    return this.projectionTracker.runtime({
      session: {
        ...status,
        session_state: status.exit ? 'dead' : 'live',
        attachable: !status.exit,
      },
      output: this.session.recentOutput(),
      now,
    });
  }

  async _publishTerminalPresence() {
    const runtimeGeneration = this.coding.runtimeGeneration || this.coding.runtime_generation || null;
    if (
      this.coding.heartbeat === false
      || !this._hasPresenceIdentity()
      || !runtimeGeneration
    ) {
      return false;
    }
    const now = this.now();
    return this._publishPresence(buildSessionHeartbeatPayload({
        codingSessionId: this.coding.codingSessionId,
        runtimeGeneration,
        presenceState: 'terminal',
        machineId: this.coding.machineId || null,
        sourceIdentity: this.sourceIdentity,
        source: this._codingSource(),
        repo: this.coding.repoRef || this.coding.repo_ref || this.coding.repo || null,
        branch: this.coding.branch || null,
        idleSeconds: 0,
        at: new Date(now).toISOString(),
        label: this.coding.label || null,
      }), {
      retryIntervalMs: this.retryIntervalMs,
      maxAttempts: 1,
    });
  }

  _hasPresenceIdentity() {
    return (this.coding.apiUrl && this.coding.token)
      || this.coding.presenceIdentity === 'broker-local';
  }

  _publishPresence(payload, options = {}) {
    if (this.coding.presenceIdentity === 'broker-local') {
      return this.localPresencePublisher({
        payload,
        maxAttempts: options.maxAttempts,
        retryIntervalMs: options.retryIntervalMs,
        shouldContinue: options.shouldContinue,
        deps: {
          memoroFetch: this.memoroFetch,
          sleep: this.sleep,
        },
      });
    }
    return postHeartbeatWithRetry({
      apiUrl: this.coding.apiUrl,
      token: this.coding.token,
      payload,
      memoroFetchImpl: this.memoroFetch,
      sleepImpl: this.sleep,
      ...options,
    });
  }

  async _scheduleUpload() {
    if (this.uploadScheduled || this.coding.upload === false) return;
    this.uploadScheduled = true;
    try {
      const startedAt = Number.isFinite(this.session.startedAt) ? this.session.startedAt - 1000 : 0;
      await this.sessionUploadScheduler({
        source: this._codingSource(),
        cwd: this.session.cwd,
        repoHint: this.coding.repo || null,
        codingSessionId: this.coding.codingSessionId,
        newerThanMs: startedAt,
      });
    } catch (err) {
      this.logger.warn?.(`[broker-sidecars] session upload scheduling failed: ${err.message}`);
    }
  }

  _codingSource() {
    return normaliseCodingSource(this.coding.source)
      || sourceForTool(this.coding.tool)
      || sourceForTool(DEFAULT_TOOL);
  }
}

function managedGitHubCapabilities(value) {
  if (value == null) return null;
  const descriptor = decodeSessionCapabilities(value);
  return descriptor.github.state === 'ready' ? descriptor : null;
}

export function sourceForTool(tool) {
  const value = normaliseCodingSource(tool);
  if (!value) return null;
  return canonicalToolId(value) || value;
}

function normaliseCodingSource(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

export const __test__ = {
  TICK_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  MAX_ATTEMPTS,
};

export {
  buildSessionHeartbeatPayload,
  postHeartbeatWithRetry,
};
