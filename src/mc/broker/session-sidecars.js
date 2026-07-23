import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { CliWsClient } from '../../commands/ws-client.js';
import { createFetchTranscriptHandler } from '../../commands/handlers/fetch-transcript.js';
import { memoroFetch } from '../../lib/api.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { extractExcerpt } from '../session-excerpt.js';
import {
  resolveSessionSourceIdentity,
  SessionProjectionTracker,
} from '../session-projector.js';
import { scheduleSessionUpload } from '../session-upload.js';
import { executeGitHubControlPlaneOperation } from '../github-session.js';
import { createConnectionClient } from '../connections/client.js';
import { createBoundIdentityBroker } from '../connections/identity.js';

const TICK_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const EXCERPT_MAX_CHARS = 500;

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
    excerptMaxChars = EXCERPT_MAX_CHARS,
    sessionUploadScheduler = scheduleSessionUpload,
    projectionTracker = null,
    connectionClient = null,
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
    this.connectionClient = connectionClient || (
      coding.apiUrl && coding.token
        ? createConnectionClient({
            identityBroker: createBoundIdentityBroker({
              token: coding.token,
              apiUrl: coding.apiUrl,
              memoroFetch: memoroFetchImpl,
            }),
            memoroFetch: memoroFetchImpl,
          })
        : null
    );
    this.sleep = sleepImpl;
    this.now = now;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.retryIntervalMs = retryIntervalMs;
    this.maxAttempts = maxAttempts;
    this.excerptMaxChars = excerptMaxChars;
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
    this.heartbeatPromise = null;
    this.uploadScheduled = false;
  }

  start() {
    this.alive = true;
    this._writeMetadata();
    this._startDispatchSocket();
    this._startWsClient();
    this._startHeartbeat();
    return this;
  }

  stop() {
    this.alive = false;
    try { this.wsClient?.stop?.(); } catch {}
    try { this.dispatchServer?.close?.(); } catch {}
    this._unlink(this.coding.sockPath);
    this._unlink(this.coding.metaPath);
    void this._scheduleUpload();
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
    this.wsClient = this.wsClientFactory({
      apiUrl: this.coding.apiUrl,
      token: this.coding.token,
      codingSessionId: this.coding.codingSessionId,
      handlers: {
        fetch_transcript: this.fetchTranscriptHandlerFactory({
          transcriptPath: this.coding.transcriptPath || null,
          source: this._codingSource(),
        }),
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
    if (!this.coding.apiUrl || !this.coding.token || this.coding.heartbeat === false) return;
    this.heartbeatPromise = this._runHeartbeat();
  }

  async _runHeartbeat() {
    while (this.alive) {
      const now = this.now();
      await postHeartbeatWithRetry({
        apiUrl: this.coding.apiUrl,
        token: this.coding.token,
        payload: buildSessionHeartbeatPayload({
          codingSessionId: this.coding.codingSessionId,
          machineId: this.coding.machineId || null,
          sourceIdentity: this.sourceIdentity,
          source: this._codingSource(),
          repo: this.coding.repoRef || this.coding.repo_ref || this.coding.repo || null,
          branch: this.coding.branch || null,
          lastAssistantExcerpt: extractExcerpt(this.session.recentOutput(), this.excerptMaxChars),
          idleSeconds: Math.max(0, Math.floor((now - (this.session.lastOutputAt || now)) / 1000)),
          at: new Date(now).toISOString(),
          sessionProjection: this.currentProjection({ now }),
          label: this.coding.label || null,
        }),
        memoroFetchImpl: this.memoroFetch,
        sleepImpl: this.sleep,
        retryIntervalMs: this.retryIntervalMs,
        maxAttempts: this.maxAttempts,
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

export function buildSessionHeartbeatPayload({
  codingSessionId,
  machineId,
  sourceIdentity = {},
  source,
  repo,
  branch,
  lastAssistantExcerpt = '',
  idleSeconds = 0,
  at,
  sessionProjection,
  label = null,
} = {}) {
  return {
    coding_session_id: codingSessionId,
    machine_id: machineId,
    source_id: sourceIdentity.source_id,
    source_kind: sourceIdentity.source_kind,
    source_name: sourceIdentity.source_name,
    cloud_session_id: sourceIdentity.cloud_session_id,
    source,
    repo,
    branch,
    files_touched_since_last: [],
    last_user_excerpt: '',
    last_assistant_excerpt: lastAssistantExcerpt,
    idle_seconds: idleSeconds,
    at,
    session_projection: sessionProjection,
    ...(label ? { label } : {}),
  };
}

export function sourceForTool(tool) {
  const value = normaliseCodingSource(tool);
  if (!value) return null;
  if (value === 'claude') return 'claude-code';
  if (value === 'gemini') return 'gemini-cli';
  return value;
}

function normaliseCodingSource(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export async function postHeartbeatWithRetry({
  apiUrl,
  token,
  payload,
  memoroFetchImpl = memoroFetch,
  sleepImpl = sleep,
  retryIntervalMs = RETRY_INTERVAL_MS,
  maxAttempts = MAX_ATTEMPTS,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await memoroFetchImpl(apiUrl, '/api/sessions/heartbeat', {
        token, method: 'POST', body: payload,
      });
      return true;
    } catch {
      if (attempt < maxAttempts - 1) {
        try { await sleepImpl(retryIntervalMs); } catch {}
      }
    }
  }
  return false;
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

export const __test__ = {
  TICK_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  MAX_ATTEMPTS,
  EXCERPT_MAX_CHARS,
};
