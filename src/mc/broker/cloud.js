import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { createFetchTranscriptHandler } from '../../commands/handlers/fetch-transcript.js';
import { requestBroker } from './client.js';
import { brokerSocketPath } from './paths.js';
import { sourceForTool } from './session-sidecars.js';
import {
  listLocalBrokerAndHostSessions,
  requestForSession,
} from './session-hosts.js';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const SESSION_REFRESH_INTERVAL_MS = 5_000;
const LOCAL_TRANSCRIPT_READ_MS = 1_000;
const SUBMIT_ENTER_DELAY_MS = 150;
const DEFAULT_CAPABILITIES = [
  'pty-stream-v1',
  'resize-v1',
  'screen-replay-v1',
];

export class CloudBrokerClient extends EventEmitter {
  constructor({
    apiUrl,
    token,
    machineId = hostname(),
    deviceName = machineId,
    mcVersion = null,
    sourceId = null,
    sourceKind = null,
    sourceName = null,
    cloudSessionId = null,
    env = process.env,
    request = requestBroker,
    connect = createConnection,
    WebSocketImpl = globalThis.WebSocket,
    brokerSocket = brokerSocketPath(),
    capabilities = DEFAULT_CAPABILITIES,
    sessionRefreshIntervalMs = SESSION_REFRESH_INTERVAL_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    sleepImpl = sleep,
    localTranscriptReadMs = LOCAL_TRANSCRIPT_READ_MS,
    fetchTranscriptHandlerFactory = createFetchTranscriptHandler,
    repoCatalogProvider = null,
    logger = silentLogger(),
  } = {}) {
    super();
    if (!apiUrl) throw new TypeError('apiUrl is required');
    if (!token) throw new TypeError('token is required');
    if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket implementation is required');
    this.apiUrl = apiUrl;
    this.token = token;
    this.machineId = machineId;
    this.deviceName = deviceName;
    this.mcVersion = mcVersion;
    this.sourceIdentity = resolveSourceIdentity({
      sourceId,
      sourceKind,
      sourceName,
      cloudSessionId,
      env,
      machineId,
      deviceName,
    });
    this.request = request;
    this.connect = connect;
    this.WebSocketImpl = WebSocketImpl;
    this.brokerSocket = brokerSocket;
    this.capabilities = capabilities;
    this.sessionRefreshIntervalMs = sessionRefreshIntervalMs;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.sleep = sleepImpl;
    this.localTranscriptReadMs = localTranscriptReadMs;
    this.fetchTranscriptHandlerFactory = fetchTranscriptHandlerFactory;
    this.repoCatalogProvider = repoCatalogProvider;
    this.logger = logger;
    this.ws = null;
    this.alive = false;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.attaches = new Map();
    this.refreshTimer = null;
    this.refreshInFlight = null;
  }

  start() {
    if (this.alive) return;
    this.alive = true;
    this._connectControl();
  }

  stop() {
    this.alive = false;
    this._stopSessionRefreshLoop();
    if (this.ws) {
      try { this.ws.close(1000, 'stopping'); } catch {}
      this.ws = null;
    }
    for (const bridge of this.attaches.values()) {
      try { bridge.stop(); } catch {}
    }
    this.attaches.clear();
  }

  async refreshSessions({ refreshRepos = true } = {}) {
    const sessions = await listLocalBrokerSessions({ request: this.request });
    this._send({
      type: 'sessions',
      machine_id: this.machineId,
      ...sourceIdentityPayload(this.sourceIdentity),
      sessions: sessions.map(publicSessionForCloud),
    });
    this.emit('sessions', sessions);
    if (refreshRepos) void this.refreshRepos();
    return sessions;
  }

  async refreshRepos() {
    const repos = await this._localReposSafe();
    if (!repos.length) return repos;
    this._send({
      type: 'repos',
      machine_id: this.machineId,
      ...sourceIdentityPayload(this.sourceIdentity),
      repos,
    });
    this.emit('repos', repos);
    return repos;
  }

  _connectControl() {
    if (!this.alive) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(buildBrokerWsUrl(this.apiUrl, {
        token: this.token,
        machineId: this.machineId,
        ...sourceIdentityPayload(this.sourceIdentity),
      }));
      preferArrayBufferFrames(ws);
    } catch (err) {
      this.logger.warn(`[broker-cloud] control websocket failed: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    addWsListener(ws, 'open', () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.emit('open', { machine_id: this.machineId });
      this._send({
        type: 'hello',
        machine_id: this.machineId,
        device_name: this.deviceName,
        ...(this.mcVersion ? { mc_version: this.mcVersion } : {}),
        ...sourceIdentityPayload(this.sourceIdentity),
        capabilities: this.capabilities,
      });
      this._startSessionRefreshLoop();
      this._refreshSessionsSafe();
    });

    addWsListener(ws, 'message', (event) => {
      this._onControlMessage(event?.data ?? event).catch((err) => {
        this.logger.warn(`[broker-cloud] message failed: ${err.message}`);
      });
    });

    addWsListener(ws, 'close', () => {
      if (this.ws === ws) this.ws = null;
      this._stopSessionRefreshLoop();
      this._scheduleReconnect();
    });

    addWsListener(ws, 'error', () => {
      this.logger.warn('[broker-cloud] control websocket error');
    });
  }

  async _onControlMessage(raw) {
    const msg = parseJsonMessage(raw);
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ack') return;
    if (msg.type === 'refresh_sessions' || msg.type === 'list_sessions') {
      await this._refreshSessionsSafe();
      return;
    }
    if (msg.type === 'attach_request') {
      await this._handleAttachRequest(msg);
      return;
    }
    if (msg.type === 'command') {
      await this._handleCommand(msg);
    }
  }

  async _handleCommand(msg) {
    const commandId = msg?.command_id;
    if (typeof commandId !== 'string' || commandId.length === 0) return;
    try {
      const data = await this._executeCommand(msg);
      this._sendResult({ command_id: commandId, ok: true, data });
    } catch (err) {
      this._sendResult({ command_id: commandId, ok: false, error: err.message || String(err) });
    }
  }

  async _executeCommand(msg) {
    const kind = requiredString(msg?.kind, 'kind');
    const args = plainObject(msg.args) ? msg.args : {};
    if (kind === 'dispatch_message') {
      const sessionId = requiredString(msg.coding_session_id || msg.session_id, 'coding_session_id');
      const message = requiredString(args.message, 'message');
      const request = await this._requestForSessionId(sessionId);
      const result = await this._dispatchMessage({ sessionId, message, toolHint: args.tool || msg.tool || msg.source, request });
      if (!result?.ok) {
        throw new Error(result?.error || `dispatch failed for broker session: ${sessionId}`);
      }
      return result;
    }
    if (kind === 'fetch_transcript') {
      const sourceHint = stringOrDefault(args.source, stringOrDefault(msg.source, ''));
      const toolHint = stringOrDefault(args.tool, stringOrDefault(msg.tool, ''));
      const transcriptPath = args.transcript_path || args.transcriptPath;
      if (!transcriptPath) {
        const sessionId = requiredString(msg.coding_session_id || msg.session_id, 'coding_session_id');
        const request = await this._requestForSessionId(sessionId);
        return this._fetchSessionOutputTranscript({ sessionId, sourceHint, toolHint, request });
      }
      const source = transcriptSource({ sourceHint, toolHint });
      const handler = this.fetchTranscriptHandlerFactory({ transcriptPath, source });
      return handler(args);
    }
    if (kind === 'stop_session') {
      const sessionId = requiredString(msg.coding_session_id || msg.session_id, 'coding_session_id');
      const signal = stringOrDefault(args.signal, 'SIGTERM');
      const request = await this._requestForSessionId(sessionId);
      const result = await request({ type: 'stop_session', id: sessionId, signal });
      if (result?.ok) await this._refreshSessionsSafe();
      return result;
    }
    if (kind === 'remove_session') {
      const sessionId = requiredString(msg.coding_session_id || msg.session_id, 'coding_session_id');
      const request = await this._requestForSessionId(sessionId);
      const result = await request({ type: 'remove_session', id: sessionId });
      if (result?.ok) await this._refreshSessionsSafe();
      return result;
    }
    throw new Error(`No handler for kind '${kind}'`);
  }

  async _fetchSessionOutputTranscript({ sessionId, sourceHint = '', toolHint = '', request = this.request }) {
    const result = await request({
      type: 'fetch_session_output',
      id: sessionId,
    });
    if (!result?.ok) {
      return this._transcriptFromSessionOutput({
        sessionId,
        source: transcriptSource({ sourceHint, toolHint }),
        session: {},
        output: '',
        fallback: 'broker_recent_output_unavailable',
      });
    }
    const session = result.session && typeof result.session === 'object' ? result.session : {};
    return this._transcriptFromSessionOutput({
      sessionId,
      source: transcriptSource({ sourceHint, toolHint, sessionTool: session.tool }),
      session,
      output: typeof result.output === 'string' ? result.output : '',
      fallback: 'broker_recent_output',
    });
  }

  async _dispatchMessage({ sessionId, message, toolHint = null, request = this.request }) {
    const status = await request({ type: 'session_status', id: sessionId }).catch(() => null);
    const session = status?.ok && status.session && typeof status.session === 'object'
      ? status.session
      : {};
    const tool = stringOrDefault(session.tool, stringOrDefault(toolHint, ''));
    const raw = await this._writeDispatchedInput({ sessionId, message, tool, request });
    if (raw?.ok) {
      return { ok: true, transport: 'write_session', session };
    }
    if (raw?.partial) return raw;
    const fallback = await request({ type: 'dispatch_session', id: sessionId, message }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!fallback?.ok) return fallback;
    return { ...fallback, transport: fallback.transport || 'dispatch_session' };
  }

  async _writeDispatchedInput({ sessionId, message, tool, request = this.request }) {
    const submitEnterCount = submitEnterCountForTool(tool);
    const first = await request({ type: 'write_session', id: sessionId, data: `${message}\r` }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!first?.ok) return first;

    for (let i = 1; i < submitEnterCount; i += 1) {
      await this.sleep(SUBMIT_ENTER_DELAY_MS);
      const next = await request({ type: 'write_session', id: sessionId, data: '\r' }).catch((err) => ({
        ok: false,
        error: err.message || String(err),
      }));
      if (!next?.ok) return { ...next, partial: true };
    }
    return { ok: true };
  }

  _transcriptFromSessionOutput({ sessionId, source, session, output, fallback }) {
    return {
      source,
      session_id: sessionId,
      cwd: typeof session.cwd === 'string' ? session.cwd : null,
      tool_version: null,
      started_at: session.started_at || null,
      ended_at: session.exit?.at || null,
      messages: output ? [{ role: 'assistant', text: output }] : [],
      activities: [],
      fallback,
    };
  }

  _readLocalSessionOutput(sessionId) {
    return readLocalSessionOutput({
      request: this.request,
      sessionId,
      timeoutMs: this.localTranscriptReadMs,
    });
  }

  async _requestForSessionId(sessionId) {
    const sessions = await listLocalBrokerSessions({ request: this.request }).catch(() => []);
    const session = sessions.find((item) => sessionMatchesId(item, sessionId));
    return requestForSession(session, { request: this.request });
  }

  _sendResult({ command_id, ok, data, error }) {
    const payload = { type: 'result', command_id, ok };
    if (ok) payload.data = data;
    else payload.error = error;
    this._send(payload);
  }

  async _handleAttachRequest(msg) {
    const attachId = requiredString(msg.attach_id, 'attach_id');
    const sessionId = requiredString(msg.coding_session_id || msg.session_id, 'coding_session_id');
    const brokerWsUrl = requiredString(msg.broker_ws_url || msg.ws_url, 'broker_ws_url');
    const sessions = await listLocalBrokerSessions({ request: this.request }).catch(() => []);
    const session = sessions.find((item) => sessionMatchesId(item, sessionId));
    const request = requestForSession(session, { request: this.request });

    const bridge = createAttachBridge({
      attachId,
      sessionId,
      brokerWsUrl,
      token: msg.token || null,
      cols: msg.cols || 80,
      rows: msg.rows || 24,
      request,
      connect: this.connect,
      WebSocketImpl: this.WebSocketImpl,
      brokerSocket: session?.broker_socket_path || this.brokerSocket,
      onClose: () => this.attaches.delete(attachId),
    });
    this.attaches.set(attachId, bridge);
    try {
      bridge.start();
      this._send({ type: 'attach_connecting', attach_id: attachId, coding_session_id: sessionId });
    } catch (err) {
      this.attaches.delete(attachId);
      this._send({ type: 'attach_failed', attach_id: attachId, error: err.message || String(err) });
    }
  }

  _send(message) {
    if (!this.ws) return false;
    if (!isUsableWebSocket(this.ws)) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  _startSessionRefreshLoop() {
    this._stopSessionRefreshLoop();
    if (!Number.isFinite(this.sessionRefreshIntervalMs) || this.sessionRefreshIntervalMs <= 0) return;
    this.refreshTimer = this.setInterval(() => this._refreshSessionsSafe(), this.sessionRefreshIntervalMs);
    this.refreshTimer?.unref?.();
  }

  _stopSessionRefreshLoop() {
    if (!this.refreshTimer) return;
    this.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  _refreshSessionsSafe() {
    if (!this.alive || !this.ws || !isUsableWebSocket(this.ws)) return Promise.resolve(null);
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshSessions().catch((err) => {
      this._send({ type: 'sessions_error', error: err.message || String(err) });
      this.logger.warn(`[broker-cloud] session refresh failed: ${err.message || String(err)}`);
      return null;
    }).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async _localReposSafe() {
    if (typeof this.repoCatalogProvider !== 'function') return [];
    try {
      const repos = await this.repoCatalogProvider();
      return Array.isArray(repos) ? repos : [];
    } catch (err) {
      this.logger.warn(`[broker-cloud] repo catalog failed: ${err.message || String(err)}`);
      return [];
    }
  }

  async _scheduleReconnect() {
    if (!this.alive) return;
    const delay = this.backoffMs;
    this.backoffMs = nextBackoff(this.backoffMs);
    try { await this.sleep(delay); } catch {}
    if (this.alive) this._connectControl();
  }
}

export function createAttachBridge({
  attachId,
  sessionId,
  brokerWsUrl,
  token = null,
  cols = 80,
  rows = 24,
  request = requestBroker,
  connect = createConnection,
  WebSocketImpl = globalThis.WebSocket,
  brokerSocket = brokerSocketPath(),
  onClose = null,
} = {}) {
  if (!attachId) throw new TypeError('attachId is required');
  if (!sessionId) throw new TypeError('sessionId is required');
  if (!brokerWsUrl) throw new TypeError('brokerWsUrl is required');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket implementation is required');

  let local = null;
  let remote = null;
  let stopped = false;
  let header = Buffer.alloc(0);
  let localReady = false;
  let remoteReady = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { local?.destroy?.(); } catch {}
    try { remote?.close?.(1000, 'detach'); } catch {}
    if (typeof onClose === 'function') onClose();
  };

  const sendRemote = (data) => {
    if (!remote || remote.readyState !== 1) return false;
    remote.send(data);
    return true;
  };

  const flushLocalData = (chunk) => {
    if (stopped) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (!localReady) {
      const next = Buffer.concat([header, data]);
      const newline = next.indexOf(10);
      if (newline === -1) {
        header = next;
        return;
      }
      let ack;
      try {
        ack = JSON.parse(next.subarray(0, newline).toString('utf8') || '{}');
      } catch (err) {
        sendRemote(JSON.stringify({ type: 'attach_error', attach_id: attachId, error: `invalid local attach response: ${err.message}` }));
        stop();
        return;
      }
      if (!ack.ok) {
        sendRemote(JSON.stringify({ type: 'attach_error', attach_id: attachId, error: ack.error || 'attach failed' }));
        stop();
        return;
      }
      localReady = true;
      sendRemote(JSON.stringify({
        type: 'attach_accepted',
        attach_id: attachId,
        session: ack.session || null,
        attach: ack.attach || null,
        writer: !!ack.writer,
      }));
      const rest = next.subarray(newline + 1);
      if (rest.length) sendRemote(rest);
      return;
    }
    sendRemote(data);
  };

  const handleRemoteFrame = (frame) => {
    if (stopped || !local) return;
    const decoded = decodeWsFrame(frame);
    if (typeof decoded === 'string') {
      const control = parseJsonMessage(decoded);
      if (control?.type === 'resize') {
        request({
          type: 'resize_session',
          id: sessionId,
          cols: control.cols,
          rows: control.rows,
          side: 'cloud',
          attach_id: attachId,
        }).catch(() => {});
        return;
      }
      if (control?.type === 'detach') {
        stop();
        return;
      }
      local.write(decoded);
      return;
    }
    local.write(decoded);
  };

  return {
    start() {
      remote = new WebSocketImpl(appendToken(brokerWsUrl, token));
      preferArrayBufferFrames(remote);
      local = connect(brokerSocket);

      addWsListener(remote, 'open', () => {
        remoteReady = true;
        local.write(JSON.stringify({
          type: 'attach_session',
          id: sessionId,
          attach_id: attachId,
          side: 'cloud',
          cols,
          rows,
          writer: true,
          mode: 'write',
        }) + '\n');
      });
      addWsListener(remote, 'message', (event) => handleRemoteFrame(event?.data ?? event));
      addWsListener(remote, 'close', stop);
      addWsListener(remote, 'error', stop);

      local.on('data', flushLocalData);
      local.on('end', stop);
      local.on('close', stop);
      local.on('error', stop);
      return this;
    },
    stop,
    get localReady() { return localReady; },
    get remoteReady() { return remoteReady; },
  };
}

export async function listLocalBrokerSessions({ request = requestBroker } = {}) {
  const sessions = await listLocalBrokerAndHostSessions({ request });
  if (Array.isArray(sessions)) return sessions;
  throw new Error('broker did not return sessions');
}

export function buildBrokerWsUrl(apiUrl, {
  token,
  machineId,
  sourceId,
  sourceKind,
  sourceName,
  cloudSessionId,
  source_id,
  source_kind,
  source_name,
  cloud_session_id,
} = {}) {
  const wsBase = apiUrl.replace(/^http(s?):\/\//i, (_, s) => (s === 's' ? 'wss://' : 'ws://'));
  const url = new URL('/api/mc/broker/ws', wsBase);
  if (token) url.searchParams.set('token', token);
  if (machineId) url.searchParams.set('machine_id', machineId);
  setOptionalQueryParam(url, 'source_id', stringOrDefault(sourceId, source_id));
  setOptionalQueryParam(url, 'source_kind', stringOrDefault(sourceKind, source_kind));
  setOptionalQueryParam(url, 'source_name', stringOrDefault(sourceName, source_name));
  setOptionalQueryParam(url, 'cloud_session_id', stringOrDefault(cloudSessionId, cloud_session_id));
  return url.toString();
}

export function appendToken(urlString, token) {
  if (!token) return urlString;
  const url = new URL(urlString);
  url.searchParams.set('token', token);
  return url.toString();
}

export function resolveSourceIdentity({
  sourceId = null,
  sourceKind = null,
  sourceName = null,
  cloudSessionId = null,
  env = process.env,
  machineId = hostname(),
  deviceName = machineId,
} = {}) {
  const kind = stringOrDefault(sourceKind, stringOrDefault(env?.MC_SOURCE_KIND, 'local'));
  return {
    source_id: stringOrDefault(sourceId, stringOrDefault(env?.MC_SOURCE_ID, `local:${machineId}`)),
    source_kind: kind,
    source_name: stringOrDefault(sourceName, stringOrDefault(env?.MC_SOURCE_NAME, deviceName)),
    cloud_session_id: stringOrDefault(cloudSessionId, stringOrDefault(env?.MC_CLOUD_SESSION_ID, null)),
  };
}

export function nextBackoff(currentMs) {
  return Math.min((currentMs || INITIAL_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
}

function addWsListener(ws, event, handler) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler);
  } else if (typeof ws.on === 'function') {
    ws.on(event, handler);
  }
}

function parseJsonMessage(raw) {
  if (raw == null) return null;
  const text = typeof raw === 'string' ? raw : raw?.toString?.('utf8') || '';
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function decodeWsFrame(frame) {
  if (typeof frame === 'string') return frame;
  if (Buffer.isBuffer(frame)) return frame;
  if (frame instanceof ArrayBuffer) return Buffer.from(frame);
  if (ArrayBuffer.isView(frame)) return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  return Buffer.from(String(frame));
}

function preferArrayBufferFrames(ws) {
  try { ws.binaryType = 'arraybuffer'; } catch {}
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function stringOrDefault(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function transcriptSource({ sourceHint = '', toolHint = '', sessionTool = '' } = {}) {
  return stringOrDefault(
    sourceHint,
    sourceForTool(toolHint) || sourceForTool(sessionTool) || 'claude-code',
  );
}

function sourceIdentityPayload(identity) {
  const payload = {};
  for (const key of ['source_id', 'source_kind', 'source_name', 'cloud_session_id']) {
    if (typeof identity?.[key] === 'string' && identity[key].length > 0) {
      payload[key] = identity[key];
    }
  }
  return payload;
}

function setOptionalQueryParam(url, key, value) {
  if (typeof value === 'string' && value.length > 0) {
    url.searchParams.set(key, value);
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function sessionMatchesId(session, sessionId) {
  return !!session && !!sessionId && (
    session.id === sessionId
    || session.coding_session_id === sessionId
  );
}

function publicSessionForCloud(session = {}) {
  const {
    broker_socket_path,
    broker_pid_path,
    broker_log_path,
    host_kind,
    host_session_id,
    ...publicSession
  } = session;
  return publicSession;
}

function submitEnterCountForTool(tool) {
  return isCodexTool(tool) ? 2 : 1;
}

function isCodexTool(tool) {
  return /^codex\b|^codex-/i.test(String(tool || '').trim());
}

function isUsableWebSocket(ws) {
  return !(typeof ws?.readyState === 'number' && ws.readyState > 1);
}

export function readLocalSessionOutput({
  request = null,
  sessionId,
  timeoutMs = LOCAL_TRANSCRIPT_READ_MS,
} = {}) {
  requiredString(sessionId, 'session id');
  const requestFn = request || ((message) => requestBroker(message, { timeoutMs }));
  return requestFn({
    type: 'fetch_session_output',
    id: sessionId,
  }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'broker recent output unavailable');
    return cleanTerminalText(typeof res.output === 'string' ? res.output : '');
  });
}

function cleanTerminalText(value) {
  return String(value || '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

export const __test__ = {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  DEFAULT_CAPABILITIES,
};
