/**
 * memoro-cli WebSocket client for the coding-coordinator command channel.
 *
 * Opens a WebSocket to /api/sessions/ws and holds it open for the life of
 * the heartbeat-loop daemon. Receives `command` messages from the server,
 * dispatches them to handlers, and posts back `result` messages.
 *
 * Reconnect on disconnect with exponential backoff (1s → 30s cap).
 *
 * Native WebSocket (Node 22+) follows the WHATWG spec — no custom headers
 * — so the bearer token rides as ?token=... on the upgrade URL. The
 * server lifts it back into an Authorization header before auth runs.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;

export class CliWsClient {
  constructor({ apiUrl, token, codingSessionId, handlers, logger = silentLogger() }) {
    this.apiUrl = apiUrl;
    this.token = token;
    this.codingSessionId = codingSessionId;
    this.handlers = handlers;
    this.logger = logger;
    this.ws = null;
    this.alive = false;
    this.backoffMs = INITIAL_BACKOFF_MS;
  }

  start() {
    if (this.alive) return;
    this.alive = true;
    this._connect();
  }

  stop() {
    this.alive = false;
    if (this.ws) {
      try { this.ws.close(1000, 'shutting down'); } catch { /* best effort */ }
      this.ws = null;
    }
  }

  _connect() {
    if (!this.alive) return;
    if (typeof WebSocket !== 'function') {
      this.logger.warn('[ws] WebSocket global unavailable — needs Node 22+');
      return;
    }

    const url = buildWsUrl(this.apiUrl, this.token, this.codingSessionId);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.logger.warn(`[ws] connect failed: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      try {
        ws.send(JSON.stringify({ type: 'hello', coding_session_id: this.codingSessionId }));
      } catch (err) {
        this.logger.warn(`[ws] hello send failed: ${err.message}`);
      }
    });

    ws.addEventListener('message', (event) => {
      this._onMessage(event.data).catch((err) => {
        this.logger.warn(`[ws] message handler crashed: ${err.message}`);
      });
    });

    ws.addEventListener('close', (event) => {
      this.ws = null;
      this.logger.info(`[ws] closed (code=${event?.code ?? '?'} reason=${event?.reason || ''})`);
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' fires after 'error'; do the reconnect bookkeeping there.
      this.logger.warn('[ws] error event');
    });
  }

  async _onMessage(raw) {
    const text = typeof raw === 'string' ? raw : raw?.toString?.('utf8') || '';
    let data;
    try { data = JSON.parse(text); } catch {
      this.logger.warn('[ws] non-JSON server message');
      return;
    }

    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'ack') {
      this.logger.info('[ws] handshake acknowledged');
      return;
    }

    if (data.type === 'command') {
      await this._handleCommand(data);
      return;
    }

    if (data.type === 'error') {
      this.logger.warn(`[ws] server error: ${data.error || 'unknown'}`);
      return;
    }

    this.logger.warn(`[ws] unknown server message type: ${data.type}`);
  }

  async _handleCommand({ command_id, kind, args }) {
    if (!command_id || typeof command_id !== 'string') return;
    const handler = this.handlers?.[kind];
    if (!handler) {
      this._sendResult({ command_id, ok: false, error: `No handler for kind '${kind}'` });
      return;
    }
    try {
      const data = await Promise.race([
        Promise.resolve(handler(args || {})),
        timeoutPromise(COMMAND_TIMEOUT_MS),
      ]);
      this._sendResult({ command_id, ok: true, data });
    } catch (err) {
      this._sendResult({ command_id, ok: false, error: err.message || String(err) });
    }
  }

  _sendResult({ command_id, ok, data, error }) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      this.logger.warn(`[ws] cannot send result for ${command_id}: WS not open`);
      return;
    }
    const payload = { type: 'result', command_id, ok };
    if (ok) payload.data = data;
    else payload.error = error;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.logger.warn(`[ws] result send failed: ${err.message}`);
    }
  }

  async _scheduleReconnect() {
    if (!this.alive) return;
    const delay = this.backoffMs;
    this.backoffMs = nextBackoff(this.backoffMs);
    this.logger.info(`[ws] reconnecting in ${delay}ms`);
    try { await sleep(delay); } catch { /* signal-interrupt */ }
    if (this.alive) this._connect();
  }
}

/**
 * Pure: compute the next backoff delay given the current one. Exported
 * for tests.
 */
export function nextBackoff(currentMs) {
  return Math.min((currentMs || INITIAL_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
}

/**
 * Pure: assemble the WS upgrade URL. Exported for tests.
 */
export function buildWsUrl(apiUrl, token, codingSessionId) {
  const wsBase = apiUrl.replace(/^http(s?):\/\//i, (_, s) => (s === 's' ? 'wss://' : 'ws://'));
  const url = new URL('/api/sessions/ws', wsBase);
  url.searchParams.set('token', token);
  url.searchParams.set('coding_session_id', codingSessionId);
  return url.toString();
}

function timeoutPromise(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Command timed out after ${ms}ms`)), ms);
  });
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

export const __test__ = {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  COMMAND_TIMEOUT_MS,
};
