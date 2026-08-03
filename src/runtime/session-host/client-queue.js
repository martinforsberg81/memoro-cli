import { encodeSessionHostFrame } from './protocol.js';

const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_FRAMES = 256;

export class RuntimeClientQueue {
  constructor({
    socket,
    maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
    maxQueuedFrames = DEFAULT_MAX_QUEUED_FRAMES,
    onDisconnect = () => {},
  } = {}) {
    if (!socket || typeof socket.write !== 'function' || typeof socket.destroy !== 'function') {
      throw new TypeError('writable socket is required');
    }
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 64 * 1024) {
      throw new TypeError('invalid maxQueuedBytes');
    }
    if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames < 1) {
      throw new TypeError('invalid maxQueuedFrames');
    }
    this.socket = socket;
    this.maxQueuedBytes = maxQueuedBytes;
    this.maxQueuedFrames = maxQueuedFrames;
    this.onDisconnect = onDisconnect;
    this.queue = [];
    this.queuedBytes = 0;
    this.blocked = false;
    this.closed = false;
    this.reason = null;
    this.socket.on?.('drain', () => this._drain());
    this.socket.on?.('close', () => this.close('client-closed', { destroy: false }));
    this.socket.on?.('error', () => this.close('client-socket-error', { destroy: false }));
  }

  send(frame) {
    if (this.closed) return false;
    let encoded;
    try { encoded = encodeSessionHostFrame(frame, { direction: 'server' }); } catch {
      this.close('invalid-server-frame');
      return false;
    }
    const writableBytes = Number.isSafeInteger(this.socket.writableLength)
      ? this.socket.writableLength
      : 0;
    if (encoded.length > this.maxQueuedBytes
      || writableBytes + this.queuedBytes + encoded.length > this.maxQueuedBytes
      || this.queue.length >= this.maxQueuedFrames) {
      this.close('slow-client-overflow');
      return false;
    }
    if (this.blocked || this.queue.length > 0) {
      this.queue.push(encoded);
      this.queuedBytes += encoded.length;
      return true;
    }
    return this._write(encoded);
  }

  status() {
    return {
      blocked: this.blocked,
      closed: this.closed,
      queued_bytes: this.queuedBytes,
      queued_frames: this.queue.length,
      reason: this.reason,
    };
  }

  close(reason = 'client-detached', { destroy = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.reason = reason;
    this.queue = [];
    this.queuedBytes = 0;
    if (destroy) {
      try { this.socket.destroy(); } catch {}
    }
    try { this.onDisconnect(reason); } catch {}
  }

  _write(encoded) {
    try {
      const writable = this.socket.write(encoded);
      this.blocked = writable === false;
      return true;
    } catch {
      this.close('client-write-failed');
      return false;
    }
  }

  _drain() {
    if (this.closed) return;
    this.blocked = false;
    while (!this.blocked && this.queue.length > 0) {
      const encoded = this.queue.shift();
      this.queuedBytes -= encoded.length;
      this._write(encoded);
    }
  }
}
