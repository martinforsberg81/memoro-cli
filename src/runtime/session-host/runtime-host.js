import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  acceptRuntimeGenerationSync,
  failRuntimeGenerationSync,
  inspectSessionRuntimeSync,
  markRuntimeGenerationLiveSync,
  recordRuntimeGenerationExitSync,
} from '../../mc/session-runtime-journal.js';
import { assertMcSessionId, validateIso } from '../../mc/session-home-schema.js';
import { assertGenerationId } from '../../mc/session-record-ids.js';
import { RuntimeClientQueue } from './client-queue.js';
import {
  SESSION_HOST_PROTOCOL_VERSION,
  validateClientFrame,
} from './protocol.js';
import {
  readRuntimeHostManifestSync,
  writeRuntimeHostManifestSync,
} from './ephemeral-state.js';
import { TerminalScreen, assertTerminalSize } from './terminal-screen.js';

const MAX_CLIENTS = 8;
const MAX_OUTPUT_CHUNK_BYTES = 128 * 1024;

export class SessionRuntimeHost extends EventEmitter {
  constructor({
    mcHomeDir,
    mcSessionId,
    generationId,
    spawnPlan,
    ptyFactory,
    cols = 80,
    rows = 24,
    termName = 'xterm-256color',
    screenFactory = (options) => new TerminalScreen(options),
    queueFactory = (options) => new RuntimeClientQueue(options),
    now = () => new Date().toISOString(),
    random = randomBytes,
    hostPid = process.pid,
    maxClients = MAX_CLIENTS,
    writeManifestSync = writeRuntimeHostManifestSync,
    markGenerationLiveSync = markRuntimeGenerationLiveSync,
  } = {}) {
    super();
    assertMcSessionId(mcSessionId);
    assertGenerationId(generationId);
    assertSpawnPlan(spawnPlan);
    if (!ptyFactory?.spawn) throw new TypeError('ptyFactory.spawn is required');
    assertTerminalSize(cols, rows);
    if (!Number.isSafeInteger(hostPid) || hostPid < 1) throw new TypeError('invalid hostPid');
    if (!Number.isSafeInteger(maxClients) || maxClients < 1 || maxClients > 32) {
      throw new TypeError('invalid maxClients');
    }
    this.mcHomeDir = mcHomeDir;
    this.mcSessionId = mcSessionId;
    this.generationId = generationId;
    this.spawnPlan = spawnPlan;
    this.ptyFactory = ptyFactory;
    this.cols = cols;
    this.rows = rows;
    this.termName = termName;
    this.screen = screenFactory({ cols, rows });
    this.queueFactory = queueFactory;
    this.now = now;
    this.random = random;
    this.hostPid = hostPid;
    this.maxClients = maxClients;
    this.writeManifestSync = writeManifestSync;
    this.markGenerationLiveSync = markGenerationLiveSync;
    this.clients = new Map();
    this.pty = null;
    this.state = 'starting';
    this.startedAt = null;
    this.outputSequence = 0;
    this.exit = null;
    this.fatalReason = null;
    this.finalizing = false;
    this.reconciliationRequired = false;
  }

  start() {
    if (this.pty) return this.status();
    const snapshot = inspectSessionRuntimeSync({
      mcHomeDir: this.mcHomeDir,
      mcSessionId: this.mcSessionId,
    });
    if (snapshot.kind !== 'present') throw runtimeHostError(snapshot.reason || snapshot.kind);
    const generation = snapshot.active_generation;
    if (!generation
      || generation.intent.generation_id !== this.generationId
      || generation.phase !== 'planned') {
      throw runtimeHostError('generation-not-launchable');
    }
    if (generation.intent.launch_cwd !== this.spawnPlan.cwd) {
      throw runtimeHostError('generation-launch-cwd-mismatch');
    }
    const priorManifest = readRuntimeHostManifestSync({
      mcHomeDir: this.mcHomeDir,
      mcSessionId: this.mcSessionId,
    });
    if (priorManifest.kind === 'unknown') {
      throw runtimeHostError(priorManifest.reason || 'runtime-host-evidence-unsafe');
    }
    if (priorManifest.kind === 'present'
      && (priorManifest.value.state === 'starting' || priorManifest.value.state === 'live')) {
      throw runtimeHostError('previous-runtime-not-terminal');
    }
    this.startedAt = validateIso(this.now());
    acceptRuntimeGenerationSync({
      mcHomeDir: this.mcHomeDir,
      mcSessionId: this.mcSessionId,
      generationId: this.generationId,
      now: this.now,
    });
    this.writeManifestSync({
      mcHomeDir: this.mcHomeDir,
      mcSessionId: this.mcSessionId,
      generationId: this.generationId,
      state: 'starting',
      hostPid: this.hostPid,
      cols: this.cols,
      rows: this.rows,
      startedAt: this.startedAt,
      updatedAt: this.now(),
      random: this.random,
    });

    let pty;
    try {
      pty = this.ptyFactory.spawn(
        this.spawnPlan.command,
        [...this.spawnPlan.args],
        {
          name: this.termName,
          cols: this.cols,
          rows: this.rows,
          cwd: this.spawnPlan.cwd,
          env: { ...this.spawnPlan.env },
        },
      );
      assertPty(pty);
    } catch (error) {
      this.state = 'failed';
      this.writeManifestSync({
        mcHomeDir: this.mcHomeDir,
        mcSessionId: this.mcSessionId,
        generationId: this.generationId,
        state: 'failed',
        hostPid: this.hostPid,
        processPid: null,
        cols: this.cols,
        rows: this.rows,
        startedAt: this.startedAt,
        updatedAt: this.now(),
        failureReason: 'pty-spawn-failed',
        random: this.random,
      });
      failRuntimeGenerationSync({
        mcHomeDir: this.mcHomeDir,
        mcSessionId: this.mcSessionId,
        generationId: this.generationId,
        reason: 'pty-spawn-failed',
        now: this.now,
      });
      throw runtimeHostError('pty-spawn-failed', error);
    }
    this.pty = pty;
    pty.onData((data) => this._onOutput(data));
    pty.onExit((event) => this._onExit(event));
    try {
      this.writeManifestSync({
        mcHomeDir: this.mcHomeDir,
        mcSessionId: this.mcSessionId,
        generationId: this.generationId,
        state: 'live',
        hostPid: this.hostPid,
        processPid: pty.pid,
        cols: this.cols,
        rows: this.rows,
        startedAt: this.startedAt,
        updatedAt: this.now(),
        random: this.random,
      });
      this.markGenerationLiveSync({
        mcHomeDir: this.mcHomeDir,
        mcSessionId: this.mcSessionId,
        generationId: this.generationId,
        now: this.now,
      });
      this.state = 'live';
    } catch (error) {
      // The process and exact ephemeral evidence exist. Keep ownership of the
      // process when either durable write is interrupted. The accepted journal
      // phase prevents a duplicate launch, while an exact socket probe can
      // repair a missing live manifest and finish the journal transition.
      this.reconciliationRequired = true;
      this.state = 'starting';
      this.emit('reconciliation-required', error);
    }
    return this.status();
  }

  async attach(socket, { cols = this.cols, rows = this.rows } = {}) {
    if (this.state !== 'live' && !this.reconciliationRequired) {
      throw runtimeHostError('runtime-not-attachable');
    }
    assertTerminalSize(cols, rows);
    if (this.clients.size >= this.maxClients) throw runtimeHostError('runtime-client-limit');
    const clientId = `client_${this.random(8).toString('hex')}`;
    const client = { id: clientId, ready: false, queue: null };
    client.queue = this.queueFactory({
      socket,
      onDisconnect: () => this.clients.delete(clientId),
    });
    this.clients.set(clientId, client);
    client.queue.send(this._frame('attached', {
      client_id: clientId,
      sequence: this.outputSequence,
    }));
    if (cols !== this.cols || rows !== this.rows) await this.resize(cols, rows);
    const snapshot = await this.screen.snapshot();
    client.queue.send(this._screenFrame(snapshot));
    client.ready = true;
    if (this.state === 'exited' && this.exit) {
      client.queue.send(this._frame('exit', {
        exit_code: this.exit.exit_code,
        signal: this.exit.signal,
      }));
    } else if (this.state === 'failed') {
      client.queue.send(this._frame('error', {
        code: this.fatalReason || 'runtime-exit-unclassified',
      }));
    }
    return { client_id: clientId, snapshot };
  }

  async handleClientFrame(clientId, frame) {
    const checked = validateClientFrame(frame);
    if (!checked.ok) throw runtimeHostError(checked.reason);
    if (frame.type === 'attach') throw runtimeHostError('duplicate-attach');
    const client = this.clients.get(clientId);
    if (!client) throw runtimeHostError('runtime-client-missing');
    if (frame.type !== 'status'
      && (frame.mc_session_id !== this.mcSessionId
        || frame.generation_id !== this.generationId)) {
      client.queue.close('runtime-identity-mismatch');
      throw runtimeHostError('runtime-identity-mismatch');
    }
    if (frame.type === 'input') {
      this._assertLivePty();
      this.pty.write(Buffer.from(frame.data_base64, 'base64').toString('utf8'));
    } else if (frame.type === 'resize') {
      await this.resize(frame.cols, frame.rows);
    } else if (frame.type === 'detach') {
      client.queue.close('client-detached');
    } else if (frame.type === 'status') {
      client.queue.send(this.statusFrame());
    }
    return { ok: true };
  }

  async resize(cols, rows) {
    this._assertLivePty();
    assertTerminalSize(cols, rows);
    this.pty.resize(cols, rows);
    const snapshot = await this.screen.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
    this._broadcast(this._frame('resized', {
      sequence: snapshot.through_sequence,
      cols,
      rows,
    }));
    this._broadcast(this._screenFrame(snapshot));
    return snapshot;
  }

  write(data) {
    this._assertLivePty();
    this.pty.write(data);
  }

  stop(signal = 'SIGTERM') {
    this._assertLivePty();
    this.pty.kill(signal);
  }

  status() {
    return {
      mc_session_id: this.mcSessionId,
      generation_id: this.generationId,
      state: this.state,
      process_pid: this.pty?.pid ?? null,
      clients: this.clients.size,
      screen: this.screen.status(),
      reconciliation_required: this.reconciliationRequired,
      exit: this.exit,
    };
  }

  statusFrame() {
    const status = this.status();
    return this._frame('status', {
      state: status.state,
      process_pid: status.process_pid,
      clients: status.clients,
      screen: status.screen,
    });
  }

  close() {
    for (const client of this.clients.values()) client.queue.close('runtime-host-closed');
    this.clients.clear();
    this.screen.dispose();
  }

  _onOutput(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    for (let offset = 0; offset < buffer.length; offset += MAX_OUTPUT_CHUNK_BYTES) {
      const chunk = buffer.subarray(offset, offset + MAX_OUTPUT_CHUNK_BYTES);
      const sequence = ++this.outputSequence;
      const accepted = this.screen.append(chunk, sequence);
      if (!accepted.ok) {
        this._scheduleFatal('terminal-parser-overflow');
        return;
      }
      this._broadcast(this._frame('output', {
        sequence,
        data_base64: chunk.toString('base64'),
      }));
    }
  }

  _onExit(event) {
    if (this.finalizing) return;
    this.finalizing = true;
    queueMicrotask(() => {
      try { this._finalizeExit(event); } catch (error) { this.emit('fault', error); }
    });
  }

  _finalizeExit(event) {
    const exitCode = Number.isSafeInteger(event?.exitCode) && event.exitCode >= 0
      ? event.exitCode
      : null;
    const signal = typeof event?.signal === 'string' && /^[A-Z][A-Z0-9]{0,31}$/u.test(event.signal)
      ? event.signal
      : null;
    const recordedAt = validateIso(this.now());
    if (this.fatalReason || (exitCode === null && signal === null)) {
      const reason = this.fatalReason || 'runtime-exit-unclassified';
      this.state = 'failed';
      this.writeManifestSync({
        mcHomeDir: this.mcHomeDir,
        mcSessionId: this.mcSessionId,
        generationId: this.generationId,
        state: 'failed',
        hostPid: this.hostPid,
        processPid: this.pty.pid,
        cols: this.cols,
        rows: this.rows,
        startedAt: this.startedAt,
        updatedAt: recordedAt,
        failureReason: reason,
        random: this.random,
      });
      failRuntimeGenerationSync({
        mcHomeDir: this.mcHomeDir,
        mcSessionId: this.mcSessionId,
        generationId: this.generationId,
        reason,
        now: () => recordedAt,
      });
      this._broadcast(this._frame('error', { code: reason }));
    } else {
      this.exit = { exit_code: exitCode, signal, recorded_at: recordedAt };
      this.state = 'exited';
      this.writeManifestSync({
        mcHomeDir: this.mcHomeDir,
        mcSessionId: this.mcSessionId,
        generationId: this.generationId,
        state: 'exited',
        hostPid: this.hostPid,
        processPid: this.pty.pid,
        cols: this.cols,
        rows: this.rows,
        startedAt: this.startedAt,
        updatedAt: recordedAt,
        exit: this.exit,
        random: this.random,
      });
      recordRuntimeGenerationExitSync({
        mcHomeDir: this.mcHomeDir,
        mcSessionId: this.mcSessionId,
        generationId: this.generationId,
        exitCode,
        signal,
        now: () => recordedAt,
      });
      this._broadcast(this._frame('exit', { exit_code: exitCode, signal }));
    }
    this.emit('exit', this.status());
  }

  _scheduleFatal(reason) {
    if (this.fatalReason) return;
    this.fatalReason = reason;
    queueMicrotask(() => {
      try { this.pty?.kill('SIGTERM'); } catch {}
    });
  }

  _screenFrame(snapshot) {
    return this._frame('screen', {
      sequence: snapshot.through_sequence,
      cols: snapshot.cols,
      rows: snapshot.rows,
      ansi_base64: Buffer.from(snapshot.ansi, 'utf8').toString('base64'),
      scrollback_truncated: snapshot.scrollback_truncated,
    });
  }

  _frame(type, fields) {
    return {
      v: SESSION_HOST_PROTOCOL_VERSION,
      type,
      mc_session_id: this.mcSessionId,
      generation_id: this.generationId,
      ...fields,
    };
  }

  _broadcast(frame) {
    for (const client of this.clients.values()) {
      if (client.ready) client.queue.send(frame);
    }
  }

  _assertLivePty() {
    if (!this.pty || (this.state !== 'live' && !this.reconciliationRequired)) {
      throw runtimeHostError('runtime-not-live');
    }
  }
}

export function reconcileRuntimeHostSync({
  mcHomeDir,
  mcSessionId,
  probe = null,
  processIsAlive = defaultProcessIsAlive,
  now = () => new Date().toISOString(),
} = {}) {
  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  if (snapshot.kind !== 'present') return { action: 'manual-repair', reason: snapshot.reason };
  const generation = snapshot.active_generation;
  if (!generation) return { action: 'inactive' };
  const manifestRead = readRuntimeHostManifestSync({ mcHomeDir, mcSessionId });
  const manifest = manifestRead.kind === 'present' ? manifestRead.value : null;
  if (generation.phase === 'planned') {
    if (manifest && (manifest.state === 'starting' || manifest.state === 'live')) {
      if (manifest.process_pid !== null && !processIsAlive(manifest.process_pid)) {
        return { action: 'launch-planned-generation', generation_id: generation.intent.generation_id };
      }
      return {
        action: 'manual-repair',
        reason: 'previous-runtime-not-terminal',
        generation_id: generation.intent.generation_id,
      };
    }
    return { action: 'launch-planned-generation', generation_id: generation.intent.generation_id };
  }
  if (!manifest || manifest.generation_id !== generation.intent.generation_id) {
    return {
      action: generation.phase === 'accepted'
        ? 'reconcile-accepted-outcome'
        : 'manual-repair',
      reason: manifestRead.reason || 'runtime-host-evidence-missing',
      generation_id: generation.intent.generation_id,
    };
  }
  if (manifest.state === 'exited') {
    recordRuntimeGenerationExitSync({
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      exitCode: manifest.exit.exit_code,
      signal: manifest.exit.signal,
      now: () => manifest.exit.recorded_at,
    });
    return { action: 'finalize-exit', generation_id: generation.intent.generation_id };
  }
  if (manifest.state === 'failed') {
    failRuntimeGenerationSync({
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      reason: manifest.failure_reason,
      now,
    });
    return { action: 'explicit-replacement-required', generation_id: generation.intent.generation_id };
  }
  if (manifest.process_pid !== null && !processIsAlive(manifest.process_pid)) {
    failRuntimeGenerationSync({
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      reason: 'runtime-process-absent',
      now,
    });
    return { action: 'explicit-replacement-required', generation_id: generation.intent.generation_id };
  }
  const exactProbe = probe?.ok === true
    && probe.mc_session_id === mcSessionId
    && probe.generation_id === generation.intent.generation_id
    && Number.isSafeInteger(probe.process_pid)
    && probe.process_pid > 0
    && probe.state === 'live';
  if (generation.phase === 'accepted'
    && manifest.state === 'starting'
    && manifest.process_pid === null
    && exactProbe) {
    writeRuntimeHostManifestSync({
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      state: 'live',
      hostPid: manifest.host_pid,
      processPid: probe.process_pid,
      cols: manifest.cols,
      rows: manifest.rows,
      startedAt: manifest.started_at,
      updatedAt: now(),
    });
    markRuntimeGenerationLiveSync({
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      now,
    });
    return { action: 'attach', generation_id: generation.intent.generation_id };
  }
  const exactLive = exactProbe && probe.process_pid === manifest.process_pid;
  if (!exactLive) {
    return {
      action: generation.phase === 'accepted'
        ? 'reconcile-accepted-outcome'
        : 'manual-repair',
      reason: 'runtime-host-live-unproven',
      generation_id: generation.intent.generation_id,
    };
  }
  if (generation.phase === 'accepted') {
    markRuntimeGenerationLiveSync({
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      now,
    });
  }
  return { action: 'attach', generation_id: generation.intent.generation_id };
}

export function runtimeHostError(reason, cause = null) {
  const error = new Error(`mc runtime host error (${reason})`, cause ? { cause } : undefined);
  error.code = 'MC_RUNTIME_HOST_ERROR';
  error.reason = reason;
  return error;
}

function assertSpawnPlan(value) {
  if (!value || typeof value !== 'object'
    || typeof value.command !== 'string'
    || value.command.length < 1
    || value.command.includes('\u0000')
    || !Array.isArray(value.args)
    || !value.args.every((item) => typeof item === 'string' && !item.includes('\u0000'))
    || typeof value.cwd !== 'string'
    || value.cwd.length < 1
    || !value.env
    || typeof value.env !== 'object'
    || Array.isArray(value.env)) throw new TypeError('invalid spawnPlan');
}

function assertPty(value) {
  if (!value
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.onData !== 'function'
    || typeof value.onExit !== 'function'
    || typeof value.write !== 'function'
    || typeof value.resize !== 'function'
    || typeof value.kill !== 'function') throw new TypeError('invalid PTY process');
}

function defaultProcessIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
