import { StringDecoder } from 'node:string_decoder';

import serializePackage from '@xterm/addon-serialize';
import headlessPackage from '@xterm/headless';

const { SerializeAddon } = serializePackage;
const { Terminal } = headlessPackage;

const DEFAULT_SCROLLBACK_LINES = 2000;
const DEFAULT_PENDING_BYTES = 4 * 1024 * 1024;
const DEFAULT_SNAPSHOT_BYTES = 512 * 1024;
const MAX_PROTOCOL_SNAPSHOT_BYTES = 700 * 1024;

export class TerminalScreen {
  constructor({
    cols = 80,
    rows = 24,
    scrollbackLines = DEFAULT_SCROLLBACK_LINES,
    maxPendingBytes = DEFAULT_PENDING_BYTES,
    maxSnapshotBytes = DEFAULT_SNAPSHOT_BYTES,
    terminalFactory = (options) => new Terminal(options),
    serializeAddonFactory = () => new SerializeAddon(),
  } = {}) {
    assertTerminalSize(cols, rows);
    assertBoundedInteger(scrollbackLines, 0, 10_000, 'scrollbackLines');
    assertBoundedInteger(maxPendingBytes, 64 * 1024, 64 * 1024 * 1024, 'maxPendingBytes');
    assertBoundedInteger(
      maxSnapshotBytes,
      64 * 1024,
      MAX_PROTOCOL_SNAPSHOT_BYTES,
      'maxSnapshotBytes',
    );
    this.cols = cols;
    this.rows = rows;
    this.scrollbackLines = scrollbackLines;
    this.maxPendingBytes = maxPendingBytes;
    this.maxSnapshotBytes = maxSnapshotBytes;
    this.terminal = terminalFactory({
      cols,
      rows,
      scrollback: scrollbackLines,
      // The official serializer uses the headless buffer's proposed marker
      // API. It remains encapsulated here; no caller observes that API.
      allowProposedApi: true,
    });
    this.serializer = serializeAddonFactory();
    this.terminal.loadAddon(this.serializer);
    this.decoder = new StringDecoder('utf8');
    this.queue = [];
    this.pendingBytes = 0;
    this.processing = false;
    this.disposed = false;
    this.parsedSequence = 0;
    this.lastSequence = 0;
  }

  append(data, sequence) {
    this._assertOpen();
    if (!Number.isSafeInteger(sequence) || sequence <= this.lastSequence) {
      throw new TypeError('terminal output sequence must increase');
    }
    const bytes = Buffer.isBuffer(data)
      ? data.length
      : Buffer.byteLength(String(data ?? ''), 'utf8');
    if (bytes === 0) {
      this.parsedSequence = sequence;
      this.lastSequence = sequence;
      return { ok: true, pending_bytes: this.pendingBytes };
    }
    if (bytes > this.maxPendingBytes || this.pendingBytes + bytes > this.maxPendingBytes) {
      return { ok: false, reason: 'terminal-parser-overflow', pending_bytes: this.pendingBytes };
    }
    const text = Buffer.isBuffer(data) ? this.decoder.write(data) : String(data);
    this.queue.push({ kind: 'data', text, bytes, sequence });
    this.lastSequence = sequence;
    this.pendingBytes += bytes;
    this._drain();
    return { ok: true, pending_bytes: this.pendingBytes };
  }

  snapshot() {
    this._assertOpen();
    return this._enqueueBarrier({ kind: 'snapshot' });
  }

  resize(cols, rows) {
    this._assertOpen();
    assertTerminalSize(cols, rows);
    return this._enqueueBarrier({ kind: 'resize', cols, rows });
  }

  status() {
    return {
      cols: this.cols,
      rows: this.rows,
      parsed_sequence: this.parsedSequence,
      pending_bytes: this.pendingBytes,
      pending_operations: this.queue.length + (this.processing ? 1 : 0),
      scrollback_lines: Math.min(
        this.scrollbackLines,
        Math.max(0, this.terminal.buffer.active.length - this.rows),
      ),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.queue.splice(0)) {
      item.reject?.(terminalScreenError('terminal-screen-disposed'));
    }
    this.pendingBytes = 0;
    this.serializer.dispose();
    this.terminal.dispose();
  }

  _enqueueBarrier(item) {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...item, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    if (this.processing || this.disposed) return;
    const item = this.queue.shift();
    if (!item) return;
    this.processing = true;
    if (item.kind === 'data') {
      this.terminal.write(item.text, () => {
        this.pendingBytes -= item.bytes;
        this.parsedSequence = item.sequence;
        this.processing = false;
        queueMicrotask(() => this._drain());
      });
      return;
    }
    try {
      if (item.kind === 'resize') {
        this.terminal.resize(item.cols, item.rows);
        this.cols = item.cols;
        this.rows = item.rows;
      }
      item.resolve(this._serialize());
    } catch (error) {
      item.reject(error);
    } finally {
      this.processing = false;
      queueMicrotask(() => this._drain());
    }
  }

  _serialize() {
    let ansi = this.serializer.serialize({ scrollback: this.scrollbackLines });
    let truncated = false;
    if (Buffer.byteLength(ansi, 'utf8') > this.maxSnapshotBytes) {
      ansi = this.serializer.serialize({ scrollback: 0 });
      truncated = true;
    }
    ansi = `\u001b[2J\u001b[H${ansi}`;
    const bytes = Buffer.byteLength(ansi, 'utf8');
    if (bytes > this.maxSnapshotBytes) throw terminalScreenError('terminal-snapshot-too-large');
    return {
      ansi,
      cols: this.cols,
      rows: this.rows,
      through_sequence: this.parsedSequence,
      scrollback_truncated: truncated,
      bytes,
    };
  }

  _assertOpen() {
    if (this.disposed) throw terminalScreenError('terminal-screen-disposed');
  }
}

export function assertTerminalSize(cols, rows) {
  assertBoundedInteger(cols, 20, 500, 'cols');
  assertBoundedInteger(rows, 5, 200, 'rows');
}

export function terminalScreenError(reason) {
  const error = new Error(`mc terminal screen error (${reason})`);
  error.code = 'MC_TERMINAL_SCREEN_ERROR';
  error.reason = reason;
  return error;
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
}
