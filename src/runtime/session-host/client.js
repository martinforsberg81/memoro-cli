import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';

import { sessionHomePaths } from '../../mc/session-home-paths.js';
import {
  SESSION_HOST_PROTOCOL_VERSION,
  SessionHostFrameDecoder,
  encodeSessionHostFrame,
} from './protocol.js';
import { runtimeHostError } from './runtime-host.js';

export class SessionRuntimeClient extends EventEmitter {
  constructor({
    mcHomeDir,
    mcSessionId,
    generationId,
    cols = 80,
    rows = 24,
    output = process.stdout,
    connector = (path) => createConnection(path),
  } = {}) {
    super();
    this.paths = sessionHomePaths({ mcHomeDir, mcSessionId });
    this.mcSessionId = mcSessionId;
    this.generationId = generationId;
    this.cols = cols;
    this.rows = rows;
    this.output = output;
    this.connector = connector;
    this.socket = null;
    this.decoder = new SessionHostFrameDecoder({ direction: 'server' });
    this.lastSequence = 0;
    this.attached = false;
    this.screenReceived = false;
    this.exitFrame = null;
    this.closed = false;
  }

  connect() {
    if (this.socket) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const socket = this.connector(this.paths.runtimeHostSocketPath);
      this.socket = socket;
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          try { socket.destroy(); } catch {}
          reject(error);
        }
        if (this.listenerCount('error') > 0) this.emit('error', error);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        this._send({
          v: SESSION_HOST_PROTOCOL_VERSION,
          type: 'attach',
          mc_session_id: this.mcSessionId,
          generation_id: this.generationId,
          cols: this.cols,
          rows: this.rows,
        });
      });
      socket.on('data', (chunk) => {
        let frames;
        try { frames = this.decoder.push(chunk); } catch (error) { fail(error); return; }
        for (const frame of frames) {
          try { this._handleServerFrame(frame); } catch (error) { fail(error); return; }
          if (!settled && this.attached && this.screenReceived) {
            settled = true;
            socket.off?.('error', fail);
            socket.on('error', (error) => {
              if (this.listenerCount('error') > 0) this.emit('error', error);
            });
            resolve(this);
          }
        }
      });
      socket.on('close', () => {
        this.closed = true;
        if (!settled) fail(runtimeHostError('runtime-host-closed-before-attach'));
        this.emit('close');
      });
    });
  }

  input(data) {
    this._requireAttached();
    this._send(this._identityFrame('input', {
      data_base64: Buffer.from(data).toString('base64'),
    }));
  }

  resize(cols, rows) {
    this._requireAttached();
    this.cols = cols;
    this.rows = rows;
    this._send(this._identityFrame('resize', { cols, rows }));
  }

  detach() {
    if (!this.socket) return;
    if (this.attached) this._send(this._identityFrame('detach'));
    this.socket.end?.();
    this.socket = null;
    this.attached = false;
  }

  _handleServerFrame(frame) {
    if (frame.type === 'error') {
      throw runtimeHostError(frame.code);
    }
    if (frame.type === 'attached') {
      this._assertFrameIdentity(frame);
      this.attached = true;
      this.lastSequence = frame.sequence;
      this.emit('attached', frame);
      return;
    }
    if (frame.type === 'screen') {
      this._assertFrameIdentity(frame);
      this.lastSequence = Math.max(this.lastSequence, frame.sequence);
      this.cols = frame.cols;
      this.rows = frame.rows;
      this._writeOutput(Buffer.from(frame.ansi_base64, 'base64'));
      this.screenReceived = true;
      this.emit('screen', frame);
      return;
    }
    if (frame.type === 'output') {
      this._assertFrameIdentity(frame);
      if (frame.sequence <= this.lastSequence) return;
      this.lastSequence = frame.sequence;
      this._writeOutput(Buffer.from(frame.data_base64, 'base64'));
      this.emit('output', frame);
      return;
    }
    if (frame.type === 'resized') {
      this._assertFrameIdentity(frame);
      this.cols = frame.cols;
      this.rows = frame.rows;
    } else if (frame.type === 'exit') {
      this._assertFrameIdentity(frame);
      this.exitFrame = frame;
      this.emit('exit', frame);
    } else if (frame.type === 'status') {
      this._assertFrameIdentity(frame);
      this.emit('status', frame);
    }
  }

  _writeOutput(data) {
    const writable = this.output.write(data);
    if (writable === false && this.socket?.pause) {
      this.socket.pause();
      this.output.once?.('drain', () => this.socket?.resume?.());
    }
  }

  _send(frame) {
    if (!this.socket) throw runtimeHostError('runtime-client-disconnected');
    this.socket.write(encodeSessionHostFrame(frame, { direction: 'client' }));
  }

  _identityFrame(type, fields = {}) {
    return {
      v: SESSION_HOST_PROTOCOL_VERSION,
      type,
      mc_session_id: this.mcSessionId,
      generation_id: this.generationId,
      ...fields,
    };
  }

  _assertFrameIdentity(frame) {
    if (frame.mc_session_id !== this.mcSessionId
      || frame.generation_id !== this.generationId) {
      throw runtimeHostError('runtime-identity-mismatch');
    }
  }

  _requireAttached() {
    if (!this.socket || !this.attached) throw runtimeHostError('runtime-client-not-attached');
  }
}

export function probeSessionRuntimeHost({
  mcHomeDir,
  mcSessionId,
  generationId,
  timeoutMs = 600,
  connector = (path) => createConnection(path),
} = {}) {
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return new Promise((resolve) => {
    const socket = connector(paths.runtimeHostSocketPath);
    const decoder = new SessionHostFrameDecoder({ direction: 'server' });
    const timer = setTimeout(() => finish({ ok: false, reason: 'runtime-host-timeout' }), timeoutMs);
    timer.unref?.();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    socket.once('error', () => finish({ ok: false, reason: 'runtime-host-unreachable' }));
    socket.once('connect', () => {
      socket.write(encodeSessionHostFrame({
        v: SESSION_HOST_PROTOCOL_VERSION,
        type: 'status',
      }, { direction: 'client' }));
    });
    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (frame.type !== 'status') continue;
          finish({
            ok: frame.mc_session_id === mcSessionId
              && frame.generation_id === generationId,
            mc_session_id: frame.mc_session_id,
            generation_id: frame.generation_id,
            state: frame.state,
            process_pid: frame.process_pid,
          });
        }
      } catch {
        finish({ ok: false, reason: 'runtime-host-invalid-response' });
      }
    });
  });
}
