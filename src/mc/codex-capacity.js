/**
 * Codex's subscription capacity, read from its app server, read-only (ruling 59).
 *
 * `codex app-server --stdio` speaks JSON-RPC 2.0 over stdin and stdout, one JSON
 * message a line, the `jsonrpc` header left off the wire
 * (https://learn.chatgpt.com/docs/app-server). The collector sends four kinds of
 * message and no others: `initialize`, `initialized`, `account/rateLimits/read`
 * and `model/list`. It never starts a thread or a turn, so no model is asked
 * anything and no rate-limit reset is consumed. `send` refuses any other method.
 *
 * What it reads:
 *   - the subscription windows, `primary` and `secondary`, from
 *     `rateLimitsByLimitId.codex` when the server gives one, otherwise from
 *     `rateLimits`. `usedPercent` (0–100) becomes a fraction and `resetsAt`
 *     (Unix seconds) an ISO instant. Credits and reset credits are not read:
 *     they are not subscription headroom.
 *   - the models and efforts the account can choose, from `model/list`. Only
 *     the picker's list is asked for, and every page of it. A list that is
 *     missing, malformed or longer than MODEL_PAGES pages is a failed read.
 *
 * The read is all or nothing: a failure in either half is a failed observation,
 * and the caller keeps the last valid snapshot (model-capacity.js applyFailure).
 *
 * The child is bounded: a finite time, a cap on the bytes it may send, and an
 * end on the first answer. It is the only process this module signals, and it
 * never throws — every outcome is a resolved `{ ok, … }`.
 */
import { spawn as spawnChild } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { applyFailure, applyObservation, readCapacity, writeCapacity } from './model-capacity.js';
import { runnerDir } from './paths.js';

export const CODEX_TIMEOUT_MS = 20 * 1000;
export const CODEX_MAX_BYTES = 1 << 20;
/** Pages of `model/list` read before the list is called incomplete. */
export const MODEL_PAGES = 5;
/** The only methods the collector sends. A thread or a turn would spend a model call or a reset. */
export const SENT_METHODS = Object.freeze(['initialize', 'initialized', 'account/rateLimits/read', 'model/list']);
const CLIENT_INFO = Object.freeze({ name: 'mc', title: 'mc capacity', version: '1' });

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** One rate-limit window as `{ fraction_used, resets_at }`, or null when its usage or reset does not read. */
export function codexWindow(value) {
  const used = value?.usedPercent;
  const resets = value?.resetsAt;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) return null;
  return { fraction_used: used / 100, resets_at: new Date(resets * 1000).toISOString() };
}

/**
 * The subscription windows of an `account/rateLimits/read` result, `{ primary, secondary }`,
 * or null when it holds no window at all. `rateLimitsByLimitId.codex` is used
 * when the server gives it; otherwise `rateLimits`.
 */
export function codexRateLimits(result) {
  if (!isObject(result)) return null;
  const byId = isObject(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId.codex : undefined;
  const snapshot = isObject(byId) ? byId : result.rateLimits;
  if (!isObject(snapshot)) return null;
  const windows = { primary: codexWindow(snapshot.primary), secondary: codexWindow(snapshot.secondary) };
  return windows.primary || windows.secondary ? windows : null;
}

/**
 * One `model/list` page as `{ models, nextCursor }`, where a model is `{ id, efforts }`
 * and `nextCursor` is null on the last page. Null when the answer is not a list.
 */
export function codexModelPage(result) {
  if (!isObject(result) || !Array.isArray(result.data)) return null;
  const models = result.data.filter(isObject).map((entry) => {
    const id = typeof entry.model === 'string' && entry.model ? entry.model : entry.id;
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.map((effort) => effort?.reasoningEffort).filter((effort) => typeof effort === 'string' && effort)
      : [];
    return typeof id === 'string' && id ? { id, efforts } : null;
  }).filter(Boolean);
  return { models, nextCursor: typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null };
}

const errorText = (error) => (isObject(error) && typeof error.message === 'string' ? error.message : JSON.stringify(error));

/**
 * One read of the app server: `{ ok: true, windows, models }` or `{ ok: false, why }`.
 * `spawn` is injectable, so the tests answer with a fake child.
 */
export function collectCodexCapacity({ spawn = spawnChild, bin = 'codex', timeoutMs = CODEX_TIMEOUT_MS, maxBytes = CODEX_MAX_BYTES } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, why: `codex did not start: ${error.message}` });
      return;
    }

    const decoder = new StringDecoder('utf8');
    const pending = new Map();
    const models = [];
    let buffered = '';
    let bytes = 0;
    let nextId = 1;
    let pages = 0;
    let windows = null;
    let rateLimitsRead = false;
    let modelsRead = false;
    let settled = false;

    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve(answer);
    };

    const send = (message) => {
      if (message.method && !SENT_METHODS.includes(message.method)) throw new Error(`${message.method} is not sent by the capacity collector`);
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method, params) => {
      const id = nextId++;
      pending.set(id, method);
      send({ method, id, params });
    };

    const handle = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      // A notification, or an answer to nothing this collector asked, is passed over.
      if (!isObject(message) || message.id === undefined || !pending.has(message.id)) return;
      const method = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) return finish({ ok: false, why: `${method} failed: ${errorText(message.error)}` });

      if (method === 'initialize') {
        send({ method: 'initialized', params: {} });
        request('account/rateLimits/read');
        request('model/list', { includeHidden: false });
        return;
      }
      if (method === 'account/rateLimits/read') {
        rateLimitsRead = true;
        windows = codexRateLimits(message.result);
        if (!windows) return finish({ ok: false, why: 'account/rateLimits/read holds no codex window' });
      }
      if (method === 'model/list') {
        const page = codexModelPage(message.result);
        if (!page) return finish({ ok: false, why: 'model/list did not answer with a list of models' });
        models.push(...page.models);
        pages += 1;
        if (page.nextCursor) {
          if (pages >= MODEL_PAGES) return finish({ ok: false, why: `model/list is longer than ${MODEL_PAGES} pages` });
          request('model/list', { includeHidden: false, cursor: page.nextCursor });
          return;
        }
        modelsRead = true;
      }
      if (rateLimitsRead && modelsRead) finish({ ok: true, windows, models });
    };

    // Counts what the child sends on either stream against the cap; past it the child is stopped.
    const counted = (chunk) => {
      if (settled) return false;
      bytes += Buffer.byteLength(chunk);
      if (bytes <= maxBytes) return true;
      finish({ ok: false, why: `codex app-server sent more than ${maxBytes} bytes` });
      return false;
    };

    const timer = setTimeout(() => finish({ ok: false, why: `codex app-server did not answer within ${timeoutMs} ms` }), timeoutMs);

    child.stdin.on('error', () => { /* a child that closed its stdin ends in `close` */ });
    child.stderr?.on('data', counted);
    child.stdout.on('data', (chunk) => {
      if (!counted(chunk)) return;
      buffered += decoder.write(chunk);
      let at = buffered.indexOf('\n');
      while (at !== -1 && !settled) {
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        if (line) handle(line);
        at = buffered.indexOf('\n');
      }
    });
    child.on('error', (error) => finish({ ok: false, why: `codex did not run: ${error.message}` }));
    child.on('close', (code, signal) => finish({ ok: false, why: `codex app-server ended before it answered (${signal ?? `exit ${code}`})` }));

    pending.set(0, 'initialize');
    send({ method: 'initialize', id: 0, params: { clientInfo: CLIENT_INFO } });
  });
}

/**
 * Collect once and persist the result: a valid read replaces the codex snapshot,
 * a failed one keeps it and records why. Returns `{ ok, why, state }`.
 */
export async function refreshCodexCapacity({ root = runnerDir(), now = new Date(), ...options } = {}) {
  const answer = await collectCodexCapacity(options);
  const state = readCapacity({ root });
  const next = answer.ok
    ? applyObservation(state, 'codex', { windows: answer.windows, models: answer.models }, now)
    : applyFailure(state, 'codex', { why: answer.why }, now);
  const written = writeCapacity(next, { root });
  return { ok: answer.ok, why: answer.why ?? null, state: written };
}
