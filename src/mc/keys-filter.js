/** Byte-oriented streaming redaction: neither UTF-8 nor secrets need align to chunks. */
import { Transform } from 'node:stream';

const MIN_EMBEDDED = 8;

/** A value inside a longer base64 text (Basic auth) sits at one of three byte
 * offsets. Each offset's characters that depend only on the value are the pattern. */
function encodings(plain) {
  const found = [];
  for (const offset of [0, 1, 2]) {
    const bytes = offset + plain.length;
    const base64 = Buffer.concat([Buffer.alloc(offset), plain]).toString('base64').replace(/=+$/u, '');
    const stable = base64.slice(Math.ceil(offset * 8 / 6), Math.floor(bytes * 8 / 6));
    if (offset === 0 || stable.length >= MIN_EMBEDDED) found.push(stable, stable.replaceAll('+', '-').replaceAll('/', '_'));
    if (offset === 0) found.push(base64, base64.replaceAll('+', '-').replaceAll('/', '_'), plain.toString('base64'));
  }
  return found.filter(Boolean);
}

export function keyOutputFilter(values) {
  const patterns = [];
  for (const [name, value] of Object.entries(values)) {
    const plain = Buffer.from(value);
    for (const pattern of new Set([value, ...encodings(plain)])) {
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
      // Overlapping values go together, so no value's tail survives another's match.
      let end = first.index + first.bytes.length;
      for (let grew = true; grew;) {
        grew = false;
        for (const pattern of patterns) {
          const from = Math.max(first.index, end - pattern.bytes.length + 1);
          const index = pending.indexOf(pattern.bytes, from);
          if (index >= 0 && index < end && index + pattern.bytes.length > end) { end = index + pattern.bytes.length; grew = true; }
        }
      }
      if (!final && pending.length < end + longest) break;
      if (first.index) stream.push(pending.subarray(0, first.index));
      stream.push(first.replacement);
      pending = pending.subarray(end);
    }
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]); drain(this, false); callback();
    },
    flush(callback) { drain(this, true); callback(); },
  });
}
