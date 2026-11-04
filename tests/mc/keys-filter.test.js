import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { keyOutputFilter } from '../../src/mc/keys-filter.js';

// All values below are synthetic. The filter is the same one mc keys run uses
// on a child's stdout and stderr.
const capture = () => {
  let bytes = Buffer.alloc(0);
  const stream = new Writable({ write(chunk, _encoding, callback) { bytes = Buffer.concat([bytes, chunk]); callback(); } });
  return { stream, text: () => bytes.toString('utf8'), bytes: () => bytes };
};

const filtered = async (values, chunks) => {
  const filter = keyOutputFilter(values); const out = [];
  filter.on('data', chunk => out.push(chunk));
  for (const chunk of chunks) filter.write(chunk);
  filter.end();
  await new Promise(resolve => filter.on('end', resolve));
  return Buffer.concat(out).toString();
};

test('every byte split and overlapping values redact without corrupting other bytes', async () => {
  const values = { SHORT: 'abcd', LONG: 'abcdefghi', UNICODE: 'å🔑x' };
  const plain = Buffer.from('before abcdefghi abcd å🔑x after');
  const expected = 'before [key:LONG] [key:SHORT] [key:UNICODE] after';
  for (let split = 0; split <= plain.length; split++) {
    const out = capture();
    await pipeline(Readable.from([plain.subarray(0, split), plain.subarray(split)]), keyOutputFilter(values), out.stream);
    assert.equal(out.text(), expected, `split ${split}`);
  }
  const out = capture(); const binary = Buffer.from([0xff, 0, 0xfe, 42]);
  await pipeline(Readable.from([binary]), keyOutputFilter(values), out.stream); assert.deepEqual(out.bytes(), binary);
});

test('a value inside a longer base64 text, or in base64url, does not pass the filter', async () => {
  const value = 'sk-live_abc?>~012345';
  for (const prefix of ['user:', 'us:', 'u:', '']) {
    const text = Buffer.from(`${prefix}${value}`).toString('base64');
    for (const encoded of [text, text.replaceAll('+', '-').replaceAll('/', '_')]) {
      const middle = value.slice(4, 16);
      const out = await filtered({ TOKEN: value }, [encoded]);
      assert.match(out, /\[key:TOKEN\]/u, prefix);
      assert.equal(Buffer.from(out.replace('[key:TOKEN]', ''), 'base64').includes(middle), false);
    }
  }
});

test('overlapping values leave no tail, across a chunk edge too', async () => {
  const values = { A: 'tok9', B: 'ok9-remainder-of-b' };
  assert.equal(await filtered(values, ['x tok9-remainder-of-b y']), 'x [key:A] y');
  assert.equal((await filtered(values, ['x tok9-rem', 'ainder-of-b y'])).includes('remainder'), false);
});

test('an empty delivered value is not a pattern and leaves output untouched', async () => {
  assert.equal(await filtered({ EMPTY: '', TOKEN: 'tok-xyz' }, ['a tok-xyz b']), 'a [key:TOKEN] b');
  assert.equal(await filtered({ EMPTY: '' }, ['unchanged']), 'unchanged');
});
