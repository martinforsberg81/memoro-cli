/** Local setting and handshake failures: no SSH, network or personal state. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../../../src/mc/commands/server.js';
import { readServer, serverLink } from '../../../src/mc/server-link.js';
import { descriptor } from '../../../src/mc/server-protocol.js';

function fixture(result = descriptor('handshake')) {
  const files = new Map(); const calls = []; let out = ''; let err = '';
  const io = {
    readFileSync(path) { if (!files.has(path)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return files.get(path); },
    writeFileSync(path, value, options) { calls.push(['write', path, options.mode]); files.set(path, value); },
    mkdirSync(path, options) { calls.push(['mkdir', path, options]); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    rmSync(path) { files.delete(path); },
  };
  const env = { MC_WORK_ROOT: '/isolated/mc' };
  const deps = { env, io, stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } },
    link: destination => serverLink(destination, { env, io, run: (bin, args) => {
      calls.push([bin, args]);
      return typeof result === 'function' ? result() : { status: 0, stdout: JSON.stringify(result) };
    } }) };
  return { files, calls, deps, get out() { return out; }, get err() { return err; } };
}

test('set ok saves only after successful version handshake, inside runner and never ~/.ssh', async () => {
  const f = fixture();
  assert.equal(await run(['set', 'tc'], f.deps), 0);
  assert.equal(readServer(f.deps.env, f.deps.io), 'tc');
  assert.deepEqual([...f.files.keys()], ['/isolated/mc/runner/server.json']);
  assert.equal(f.calls[0][0], 'ssh');
  assert.deepEqual(f.calls.filter(call => call[0] === 'write').map(call => call[2]), [0o600]);
  assert.match(f.out, /server tc; mc .*descriptor v1/u);
});
for (const [name, result, measured] of [
  ['unreachable', () => ({ status: 255, stderr: 'connection refused' }), /ssh tc: connection refused/u],
  ['failed SSH carrying stdout', () => ({ status: 255, stdout: JSON.stringify(descriptor('handshake')), stderr: 'connection lost' }), /ssh tc: connection lost/u],
  ['mc missing', () => ({ status: 127, stderr: 'mc: command not found' }), /ssh tc: mc: command not found/u],
  ['version unknown', { ...descriptor('handshake'), version: 8, mcVersion: 'future' }, /descriptor v8.*mc .* here, mc future on tc/u],
]) test(`set refused (${name}) preserves the prior setting and measured reason`, async () => {
  const f = fixture(result);
  f.files.set('/isolated/mc/runner/server.json', '{"destination":"old"}');
  assert.equal(await run(['set', 'tc'], f.deps), 1);
  assert.equal(readServer(f.deps.env, f.deps.io), 'old');
  assert.match(f.err, measured);
  assert.deepEqual(f.calls.filter(call => call[0] === 'write'), []);
});

test('clear removes the setting; an unconfigured show makes no link call', async () => {
  const f = fixture();
  await run(['set', 'tc'], f.deps);
  assert.equal(await run(['clear'], f.deps), 0);
  f.calls.length = 0;
  assert.equal(readServer(f.deps.env, f.deps.io), null);
  assert.equal(await run([], f.deps), 0);
  assert.deepEqual(f.calls, []);
  assert.match(f.out, /no server configured/u);
});

test('show prints the saved destination and its current measured handshake result', async () => {
  const f = fixture();
  f.files.set('/isolated/mc/runner/server.json', '{"destination":"tc"}');
  assert.equal(await run([], f.deps), 0);
  assert.match(f.out, /server tc; mc .*descriptor v1/u);
  assert.deepEqual(f.calls.map(call => call[0]), ['ssh']);
});
