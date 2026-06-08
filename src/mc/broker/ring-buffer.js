/**
 * Bounded ordered byte buffer for recent PTY output.
 *
 * Phase 1 uses this for the same "recent output" excerpt that runWrap
 * previously kept inline. Later broker phases can replay the same buffer to
 * attach clients.
 */
export class RingBuffer {
  constructor({ maxBytes }) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('maxBytes must be a positive integer');
    }
    this.maxBytes = maxBytes;
    this._chunks = [];
    this._byteLength = 0;
  }

  append(chunk) {
    if (chunk == null) return this;

    const buf = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(String(chunk), 'utf8');
    if (buf.length === 0) return this;

    this._chunks.push(buf);
    this._byteLength += buf.length;
    this._trim();
    return this;
  }

  replay() {
    return Buffer.concat(this._chunks, this._byteLength);
  }

  toString(encoding = 'utf8') {
    return this.replay().toString(encoding);
  }

  clear() {
    this._chunks = [];
    this._byteLength = 0;
  }

  get byteLength() {
    return this._byteLength;
  }

  _trim() {
    let overflow = this._byteLength - this.maxBytes;
    while (overflow > 0 && this._chunks.length > 0) {
      const first = this._chunks[0];
      if (first.length <= overflow) {
        this._chunks.shift();
        this._byteLength -= first.length;
        overflow -= first.length;
        continue;
      }

      this._chunks[0] = first.subarray(overflow);
      this._byteLength -= overflow;
      overflow = 0;
    }
  }
}

