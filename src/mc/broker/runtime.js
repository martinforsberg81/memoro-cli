import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';

import { resolveLaunch } from '../../adapters/index.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { normalizeInteractivePtyEnv } from '../interactive-env.js';
import { BrokerSessionManager } from './session-manager.js';
import { BrokerSessionSidecars } from './session-sidecars.js';

const SESSION_COMMANDS = new Set([
  'sessions',
  'list_sessions',
  'launch_session',
  'session_status',
  'write_session',
  'dispatch_session',
  'fetch_session_output',
  'resize_session',
  'stop_session',
  'remove_session',
]);

export class BrokerRuntime {
  constructor({
    manager = null,
    ptyFactory = null,
    launchResolver = resolveLaunch,
    env = process.env,
    cwd = process.cwd,
    clock = Date,
    termName = 'xterm-256color',
    sidecarFactory = (opts) => new BrokerSessionSidecars(opts),
  } = {}) {
    if (!manager && !ptyFactory?.spawn) {
      throw new TypeError('manager or ptyFactory.spawn is required');
    }
    if (typeof launchResolver !== 'function') {
      throw new TypeError('launchResolver is required');
    }
    this.manager = manager || new BrokerSessionManager({ ptyFactory, clock });
    this.launchResolver = launchResolver;
    this.env = env;
    this.cwd = cwd;
    this.termName = termName;
    this.sidecarFactory = sidecarFactory;
    this.sidecars = new Map();
    this.sessionMetadata = new Map();
    this.attaches = new Map();
    this.manager.setMaxListeners?.(Math.max(this.manager.getMaxListeners?.() || 10, 100));
    this.manager.on('exit', ({ id }) => this._stopSidecars(id));
  }

  listSessions() {
    return this.manager.list().map((session) => this._withAttachStatus(session));
  }

  handle(message) {
    const type = message?.type;
    if (!SESSION_COMMANDS.has(type)) return null;

    try {
      if (type === 'sessions' || type === 'list_sessions') return { ok: true, sessions: this.listSessions() };
      if (type === 'launch_session') return this._launch(message.session || message);
      if (type === 'session_status') return this._status(message.id);
      if (type === 'write_session') return this._write(message.id, message.data);
      if (type === 'dispatch_session') return this._dispatch(message.id, message.message);
      if (type === 'fetch_session_output') return this._fetchOutput(message.id);
      if (type === 'resize_session') return this._resize(message.id, message.cols, message.rows);
      if (type === 'stop_session') return this._stop(message.id, message.signal);
      if (type === 'remove_session') return this._remove(message.id);
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
    return null;
  }

  attachConnection(message, conn, initialInput = Buffer.alloc(0)) {
    try {
      return this._attachConnection(message, conn, initialInput);
    } catch (err) {
      safeEnd(conn, JSON.stringify({ ok: false, error: err.message || String(err) }) + '\n');
      return { ok: false };
    }
  }

  _launch(input) {
    const id = requiredString(input?.id, 'session id');
    const cwd = stringOrDefault(input.cwd, this._cwd());
    const existing = this._findReusableLiveSession({ id, cwd, name: input.name });
    if (existing) {
      return {
        ok: true,
        reused: true,
        session: this._withAttachStatus(existing),
      };
    }

    const toolInput = stringOrDefault(input.tool, this.env.MC_GROUNDING_TOOL || DEFAULT_TOOL);
    const argv = arrayOfStrings(input.argv, 'argv');
    const launchOptions = plainObject(input.launch_options) ? input.launch_options : {};
    const cols = positiveInteger(input.cols, 80, 'cols');
    const rows = positiveInteger(input.rows, 24, 'rows');
    const launch = this.launchResolver(toolInput);
    if (!launch?.ok) {
      return {
        ok: false,
        reason: launch?.reason || 'launch-resolution-failed',
        error: launch?.hint || `cannot launch tool: ${toolInput}`,
      };
    }

    const interactiveEnv = normalizeInteractivePtyEnv({
      baseEnv: {
        ...this.env,
        ...(plainObject(input.env) ? input.env : {}),
      },
      termName: stringOrDefault(input.term_name, this.termName),
    });

    const sessionMetadata = buildSessionMetadata({
      id,
      name: input.name,
      cwd,
      sidecars: input.sidecars,
    });
    const session = this.manager.launch({
      id,
      name: typeof input.name === 'string' ? input.name : null,
      cwd,
      tool: launch.shortName || launch.id || toolInput,
      launchSpec: launch.spec,
      argv,
      launchOptions,
      cols,
      rows,
      termName: interactiveEnv.termName,
      env: {
        ...interactiveEnv.env,
        MEMORO_MC_BROKER: '1',
        MEMORO_MC_PARENT: '1',
      },
    });
    this.sessionMetadata.set(id, sessionMetadata);

    const sidecars = this._startSidecars(id, input.sidecars);
    return { ok: true, session: this._withAttachStatus(session), ...(sidecars ? { sidecars } : {}) };
  }

  _findReusableLiveSession({ id, cwd, name } = {}) {
    const normalizedCwd = normalizePathForMatch(cwd);
    const wantedName = stringOrNull(name);
    for (const session of this.manager.list()) {
      if (!isReusableLiveSession(session)) continue;
      if (session.id === id) return session;
      if (normalizedCwd && normalizePathForMatch(session.cwd) === normalizedCwd) return session;
      if (
        wantedName
        && stringOrNull(session.name) === wantedName
        && normalizedCwd
        && normalizePathForMatch(session.cwd) === normalizedCwd
      ) {
        return session;
      }
    }
    return null;
  }

  _status(id) {
    const session = this.manager.status(requiredString(id, 'session id'));
    if (!session) return { ok: false, error: `unknown broker session: ${id}` };
    return { ok: true, session: this._withAttachStatus(session) };
  }

  _write(id, data) {
    this.manager.write(requiredString(id, 'session id'), requiredString(data, 'data'));
    return { ok: true };
  }

  _dispatch(id, message) {
    this.manager.dispatch(requiredString(id, 'session id'), requiredString(message, 'message'));
    return { ok: true };
  }

  _fetchOutput(id) {
    const sessionId = requiredString(id, 'session id');
    const session = this.manager.get(sessionId);
    if (!session) return { ok: false, error: `unknown broker session: ${sessionId}` };
    const status = this._withAttachStatus(this.manager.status(sessionId));
    const output = typeof session.recentOutput === 'function' ? session.recentOutput() : '';
    return {
      ok: true,
      session: status,
      output,
    };
  }

  _resize(id, cols, rows) {
    this.manager.resize(
      requiredString(id, 'session id'),
      positiveInteger(cols, null, 'cols'),
      positiveInteger(rows, null, 'rows'),
    );
    return { ok: true };
  }

  _stop(id, signal) {
    this._stopSidecars(id);
    this.manager.stop(requiredString(id, 'session id'), stringOrDefault(signal, 'SIGTERM'));
    return { ok: true };
  }

  _remove(id) {
    const sessionId = requiredString(id, 'session id');
    this._stopSidecars(sessionId);
    const session = this.manager.get(sessionId);
    if (session && !session.status?.().exit) {
      try { this.manager.stop(sessionId, 'SIGTERM'); } catch {}
    }
    this.sessionMetadata.delete(sessionId);
    return { ok: true, removed: this.manager.remove(sessionId) };
  }

  _attachConnection(message, conn, initialInput) {
    const id = requiredString(message?.id || message?.session_id, 'session id');
    const session = this.manager.get(id);
    if (!session) throw new Error(`unknown broker session: ${id}`);
    conn.on?.('error', () => {});

    if (message.cols != null || message.rows != null) {
      this.manager.resize(
        id,
        positiveInteger(message.cols, null, 'cols'),
        positiveInteger(message.rows, null, 'rows'),
      );
    }

    const attachId = stringOrDefault(message.attach_id, makeAttachId());
    const attach = {
      attach_id: attachId,
      session_id: id,
      side: stringOrDefault(message.side, 'local'),
      mode: 'write',
      writer: true,
      connected_at: new Date().toISOString(),
    };
    this.attaches.set(attachId, attach);

    const decoder = new StringDecoder('utf8');
    let closed = false;
    const writeInput = (chunk) => {
      if (closed) return;
      const data = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk || '');
      if (data) session.write(data);
    };
    const onSessionData = (event) => {
      if (!closed && event?.id === id && !safeWrite(conn, event.data)) cleanup();
    };
    const onSessionExit = (event) => {
      if (event?.id !== id) return;
      cleanup();
      safeEnd(conn);
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      const tail = decoder.end();
      if (tail) {
        try { session.write(tail); } catch {}
      }
      this.manager.off('data', onSessionData);
      this.manager.off('exit', onSessionExit);
      this.attaches.delete(attachId);
      conn.off?.('data', writeInput);
      conn.off?.('end', cleanup);
      conn.off?.('close', cleanup);
      conn.off?.('error', cleanup);
    };

    this.manager.on('data', onSessionData);
    this.manager.on('exit', onSessionExit);
    conn.on?.('data', writeInput);
    conn.on?.('end', cleanup);
    conn.on?.('close', cleanup);
    conn.on?.('error', cleanup);

    const wroteAck = safeWrite(conn, JSON.stringify({
      ok: true,
      attach,
      writer: true,
      session: this._withAttachStatus(this.manager.status(id)),
    }) + '\n');
    const snapshot = typeof session.recentOutput === 'function' ? session.recentOutput() : '';
    const wroteSnapshot = !snapshot || safeWrite(conn, snapshot);
    if (!wroteAck || !wroteSnapshot) {
      cleanup();
      return { ok: true };
    }

    if (initialInput?.length) writeInput(initialInput);
    return { ok: true };
  }

  _cwd() {
    return typeof this.cwd === 'function' ? this.cwd() : this.cwd;
  }

  _startSidecars(id, sidecarSpec) {
    if (!plainObject(sidecarSpec) || sidecarSpec.enabled === false) return null;
    const session = this.manager.get(id);
    if (!session) return { ok: false, error: `unknown broker session: ${id}` };
    try {
      const sidecars = this.sidecarFactory({
        session,
        coding: {
          ...sidecarSpec,
          codingSessionId: sidecarSpec.codingSessionId || id,
          tool: sidecarSpec.tool || session.tool || null,
        },
      });
      sidecars.start();
      this.sidecars.set(id, sidecars);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  _stopSidecars(id) {
    const sidecars = this.sidecars.get(id);
    if (!sidecars) return;
    this.sidecars.delete(id);
    try { sidecars.stop(); } catch {}
  }

  _withAttachStatus(session) {
    if (!session) return null;
    const metadata = {
      ...deriveMetadataFromCwd(session.cwd),
      ...(this.sessionMetadata.get(session.id) || {}),
    };
    const attached = [...this.attaches.values()]
      .filter((attach) => attach.session_id === session.id)
      .map((attach) => ({ ...attach }));
    return {
      ...session,
      ...metadata,
      attached,
      writer_attach_id: null,
    };
  }
}

function buildSessionMetadata({ id, name, cwd, sidecars } = {}) {
  const fromCwd = deriveMetadataFromCwd(cwd);
  const plainSidecars = plainObject(sidecars) ? sidecars : {};
  const worktreeName = stringOrNull(
    plainSidecars.worktree_name
      || plainSidecars.worktreeName
      || plainSidecars.sessionName
      || plainSidecars.session_name
      || name,
  );
  return {
    repo: stringOrNull(plainSidecars.repo) || fromCwd.repo,
    repo_ref: stringOrNull(plainSidecars.repo_ref) || stringOrNull(plainSidecars.repoRef),
    branch: stringOrNull(plainSidecars.branch),
    label: stringOrNull(plainSidecars.label),
    worktree_name: worktreeName && worktreeName !== id ? worktreeName : fromCwd.worktree_name,
  };
}

function deriveMetadataFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return {};
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const worktreesIdx = parts.lastIndexOf('worktrees');
  if (worktreesIdx >= 0) {
    return {
      repo: parts[worktreesIdx + 1] || null,
      worktree_name: parts[worktreesIdx + 2] || parts.at(-1) || null,
    };
  }
  return { worktree_name: parts.at(-1) || null };
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function arrayOfStrings(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}

function positiveInteger(value, fallback, label) {
  if (value == null && fallback != null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isReusableLiveSession(session) {
  return !!session?.id
    && session?.attachable !== false
    && session?.session_state !== 'dead'
    && !session?.exit;
}

function normalizePathForMatch(value) {
  const text = stringOrNull(value);
  if (!text) return null;
  let out = text.replace(/[/\\]+$/, '');
  if (process.platform === 'darwin' && out.startsWith('/private/')) {
    out = out.slice('/private'.length);
  }
  return out;
}

function makeAttachId() {
  return `att_${randomBytes(6).toString('base64url')}`;
}

function safeWrite(conn, data) {
  try {
    conn.write(data);
    return true;
  } catch (err) {
    if (isBrokenPipeError(err)) return false;
    throw err;
  }
}

function safeEnd(conn, data = undefined) {
  try {
    if (data === undefined) conn.end();
    else conn.end(data);
    return true;
  } catch (err) {
    if (isBrokenPipeError(err)) return false;
    throw err;
  }
}

function isBrokenPipeError(err) {
  return err?.code === 'EPIPE'
    || err?.code === 'ECONNRESET'
    || err?.code === 'ERR_STREAM_DESTROYED';
}
