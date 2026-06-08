import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { requestBroker } from './client.js';
import { brokerSocketPath } from './paths.js';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_CAPABILITIES = [
  'pty-stream-v1',
  'resize-v1',
  'writer-lease-v1',
  'screen-replay-v1',
];

export class CloudBrokerClient extends EventEmitter {
  constructor({
    apiUrl,
    token,
    machineId = hostname(),
    deviceName = machineId,
    mcVersion = null,
    request = requestBroker,
    connect = createConnection,
    WebSocketImpl = globalThis.WebSocket,
    brokerSocket = brokerSocketPath(),
    capabilities = DEFAULT_CAPABILITIES,
    sleepImpl = sleep,
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
    this.request = request;
    this.connect = connect;
    this.WebSocketImpl = WebSocketImpl;
    this.brokerSocket = brokerSocket;
    this.capabilities = capabilities;
    this.sleep = sleepImpl;
    this.logger = logger;
    this.ws = null;
    this.alive = false;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.attaches = new Map();
  }

  start() {
    if (this.alive) return;
    this.alive = true;
    this._connectControl();
  }

  stop() {
    this.alive = false;
    if (this.ws) {
      try { this.ws.close(1000, 'stopping'); } catch {}
      this.ws = null;
    }
    for (const bridge of this.attaches.values()) {
      try { bridge.stop(); } catch {}
    }
    this.attaches.clear();
  }

  async refreshSessions() {
    const sessions = await listLocalBrokerSessions({ request: this.request });
    this._send({ type: 'sessions', machine_id: this.machineId, sessions });
    this.emit('sessions', sessions);
    return sessions;
  }

  _connectControl() {
    if (!this.alive) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(buildBrokerWsUrl(this.apiUrl, {
        token: this.token,
        machineId: this.machineId,
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
        capabilities: this.capabilities,
      });
      this.refreshSessions().catch((err) => {
        this._send({ type: 'sessions_error', error: err.message || String(err) });
      });
    });

    addWsListener(ws, 'message', (event) => {
      this._onControlMessage(event?.data ?? event).catch((err) => {
        this.logger.warn(`[broker-cloud] message failed: ${err.message}`);
      });
    });

    addWsListener(ws, 'close', () => {
      if (this.ws === ws) this.ws = null;
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
      await this.refreshSessions();
      return;
    }
    if (msg.type === 'attach_request') {
      await this._handleAttachRequest(msg);
    }
  }

  async _handleAttachRequest(msg) {
    const attachId = requiredString(msg.attach_id, 'attach_id');
    const sessionId = requiredString(msg.coding_session_id || msg.session_id, 'coding_session_id');
    const brokerWsUrl = requiredString(msg.broker_ws_url || msg.ws_url, 'broker_ws_url');

    const bridge = createAttachBridge({
      attachId,
      sessionId,
      brokerWsUrl,
      token: msg.token || null,
      cols: msg.cols || 80,
      rows: msg.rows || 24,
      writer: msg.writer !== false,
      request: this.request,
      connect: this.connect,
      WebSocketImpl: this.WebSocketImpl,
      brokerSocket: this.brokerSocket,
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
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(message));
    return true;
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
  writer = true,
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
          writer,
          mode: writer ? 'write' : 'read-only',
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
  const res = await request({ type: 'sessions' }).catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (res?.ok && Array.isArray(res.sessions)) return res.sessions;
  const status = await request({ type: 'status' }).catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (status?.ok && Array.isArray(status.sessions)) return status.sessions;
  throw new Error(res?.error || status?.error || 'broker did not return sessions');
}

export function buildBrokerWsUrl(apiUrl, { token, machineId } = {}) {
  const wsBase = apiUrl.replace(/^http(s?):\/\//i, (_, s) => (s === 's' ? 'wss://' : 'ws://'));
  const url = new URL('/api/mc/broker/ws', wsBase);
  if (token) url.searchParams.set('token', token);
  if (machineId) url.searchParams.set('machine_id', machineId);
  return url.toString();
}

export function appendToken(urlString, token) {
  if (!token) return urlString;
  const url = new URL(urlString);
  url.searchParams.set('token', token);
  return url.toString();
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

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

export const __test__ = {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  DEFAULT_CAPABILITIES,
};
