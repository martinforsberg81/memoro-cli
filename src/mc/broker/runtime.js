import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';

import { resolveLaunch } from '../../adapters/index.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { normalizeInteractivePtyEnv } from '../interactive-env.js';
import { mcHome } from '../paths.js';
import { BrokerSessionManager } from './session-manager.js';
import { BrokerSessionSidecars } from './session-sidecars.js';
import { resolveManagedCodexLaunch } from '../provider-adapters/codex-managed.js';
import { closeLocalCodexCredentialDomain } from '../credential-domain/local-codex.js';
import { sessionHostPaths } from './paths.js';
import { writeSessionLifecycleSync } from './lifecycle-journal.js';
import { providerArtifactPath } from './paths.js';
import { writeProviderArtifactSync } from './provider-artifact-journal.js';
import {
  validateClaudeProviderArtifact,
  validateCodexProviderArtifact,
} from './provider-artifacts.js';

// Keep this below the generic runtime-finalization bound so a hung advisory
// network call cannot race the mandatory local cleanup timeout.
const TERMINAL_PRESENCE_TIMEOUT_MS = 10_000;

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
  'capture_provider_artifact',
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
    managedProviderResolver = resolveManagedCodexLaunch,
    credentialDomainCloser = closeLocalCodexCredentialDomain,
    lifecycleWriter = writeSessionLifecycleSync,
    providerArtifactWriter = writeProviderArtifactSync,
    validateClaudeArtifact = validateClaudeProviderArtifact,
    validateCodexArtifact = validateCodexProviderArtifact,
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
    this.managedProviderResolver = managedProviderResolver;
    this.credentialDomainCloser = credentialDomainCloser;
    this.lifecycleWriter = lifecycleWriter;
    this.providerArtifactWriter = providerArtifactWriter;
    this.validateClaudeArtifact = validateClaudeArtifact;
    this.validateCodexArtifact = validateCodexArtifact;
    this.sidecars = new Map();
    this.sidecarsBySession = new WeakMap();
    this.sidecarStartFinalizationsBySession = new WeakMap();
    this.sessionMetadata = new Map();
    this.sessionMetadataBySession = new WeakMap();
    this.exitWaitersBySession = new WeakMap();
    this.exitFinalizationsBySession = new WeakMap();
    this.credentialDomains = new Map();
    this.credentialDomainClosures = new Map();
    this.credentialDomainsBySession = new WeakMap();
    this.credentialDomainClosuresBySession = new WeakMap();
    this.attaches = new Map();
    this.manager.setMaxListeners?.(Math.max(this.manager.getMaxListeners?.() || 10, 100));
    this.manager.on('exit', ({ id, event, session }) => {
      const journaled = this._recordRuntimeExit(id, event, session);
      const sidecars = this._stopSidecars(id, { terminal: true }, session);
      const sidecarStartFinalization = session
        ? this.sidecarStartFinalizationsBySession.get(session)
        : null;
      const closing = this._closeCredentialDomain(id, session);
      const finalization = Promise.all([
        // Presence is an eventually-consistent projection. It is intentionally
        // awaited (and bounded), but local exit proof must not depend on a
        // working network connection.
        settleAdvisory(
          Promise.all([Promise.resolve(sidecars), Promise.resolve(sidecarStartFinalization)]),
          TERMINAL_PRESENCE_TIMEOUT_MS,
        ),
        Promise.resolve(closing),
      ]).then(([, credentialResult]) => ({
        ok: journaled
          && (!credentialResult || credentialResult.ok !== false),
        reason: !journaled
          ? 'runtime-exit-journal-unconfirmed'
          : credentialResult?.ok === false
            ? credentialResult.reason || 'managed-domain-cleanup-unconfirmed'
            : null,
      })).catch(() => ({ ok: false, reason: 'runtime-finalization-unconfirmed' }));
      if (session) {
        this.exitFinalizationsBySession.set(session, finalization);
        this._resolveSessionExit(session, finalization);
      }
    });
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
      if (type === 'resize_session') return this._resize(message.id, message.cols, message.rows, message);
      if (type === 'stop_session') return this._stop(message.id, message.signal);
      if (type === 'remove_session') return this._remove(message.id);
      if (type === 'capture_provider_artifact') return this._captureProviderArtifact(message);
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
    const runtimeGeneration = stringOrNull(input?.runtime_generation);
    const cwd = stringOrDefault(input.cwd, this._cwd());
    const existing = this._findReusableLiveSession({ id, cwd, name: input.name });
    if (existing) {
      const existingGeneration = stringOrNull(
        this.sessionMetadata.get(existing.id)?.runtime_generation,
      );
      if (runtimeGeneration && runtimeGeneration !== existingGeneration) {
        return {
          ok: false,
          reason: 'runtime-generation-conflict',
          error: 'broker session already exists under a different runtime generation',
        };
      }
      if (input?.credential_domain) {
        return {
          ok: false,
          reason: 'managed-provider-session-conflict',
          error: 'managed provider cannot reuse an existing broker session',
        };
      }
      return {
        ok: true,
        reused: true,
        session: this._withAttachStatus(existing),
      };
    }
    if (input?.credential_domain) {
      const pendingCleanup = this.credentialDomainClosures.get(id);
      if (pendingCleanup) {
        return Promise.resolve(pendingCleanup).then((cleanup) => {
          if (!cleanup?.ok) {
            return {
              ok: false,
              reason: cleanup?.reason || 'managed-domain-cleanup-unconfirmed',
              error: 'managed credential cleanup was not confirmed',
            };
          }
          return this._launch(input);
        });
      }
      if (this.credentialDomains.has(id)) {
        return {
          ok: false,
          reason: 'managed-domain-cleanup-unconfirmed',
          error: 'managed credential cleanup was not confirmed',
        };
      }
    }
    const priorStatus = this.manager.status(id);
    if (priorStatus?.exit) {
      this.manager.remove(id);
      this.sessionMetadata.delete(id);
    }

    const toolInput = stringOrDefault(input.tool, this.env.MC_GROUNDING_TOOL || DEFAULT_TOOL);
    const argv = arrayOfStrings(input.argv, 'argv');
    const launchOptions = plainObject(input.launch_options) ? input.launch_options : {};
    const cols = positiveInteger(input.cols, 80, 'cols');
    const rows = positiveInteger(input.rows, 24, 'rows');
    const resolved = this.launchResolver(toolInput);
    if (!resolved?.ok) {
      return {
        ok: false,
        reason: resolved?.reason || 'launch-resolution-failed',
        error: resolved?.hint || `cannot launch tool: ${toolInput}`,
      };
    }
    const provider = this.managedProviderResolver({
      launch: resolved,
      input,
    });
    if (!provider?.ok) {
      return {
        ok: false,
        reason: provider?.reason || 'managed-provider-unavailable',
        error: provider?.error || 'managed provider unavailable',
      };
    }
    const launch = provider.launch;

    const interactiveEnv = normalizeInteractivePtyEnv({
      baseEnv: provider.environmentMode === 'replace'
        ? provider.env
        : {
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
      runtimeGeneration,
      providerSessionsDir: codexSessionsDirForLaunch({
        launch,
        provider,
        input,
      }),
    });
    const credentialDomain = provider.descriptor ? {
      descriptor: provider.descriptor,
      portal: {
        apiUrl: stringOrDefault(input.sidecars?.apiUrl, null),
        token: stringOrDefault(input.sidecars?.token, null),
      },
    } : null;
    // This has to happen before `manager.launch()`: a provider may report an
    // exit synchronously from spawn, in which case the exit handler still
    // needs the exact generation and its finalization waiter.
    this.sessionMetadata.set(id, sessionMetadata);
    let session;
    try {
      if (runtimeGeneration) {
        this.lifecycleWriter({
          path: sessionHostPaths(id).lifecyclePath,
          codingSessionId: id,
          runtimeGeneration,
          state: 'live',
          observedAt: runtimeObservedAt(this.clock),
        });
      }
      session = this.manager.launch({
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
          MC_CODING_SESSION_ID: id,
          ...(runtimeGeneration ? { MC_RUNTIME_GENERATION: runtimeGeneration } : {}),
          MC_PROVIDER_ARTIFACT_SOCKET: sessionHostPaths(id).socketPath,
        },
      }, {
        beforeStart: (ownedSession) => {
          this.sessionMetadataBySession.set(ownedSession, sessionMetadata);
          this._prepareSessionExit(ownedSession);
          if (credentialDomain) {
            this.credentialDomains.set(id, credentialDomain);
            this.credentialDomainsBySession.set(ownedSession, credentialDomain);
          }
        },
      });
    } catch (error) {
      if (runtimeGeneration) {
        try {
          this.lifecycleWriter({
            path: sessionHostPaths(id).lifecyclePath,
            codingSessionId: id,
            runtimeGeneration,
            state: 'launch_failed',
            observedAt: runtimeObservedAt(this.clock),
          });
        } catch {}
      }
      this.sessionMetadata.delete(id);
      if (credentialDomain && this.credentialDomains.get(id) === credentialDomain) {
        this.credentialDomains.delete(id);
      }
      throw error;
    }
    const ownedSession = this.manager.get(id);
    if (!ownedSession || ownedSession.exit) {
      return {
        ok: false,
        reason: 'broker-session-exited',
        error: 'broker session exited before it could become live',
      };
    }

    const sidecars = this._startSidecars(id, input.sidecars);
    if (sidecars?.ok === false) {
      try { this.manager.stop(id, 'SIGTERM'); } catch {}
      return Promise.all([
        this._waitForRuntimeFinalization(id),
        Promise.resolve(sidecars.finalization),
      ]).then(([finalization]) => ({
        ok: false,
        reason: finalization?.ok === false
          ? finalization.reason || 'runtime-finalization-unconfirmed'
          : 'sidecar-start-failed',
        error: sidecars.error || 'broker sidecar failed to start',
      }));
    }
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
    if (!session) {
      return {
        ok: false,
        reason: 'session-not-found',
        error: `unknown broker session: ${id}`,
      };
    }
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

  _resize(id, cols, rows, context = {}) {
    const sessionId = requiredString(id, 'session id');
    const nextCols = positiveInteger(cols, null, 'cols');
    const nextRows = positiveInteger(rows, null, 'rows');
    const applied = this._shouldApplyResize({
      sessionId,
      side: context?.side,
    });
    if (applied) this.manager.resize(sessionId, nextCols, nextRows);
    return { ok: true, applied };
  }

  _stop(id, signal) {
    this.manager.stop(requiredString(id, 'session id'), stringOrDefault(signal, 'SIGTERM'));
    return { ok: true };
  }

  _remove(id) {
    const sessionId = requiredString(id, 'session id');
    const status = this.manager.status(sessionId);
    const managed = this.credentialDomains.has(sessionId)
      || this.credentialDomainClosures.has(sessionId);
    if (status && !status.exit) {
      try { this.manager.stop(sessionId, 'SIGTERM'); } catch {}
    }
    return this._waitForRuntimeFinalization(sessionId).then((finalization) => {
      if (!finalization.ok) {
        return {
          ok: false,
          removed: false,
          reason: finalization.reason || 'runtime-finalization-unconfirmed',
          error: 'broker session finalization was not confirmed',
        };
      }
      this.sessionMetadata.delete(sessionId);
      this.credentialDomainClosures.delete(sessionId);
      return {
        ok: true,
        removed: this.manager.remove(sessionId),
        ...(managed ? { credential_cleanup: 'confirmed' } : {}),
      };
    });
  }

  _captureProviderArtifact(input = {}) {
    const id = requiredString(input.id || input.coding_session_id, 'session id');
    const session = this.manager.get(id);
    const status = session ? this.manager.status(id) : null;
    if (!session || status?.exit) return { ok: false, reason: 'provider-artifact-session-not-live' };
    const metadata = this.sessionMetadata.get(id) || {};
    const runtimeGeneration = stringOrNull(metadata.runtime_generation);
    if (!runtimeGeneration) return { ok: false, reason: 'provider-artifact-generation-missing' };
    if (input.runtime_generation !== runtimeGeneration) {
      return { ok: false, reason: 'provider-artifact-generation-mismatch' };
    }
    const expectedSessionTool = input.tool === 'claude-code'
      ? 'claude'
      : input.tool === 'codex'
        ? 'codex'
        : null;
    if (!expectedSessionTool || session.tool !== expectedSessionTool) {
      return { ok: false, reason: 'provider-artifact-tool-mismatch' };
    }
    const artifactInput = {
      cwd: input.cwd,
      providerSessionId: input.provider_session_id,
      transcriptPath: input.transcript_path,
    };
    const checked = input.tool === 'claude-code'
      ? this.validateClaudeArtifact(artifactInput)
      : this.validateCodexArtifact(
          artifactInput,
          metadata.provider_sessions_dir
            ? { sessionsDir: metadata.provider_sessions_dir }
            : undefined,
        );
    if (!checked?.ok || !sameWorkspace(checked.workspace, session.cwd)) {
      return { ok: false, reason: checked?.reason || 'provider-artifact-workspace-mismatch' };
    }
    const artifact = {
      schema: 'mc-provider-artifact-v1',
      coding_session_id: id,
      runtime_generation: runtimeGeneration,
      tool: input.tool,
      provider_session_id: input.provider_session_id,
      transcript_path: checked.transcriptPath,
      captured_at: new Date(runtimeObservedAt(this.clock)).toISOString(),
    };
    return this._commitProviderArtifact({ id, metadata, artifact });
  }

  _commitProviderArtifact({ id, metadata, artifact }) {
    try {
      const written = this.providerArtifactWriter({
        path: providerArtifactPath(id, artifact.runtime_generation),
        artifact,
        trustedRoot: mcHome(),
      });
      metadata.provider_artifact = written.artifact;
      this.sessionMetadata.set(id, metadata);
      return {
        ok: true,
        duplicate: written.duplicate === true,
        artifact: publicProviderArtifact(written.artifact),
      };
    } catch {
      return { ok: false, reason: 'provider-artifact-write-failed' };
    }
  }

  _attachConnection(message, conn, initialInput) {
    const id = requiredString(message?.id || message?.session_id, 'session id');
    const session = this.manager.get(id);
    if (!session) throw new Error(`unknown broker session: ${id}`);
    conn.on?.('error', () => {});

    const attachId = stringOrDefault(message.attach_id, makeAttachId());
    const attachSide = stringOrDefault(message.side, 'local');
    if (
      (message.cols != null || message.rows != null)
      && this._shouldApplyResize({ sessionId: id, side: attachSide })
    ) {
      this.manager.resize(
        id,
        positiveInteger(message.cols, null, 'cols'),
        positiveInteger(message.rows, null, 'rows'),
      );
    }

    const attach = {
      attach_id: attachId,
      session_id: id,
      side: attachSide,
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
    let sidecars = null;
    try {
      sidecars = this.sidecarFactory({
        session,
        coding: {
          ...sidecarSpec,
          codingSessionId: sidecarSpec.codingSessionId || id,
          tool: sidecarSpec.tool || session.tool || null,
        },
      });
      sidecars.start();
      this.sidecars.set(id, sidecars);
      this.sidecarsBySession.set(session, sidecars);
      return { ok: true };
    } catch (err) {
      let finalization = Promise.resolve(true);
      try {
        // A partially started sidecar may already have registered a socket or
        // presence.  Finalize it before reporting a failed launch.
        finalization = Promise.resolve(sidecars?.stop?.({ terminal: true }));
      } catch {
        finalization = Promise.resolve(false);
      }
      this.sidecarStartFinalizationsBySession.set(session, finalization);
      return { ok: false, error: err.message || String(err), finalization };
    }
  }

  _stopSidecars(id, options = {}, expectedSession = null) {
    const sidecars = expectedSession
      ? this.sidecarsBySession.get(expectedSession)
      : this.sidecars.get(id);
    if (!sidecars) return true;
    if (this.sidecars.get(id) === sidecars) this.sidecars.delete(id);
    try {
      return Promise.resolve(sidecars.stop(options)).then(
        (result) => result !== false,
        () => false,
      );
    } catch {
      return false;
    }
  }

  _recordRuntimeExit(id, event = {}, expectedSession = null) {
    const metadata = (
      expectedSession ? this.sessionMetadataBySession.get(expectedSession) : null
    ) || this.sessionMetadata.get(id) || {};
    const runtimeGeneration = stringOrNull(metadata.runtime_generation);
    const removedSession = !!expectedSession && this.manager.get(id) !== expectedSession;
    if (!runtimeGeneration) {
      if (removedSession && this.sessionMetadata.get(id) === metadata) {
        this.sessionMetadata.delete(id);
      }
      return true;
    }
    const currentMetadata = this.sessionMetadata.get(id);
    const currentGeneration = stringOrNull(currentMetadata?.runtime_generation);
    if (currentGeneration && currentGeneration !== runtimeGeneration) return true;
    const exitCode = Number.isInteger(event?.exitCode)
      && event.exitCode >= 0
      && event.exitCode <= 255
      ? event.exitCode
      : undefined;
    const signal = exitCode === undefined && typeof event?.signal === 'string'
      ? event.signal
      : undefined;
    try {
      this.lifecycleWriter({
        path: sessionHostPaths(id).lifecyclePath,
        codingSessionId: id,
        runtimeGeneration,
        state: 'exited',
        observedAt: runtimeObservedAt(this.clock),
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(signal ? { signal } : {}),
      });
      if (removedSession && this.sessionMetadata.get(id) === metadata) {
        this.sessionMetadata.delete(id);
      }
      return true;
    } catch {
      if (removedSession && this.sessionMetadata.get(id) === metadata) {
        this.sessionMetadata.delete(id);
      }
      return false;
    }
  }

  _closeCredentialDomain(id, expectedSession = null) {
    const owned = expectedSession
      ? this.credentialDomainsBySession.get(expectedSession)
      : this.credentialDomains.get(id);
    if (!owned) return null;
    const existing = expectedSession
      ? this.credentialDomainClosuresBySession.get(expectedSession)
      : this.credentialDomainClosures.get(id);
    if (existing) return existing;
    const closing = Promise.resolve(this.credentialDomainCloser({
      descriptor: owned.descriptor,
      portal: owned.portal,
    }))
      .then((result) => {
        if (result?.ok) {
          if (expectedSession) this.credentialDomainsBySession.delete(expectedSession);
          if (this.credentialDomains.get(id) === owned) this.credentialDomains.delete(id);
          if (expectedSession && this.credentialDomainClosuresBySession.get(expectedSession) === closing) {
            this.credentialDomainClosuresBySession.delete(expectedSession);
          }
          if (this.credentialDomainClosures.get(id) === closing) {
            this.credentialDomainClosures.delete(id);
          }
        }
        return result?.ok
          ? result
          : {
              ok: false,
              reason: result?.reason || 'managed-domain-cleanup-unconfirmed',
            };
      })
      .catch(() => ({
        ok: false,
        reason: 'managed-domain-cleanup-unconfirmed',
      }));
    if (expectedSession) this.credentialDomainClosuresBySession.set(expectedSession, closing);
    if (this.credentialDomains.get(id) === owned) this.credentialDomainClosures.set(id, closing);
    return closing;
  }

  async shutdown({ timeoutMs = 15_000 } = {}) {
    const ids = this.manager.list().map((session) => session.id);
    for (const id of ids) {
      const status = this.manager.status(id);
      if (status && !status.exit) {
        try { this.manager.stop(id, 'SIGTERM'); } catch {}
      }
    }
    const results = await Promise.all(ids.map((id) => this._waitForRuntimeFinalization(id, timeoutMs)));
    const failed = results.find((result) => !result?.ok);
    return failed
      ? { ok: false, reason: failed.reason || 'runtime-finalization-unconfirmed' }
      : { ok: true, credential_cleanup: 'confirmed' };
  }

  _prepareSessionExit(session) {
    if (this.exitWaitersBySession.has(session)) return;
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    this.exitWaitersBySession.set(session, { exited, resolveExit });
  }

  _resolveSessionExit(session, finalization) {
    const waiter = this.exitWaitersBySession.get(session);
    waiter?.resolveExit(finalization);
  }

  async _waitForRuntimeFinalization(id, timeoutMs = 15_000) {
    const session = this.manager.get(id);
    if (!session) return { ok: true };
    const status = this.manager.status(id);
    let finalization = this.exitFinalizationsBySession.get(session);
    if (!finalization && !status?.exit) {
      const waiter = this.exitWaitersBySession.get(session);
      finalization = waiter?.exited;
    }
    if (!finalization) {
      return { ok: false, reason: 'runtime-exit-unconfirmed' };
    }
    return waitBounded(finalization, timeoutMs, 'runtime-finalization-timeout');
  }

  _withAttachStatus(session) {
    if (!session) return null;
    const privateMetadata = {
      ...deriveMetadataFromCwd(session.cwd),
      ...(this.sessionMetadata.get(session.id) || {}),
    };
    const metadata = publicSessionMetadata(privateMetadata);
    const attached = [...this.attaches.values()]
      .filter((attach) => attach.session_id === session.id)
      .map((attach) => ({ ...attach }));
    const sessionProjection = this.sidecars.get(session.id)?.currentProjection?.() || null;
    return {
      ...session,
      ...metadata,
      attached,
      writer_attach_id: null,
      ...(sessionProjection ? { session_projection: sessionProjection } : {}),
      ...(privateMetadata.provider_artifact
        ? { provider_artifact: publicProviderArtifact(privateMetadata.provider_artifact) }
        : {}),
    };
  }

  _shouldApplyResize({ sessionId, side } = {}) {
    if (!isRemoteAttachSide(side)) return true;
    return !this._hasLocalAttach(sessionId);
  }

  _hasLocalAttach(sessionId) {
    for (const attach of this.attaches.values()) {
      if (attach.session_id === sessionId && !isRemoteAttachSide(attach.side)) return true;
    }
    return false;
  }
}

function buildSessionMetadata({
  id,
  name,
  cwd,
  sidecars,
  runtimeGeneration = null,
  providerSessionsDir = null,
} = {}) {
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
    runtime_generation: stringOrNull(runtimeGeneration)
      || stringOrNull(plainSidecars.runtimeGeneration)
      || stringOrNull(plainSidecars.runtime_generation),
    source_id: stringOrNull(plainSidecars.sourceId)
      || stringOrNull(plainSidecars.source_id),
    source_kind: stringOrNull(plainSidecars.sourceKind)
      || stringOrNull(plainSidecars.source_kind),
    transcript_path: stringOrNull(
      plainSidecars.transcript_path
        || plainSidecars.transcriptPath
        || plainSidecars.tool_transcript_path
        || plainSidecars.toolTranscriptPath,
    ),
    provider_artifact: null,
    provider_sessions_dir: stringOrNull(providerSessionsDir),
    worktree_name: worktreeName && worktreeName !== id ? worktreeName : fromCwd.worktree_name,
  };
}

function publicProviderArtifact(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    coding_session_id: value.coding_session_id,
    runtime_generation: value.runtime_generation,
    tool: value.tool,
    captured_at: value.captured_at,
  };
}

function publicSessionMetadata(value = {}) {
  return {
    repo: stringOrNull(value.repo),
    repo_ref: stringOrNull(value.repo_ref),
    branch: stringOrNull(value.branch),
    label: stringOrNull(value.label),
    runtime_generation: stringOrNull(value.runtime_generation),
    source_id: stringOrNull(value.source_id),
    source_kind: stringOrNull(value.source_kind),
    worktree_name: stringOrNull(value.worktree_name),
  };
}

function codexSessionsDirForLaunch({ launch, provider, input } = {}) {
  if (launch?.id !== 'codex') return null;
  const codexHome = stringOrNull(provider?.env?.CODEX_HOME)
    || stringOrNull(input?.env?.CODEX_HOME)
    || stringOrNull(process.env.CODEX_HOME);
  return codexHome ? `${codexHome.replace(/\/+$/, '')}/sessions` : null;
}

function sameWorkspace(left, right) {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
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

function isRemoteAttachSide(side) {
  return side === 'cloud' || side === 'browser' || side === 'remote';
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

function runtimeObservedAt(clock) {
  const value = typeof clock === 'function'
    ? clock()
    : (typeof clock?.now === 'function' ? clock.now() : Date.now());
  return new Date(value).toISOString();
}

async function waitBounded(promise, timeoutMs, timeoutReason) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 15_000;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: timeoutReason }), timeout);
        timer.unref?.();
      }),
    ]);
  } catch {
    return { ok: false, reason: 'runtime-finalization-unconfirmed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleAdvisory(promise, timeoutMs) {
  await waitBounded(promise, timeoutMs, 'terminal-presence-timeout');
  return true;
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
