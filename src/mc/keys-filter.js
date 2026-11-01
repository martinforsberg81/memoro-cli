/** Byte-oriented streaming redaction: neither UTF-8 nor secrets need align to chunks. */
import { Transform } from 'node:stream';

export function keyOutputFilter(values) {
  const patterns = [];
  for (const [name, value] of Object.entries(values)) {
    const plain = Buffer.from(value);
    const encoded = plain.toString('base64');
    for (const pattern of new Set([value, encoded, encoded.replace(/=+$/u, '')])) {
      patterns.push({ bytes: Buffer.from(pattern), replacement: Buffer.from(`[key:${name}]`) });
    }
  }
  patterns.sort((a, b) => b.bytes.length - a.bytes.length);
  const longest = Math.max(1, ...patterns.map(pattern => pattern.bytes.length));
  let pending = Buffer.alloc(0);
  function drain(stream, final) {
    while (pending.length) {
      const safe = final ? pending.length : pending.length - longest + 1;
      if (safe <= 0) break;
      let first = null;
      for (const pattern of patterns) {
        const index = pending.indexOf(pattern.bytes);
        if (index >= 0 && index < safe && (!first || index < first.index)) first = { index, ...pattern };
      }
      if (!first) {
        stream.push(pending.subarray(0, safe)); pending = pending.subarray(safe); continue;
      }
      if (first.index) stream.push(pending.subarray(0, first.index));
      stream.push(first.replacement);
      pending = pending.subarray(first.index + first.bytes.length);
    }
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]); drain(this, false); callback();
    },
    flush(callback) { drain(this, true); callback(); },
  });
}
