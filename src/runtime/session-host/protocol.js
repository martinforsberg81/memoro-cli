import {
  GENERATION_ID_RE,
} from '../../mc/session-record-ids.js';
import { MC_SESSION_ID_RE } from '../../mc/session-home-schema.js';
import { assertTerminalSize } from './terminal-screen.js';

export const SESSION_HOST_PROTOCOL_VERSION = 1;
export const SESSION_HOST_MAX_FRAME_BYTES = 1024 * 1024;

const CLIENT_TYPES = new Set(['attach', 'input', 'resize', 'detach', 'status']);
const SERVER_TYPES = new Set(['attached', 'screen', 'output', 'resized', 'exit', 'status', 'error']);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ERROR_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_SCREEN_PAYLOAD_BYTES = 700 * 1024;
const HOST_STATES = new Set(['starting', 'live', 'exited', 'failed']);

export function validateClientFrame(value) {
  if (!plain(value) || value.v !== SESSION_HOST_PROTOCOL_VERSION || !CLIENT_TYPES.has(value.type)) {
    return invalid('invalid-client-frame');
  }
  if (value.type === 'attach') {
    if (!exactKeys(value, ['v', 'type', 'mc_session_id', 'generation_id', 'cols', 'rows'])
      || !validIdentity(value)
      || !validTerminalSize(value.cols, value.rows)) return invalid('invalid-attach-frame');
  } else if (value.type === 'input') {
    if (!exactKeys(value, ['v', 'type', 'mc_session_id', 'generation_id', 'data_base64'])
      || !validIdentity(value)
      || !validBase64(value.data_base64, 256 * 1024)) return invalid('invalid-input-frame');
  } else if (value.type === 'resize') {
    if (!exactKeys(value, ['v', 'type', 'mc_session_id', 'generation_id', 'cols', 'rows'])
      || !validIdentity(value)
      || !validTerminalSize(value.cols, value.rows)) return invalid('invalid-resize-frame');
  } else if (value.type === 'detach') {
    if (!exactKeys(value, ['v', 'type', 'mc_session_id', 'generation_id'])
      || !validIdentity(value)) return invalid('invalid-detach-frame');
  } else if (!exactKeys(value, ['v', 'type'])) {
    return invalid(`invalid-${value.type}-frame`);
  }
  return validCopy(value);
}

export function validateServerFrame(value) {
  if (!plain(value) || value.v !== SESSION_HOST_PROTOCOL_VERSION || !SERVER_TYPES.has(value.type)) {
    return invalid('invalid-server-frame');
  }
  if (value.type === 'attached') {
    if (!exactKeys(value, [
      'v', 'type', 'mc_session_id', 'generation_id', 'client_id', 'sequence',
    ]) || !validIdentity(value) || !validClientId(value.client_id) || !sequence(value.sequence)) {
      return invalid('invalid-attached-frame');
    }
  } else if (value.type === 'screen') {
    if (!exactKeys(value, [
      'v', 'type', 'mc_session_id', 'generation_id', 'sequence', 'cols', 'rows',
      'ansi_base64', 'scrollback_truncated',
    ]) || !validIdentity(value)
      || !sequence(value.sequence)
      || !validTerminalSize(value.cols, value.rows)
      || !validBase64(value.ansi_base64, MAX_SCREEN_PAYLOAD_BYTES)
      || typeof value.scrollback_truncated !== 'boolean') return invalid('invalid-screen-frame');
  } else if (value.type === 'output') {
    if (!exactKeys(value, [
      'v', 'type', 'mc_session_id', 'generation_id', 'sequence', 'data_base64',
    ]) || !validIdentity(value)
      || !sequence(value.sequence)
      || !validBase64(value.data_base64, 512 * 1024)) return invalid('invalid-output-frame');
  } else if (value.type === 'resized') {
    if (!exactKeys(value, [
      'v', 'type', 'mc_session_id', 'generation_id', 'sequence', 'cols', 'rows',
    ]) || !validIdentity(value)
      || !sequence(value.sequence)
      || !validTerminalSize(value.cols, value.rows)) return invalid('invalid-resized-frame');
  } else if (value.type === 'exit') {
    if (!exactKeys(value, [
      'v', 'type', 'mc_session_id', 'generation_id', 'exit_code', 'signal',
    ]) || !validIdentity(value)
      || (value.exit_code !== null
        && (!Number.isSafeInteger(value.exit_code) || value.exit_code < 0))
      || (value.signal !== null && !/^[A-Z][A-Z0-9]{0,31}$/u.test(value.signal || ''))
      || (value.exit_code === null && value.signal === null)) return invalid('invalid-exit-frame');
  } else if (value.type === 'status') {
    if (!exactKeys(value, [
      'v', 'type', 'mc_session_id', 'generation_id', 'state', 'process_pid',
      'clients', 'screen',
    ]) || !validIdentity(value)
      || !HOST_STATES.has(value.state)
      || (value.process_pid !== null
        && (!Number.isSafeInteger(value.process_pid) || value.process_pid < 1))
      || !Number.isSafeInteger(value.clients)
      || value.clients < 0
      || !validScreenStatus(value.screen)) return invalid('invalid-status-frame');
  } else if (!exactKeys(value, ['v', 'type', 'code'])
    || !ERROR_CODE_RE.test(value.code || '')) {
    return invalid('invalid-error-frame');
  }
  return validCopy(value);
}

export function encodeSessionHostFrame(frame, { direction } = {}) {
  const checked = direction === 'client'
    ? validateClientFrame(frame)
    : validateServerFrame(frame);
  if (!checked.ok) throw sessionHostProtocolError(checked.reason);
  const encoded = Buffer.from(`${JSON.stringify(checked.value)}\n`, 'utf8');
  if (encoded.length > SESSION_HOST_MAX_FRAME_BYTES) {
    throw sessionHostProtocolError('frame-too-large');
  }
  return encoded;
}

export class SessionHostFrameDecoder {
  constructor({ direction, maxFrameBytes = SESSION_HOST_MAX_FRAME_BYTES } = {}) {
    if (direction !== 'client' && direction !== 'server') {
      throw new TypeError('frame direction must be client or server');
    }
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024) {
      throw new TypeError('invalid maxFrameBytes');
    }
    this.direction = direction;
    this.maxFrameBytes = maxFrameBytes;
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.pending.length + next.length > this.maxFrameBytes) {
      throw sessionHostProtocolError('frame-too-large');
    }
    this.pending = Buffer.concat([this.pending, next]);
    const frames = [];
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (line.length === 0) continue;
      let parsed;
      try { parsed = JSON.parse(line.toString('utf8')); } catch {
        throw sessionHostProtocolError('invalid-json-frame');
      }
      const checked = this.direction === 'client'
        ? validateClientFrame(parsed)
        : validateServerFrame(parsed);
      if (!checked.ok) throw sessionHostProtocolError(checked.reason);
      frames.push(checked.value);
    }
    return frames;
  }
}

export function sessionHostProtocolError(reason) {
  const error = new Error(`mc session host protocol error (${reason})`);
  error.code = 'MC_SESSION_HOST_PROTOCOL_ERROR';
  error.reason = reason;
  return error;
}

function validIdentity(value) {
  return MC_SESSION_ID_RE.test(value.mc_session_id || '')
    && GENERATION_ID_RE.test(value.generation_id || '');
}

function validTerminalSize(cols, rows) {
  try { assertTerminalSize(cols, rows); return true; } catch { return false; }
}

function validBase64(value, maximumBytes) {
  if (typeof value !== 'string'
    || value.length > Math.ceil(maximumBytes / 3) * 4
    || !BASE64_RE.test(value)) return false;
  return Buffer.from(value, 'base64').length <= maximumBytes;
}

function validClientId(value) {
  return typeof value === 'string' && /^client_[a-f0-9]{16}$/u.test(value);
}

function validScreenStatus(value) {
  return plain(value)
    && exactKeys(value, [
      'cols', 'rows', 'parsed_sequence', 'pending_bytes', 'pending_operations',
      'scrollback_lines',
    ])
    && validTerminalSize(value.cols, value.rows)
    && sequence(value.parsed_sequence)
    && boundedNonNegative(value.pending_bytes, 64 * 1024 * 1024)
    && boundedNonNegative(value.pending_operations, 1_000_000)
    && boundedNonNegative(value.scrollback_lines, 10_000);
}

function boundedNonNegative(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function sequence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validCopy(value) {
  return { ok: true, value: structuredClone(value) };
}

function invalid(reason) {
  return { ok: false, reason };
}
