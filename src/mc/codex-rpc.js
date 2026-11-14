/**
 * The one JSON-RPC client mc has for a session's `codex app-server` socket.
 *
 * The server speaks a websocket on a unix socket, one JSON-RPC message per
 * frame, the `jsonrpc` header left off the wire (the same dialect as
 * `codex-capacity.js`, whose bounds this client shares). mc asks a session's
 * server three things and nothing else: `initialize` (is it answering),
 * `thread/loaded/list` and `thread/read` (which conversation is it holding,
 * and is a turn running). `request` refuses any other method, so no client
 * here can start a thread or a turn.
 *
 * A call is bounded: a finite time for the whole conversation, and a cap on the
 * bytes the server may send. It rejects with a `CodexServerError` whose message
 * says what was measured, and `kind` says which: `unreachable` (nothing
 * listens on the socket: the server is gone), `silent` (it listens and does not
 * answer in time), `overflow` or `protocol`.
 */
import { realpathSync } from 'node:fs';
import WebSocket from 'ws';

import { CODEX_MAX_BYTES, CODEX_TIMEOUT_MS, errorText, isObject } from './codex-capacity.js';

export const RPC_METHODS = Object.freeze(['initialize', 'initialized', 'thread/loaded/list', 'thread/read']);
const CLIENT_INFO = Object.freeze({ name: 'mc', title: 'mc session', version: '1' });
const GONE = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);
const MAX_PAGES = 10;

export class CodexServerError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'CodexServerError';
    this.kind = kind;
  }
}

/**
 * Open the socket, `initialize`, run `work(request)`, close. `request(method, params)`
 * resolves to the answer's `result`. A long socket path is a symlink Codex made to
 * its real target; `unix:` addresses are short, so the link is resolved first.
 */
export function withCodexServer(socket, work, {
  timeoutMs = CODEX_TIMEOUT_MS, maxBytes = CODEX_MAX_BYTES,
  connect = address => new WebSocket(address, { maxPayload: maxBytes }),
  resolvePath = realpathSync, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    const unreachable = reason => new CodexServerError('unreachable', `server not answering on its socket ${socket}: ${reason}`);
    let target;
    try { target = resolvePath(socket); }
    catch (error) { reject(unreachable(error.code || error.message)); return; }

    const pending = new Map();
    let bytes = 0;
    let nextId = 1;
    let settled = false;
    let ws;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      for (const call of pending.values()) call.reject(error || new CodexServerError('protocol', 'closed before the answer'));
      try { ws?.terminate(); } catch { /* already closed */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimer(() => finish(new CodexServerError('silent',
      `server not answering on its socket ${socket} within ${timeoutMs} ms`)), timeoutMs);

    const request = (method, params) => new Promise((resolveCall, rejectCall) => {
      if (!RPC_METHODS.includes(method)) { rejectCall(new Error(`${method} is not sent to a session server`)); return; }
      const id = nextId++;
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      ws.send(JSON.stringify({ method, id, params }));
    });

    try { ws = connect(`ws+unix://${target}:/`); }
    catch (error) { finish(unreachable(error.message)); return; }
    ws.on('error', error => finish(GONE.has(error.code) ? unreachable(error.code)
      : new CodexServerError('protocol', `socket ${socket} failed: ${error.message}`)));
    ws.on('close', () => finish(new CodexServerError('protocol', `server closed its socket ${socket} before it answered`)));
    ws.on('message', data => {
      bytes += data.length ?? Buffer.byteLength(data);
      if (bytes > maxBytes) { finish(new CodexServerError('overflow', `server sent more than ${maxBytes} bytes on ${socket}`)); return; }
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      // A notification, or an answer to nothing mc asked, is passed over.
      const call = isObject(message) ? pending.get(message.id) : null;
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new CodexServerError('protocol', errorText(message.error)));
      else call.resolve(message.result);
    });
    ws.on('open', async () => {
      try {
        await request('initialize', { clientInfo: CLIENT_INFO });
        ws.send(JSON.stringify({ method: 'initialized', params: {} }));
        finish(null, await work(request));
      } catch (error) { finish(error instanceof CodexServerError ? error : new CodexServerError('protocol', error.message)); }
    });
  });
}

/** Every thread the server holds in memory, read without its turns. */
export function readThreads(socket, options = {}) {
  return withCodexServer(socket, async request => {
    const loaded = async () => {
      const ids = [];
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const listed = await request('thread/loaded/list', cursor ? { cursor } : {});
        if (!Array.isArray(listed?.data)) throw new CodexServerError('protocol', `server ${socket} listed its threads in an unknown shape`);
        ids.push(...listed.data);
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      return ids;
    };
    const threads = [];
    for (const id of await loaded()) {
      try { threads.push((await request('thread/read', { threadId: id, includeTurns: false })).thread); }
      catch (error) {
        // A thread that unloaded between the list and the read is not held; any other refusal is.
        if (error.kind !== 'protocol' || (await loaded()).includes(id)) throw error;
      }
    }
    return threads.filter(isObject);
  }, options);
}
