import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run as keysCommand, handlesHelp } from '../../src/mc/commands/keys.js';
import { runScriptWithKeys, listScriptKeys } from '../../src/mc/keys-run.js';
import { keysDotenvPath, parseKeysDotenv } from '../../src/mc/keys-dotenv.js';
import { keyOutputFilter } from '../../src/mc/keys-filter.js';
import { rememberRuntimeSecretNames, scrubProviderApiKeysFromEnv, scrubRuntimeSecretsFromEnv } from '../../src/mc/runtime-secrets.js';
import { invocationShape } from '../../src/mc/logger.js';

const SECRET = 'fixture-only-å-shared-secret-0123456789';
const capture = () => {
  let bytes = Buffer.alloc(0);
  const stream = new Writable({ write(chunk, _encoding, callback) { bytes = Buffer.concat([bytes, chunk]); callback(); } });
  return { stream, text: () => bytes.toString('utf8'), bytes: () => bytes };
};
async function fixture(t, dotenv = `FIXTURE_TOKEN="${SECRET}"\nNONSECRET_ID=fixture-id\n`) {
  const directory = mkdtempSync(join(tmpdir(), 'mc-shared-dotenv-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.vars');
  writeFileSync(source, dotenv);
  const cwd = join(directory, 'working'); mkdirSync(cwd);
  const env = { ...process.env, MC_HOME: join(directory, 'mc-home'), MC_KEYS_FILE: source,
    HOME: join(directory, 'attacker-home'), INHERITED_SECRET: 'must-not-be-a-dotenv-value',
    NODE_OPTIONS: '--require=not-allowed.cjs', PATH: process.env.PATH };
  async function run(script, args = [], options = {}) {
    const stdout = capture(); const stderr = capture();
    const exit = await keysCommand(['run', script, ...args], { cwd, env, stdout: stdout.stream, stderr: stderr.stream, ...options });
    return { exit, stdout: stdout.text(), stderr: stderr.text() };
  }
  return { directory, source, cwd, env, run, setSource: text => writeFileSync(source, text),
    records: () => readFileSync(join(env.MC_HOME, 'keys', 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}
function write(cwd, file, content) {
  const path = join(cwd, file); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); return path;
}
function absent(text, ...values) { for (const value of values) assert.ok(!text.includes(value), `unexpected fixture value in ${text}`); }

test('shared dotenv execution runs an undeclared modified script and local and npm imports from one working directory', async t => {
  const f = await fixture(t);
  const first = write(f.cwd, 'changed.mjs', "process.stdout.write('original');");
  write(f.cwd, 'changed.mjs', `import { suffix } from './helper.mjs'; import { packageValue } from 'fixture-package'; process.stdout.write(process.env.FIXTURE_TOKEN + ':' + suffix + ':' + packageValue + ':' + process.argv.slice(2).join(','));`);
  write(f.cwd, 'helper.mjs', "export const suffix = 'local';");
  write(f.cwd, 'node_modules/fixture-package/package.json', '{"type":"module","exports":"./index.js"}');
  write(f.cwd, 'node_modules/fixture-package/index.js', "export const packageValue = 'npm-local';");
  const result = await f.run(first, ['--help', 'arg']);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.stdout, '[key:FIXTURE_TOKEN]:local:npm-local:--help,arg');
});

test('shared dotenv execution runs an untracked script with local imports from a second working directory', async t => {
  const f = await fixture(t);
  const second = join(f.directory, 'other-worktree'); mkdirSync(second);
  write(second, 'package.json', '{"type":"module"}');
  const script = write(second, 'nested/script.js', "import { value } from './module.js'; process.stdout.write(value + ':' + process.cwd());");
  write(second, 'nested/module.js', "export const value = process.env.NONSECRET_ID;");
  const again = await f.run(script, [], { cwd: second });
  assert.equal(again.exit, 0, again.stderr);
  assert.match(again.stdout, /^\[key:NONSECRET_ID\]:/u, 'nonsecret dotenv entries are delivered and all nonempty values are filtered');
  assert.equal(f.records().filter(row => row.event === 'start').length, 1);
});

test('shared dotenv server command receives keys and names with filtered output and isolated argv', async t => {
  const f = await fixture(t, `TOKEN_ENCRYPTION_KEY=${SECRET}\nNEW_CONFIG=fixture-config\n`);
  const script = write(f.cwd, 'server-adapter.mjs', `
    process.stdout.write(JSON.stringify({ key: process.env.TOKEN_ENCRYPTION_KEY === ${JSON.stringify(SECRET)}, names: JSON.parse(process.env.MC_KEYS_NAMES), args: process.argv.slice(2) }));
    process.stderr.write(process.env.TOKEN_ENCRYPTION_KEY);`);
  const stdout = capture(); const stderr = capture();
  const before = { ...f.env };
  const exit = await keysCommand(['serve', process.execPath, script, '--help', ';literal'], {
    cwd: f.cwd, env: f.env, stdout: stdout.stream, stderr: stderr.stream,
  });
  assert.deepEqual(JSON.parse(stdout.text()), { key: true, names: ['NEW_CONFIG', 'TOKEN_ENCRYPTION_KEY'], args: ['--help', ';literal'] });
  assert.equal(exit, 0);
  assert.equal(stderr.text(), '[key:TOKEN_ENCRYPTION_KEY]');
  assert.deepEqual(f.env, before);
  absent(JSON.stringify(f.records()), SECRET, ';literal');
  assert.ok(handlesHelp(['serve', process.execPath, '--help']));
  assert.deepEqual(invocationShape(['keys', 'serve', 'node', script]), { verb: 'keys', sub: 'serve', args: [], flags: [], argc: 4 });
});

test('shared dotenv freshness reparses additions and changes, parses quotes and exports, and leaves absent names undefined', async t => {
  const f = await fixture(t, 'export QUOTED="first\\nsecond" # comment\nPLAIN=old # trailing comment\n');
  const script = write(f.cwd, 'inspect.mjs', "const first=process.env.QUOTED==='first\\nsecond'&&process.env.PLAIN==='old'&&process.env.ADDED===undefined&&process.env.CONFIG_ID===undefined; const changed=process.env.QUOTED==='changed value'&&process.env.PLAIN===undefined&&process.env.ADDED===undefined&&process.env.CONFIG_ID==='account-7'; process.stdout.write(JSON.stringify({first,changed}));");
  let result = await f.run(script);
  assert.deepEqual(JSON.parse(result.stdout), { first: true, changed: false });
  f.setSource("export QUOTED='changed value'\nCONFIG_ID=account-7\n");
  result = await f.run(script);
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { first: false, changed: true });
  assert.equal(keysDotenvPath({ env: { HOME: '/untrusted/home' }, home: '/host/home', cwd: '/elsewhere' }), '/host/home/mc/self/memoro/.dev.vars');
});

test('shared dotenv refusals reject missing sources duplicate names malformed assignments and reserved names before launch', async t => {
  const f = await fixture(t);
  const marker = join(f.directory, 'launched');
  const script = write(f.cwd, 'mark.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes');`);
  f.env.MC_KEYS_FILE = join(f.directory, 'missing.vars');
  const missing = await f.run(script);
  assert.equal(missing.exit, 1); assert.match(missing.stderr, /missing or unreadable/u);
  f.env.MC_KEYS_FILE = f.source;
  const unreadable = join(f.directory, 'unreadable'); mkdirSync(unreadable);
  f.env.MC_KEYS_FILE = unreadable;
  const denied = await f.run(script);
  assert.equal(denied.exit, 1); assert.match(denied.stderr, /missing or unreadable/u);
  f.env.MC_KEYS_FILE = f.source;
  assert.throws(() => parseKeysDotenv('DUP=x\nDUP=y'), /duplicate name/u);
  assert.throws(() => parseKeysDotenv('BROKEN LINE value-secret'), /malformed assignment/u);
  assert.throws(() => parseKeysDotenv('NODE_OPTIONS=secret-value'), /reserved or invalid name/u);
  for (const source of ['DUP=x\nDUP=y', 'broken assignment with-value-secret', 'PATH=/secret-path', 'MC_RUNTIME_CONTROL=value']) {
    f.setSource(source);
    const result = await f.run(script);
    assert.equal(result.exit, 1); assert.equal(result.stdout, '');
    absent(result.stderr, 'value-secret', '/secret-path');
  }
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  absent(JSON.stringify(f.records()), 'value-secret', '/secret-path');
});

test('shared dotenv isolation redacts raw and encoded values across chunks without changing parent env argv or audit', async t => {
  const f = await fixture(t);
  const script = write(f.cwd, 'print.mjs', `const value=process.env.FIXTURE_TOKEN; const encoded=Buffer.from(value).toString('base64'); for(const part of [value,encoded]) { process.stdout.write(part.slice(0,7)); await new Promise(r=>setTimeout(r,4)); process.stdout.write(part.slice(7)+' '); process.stderr.write(part+' '); } process.stdout.write(JSON.stringify({argv:process.argv.slice(2),inherited:process.env.INHERITED_SECRET,node:process.env.NODE_OPTIONS,home:process.env.HOME}));`);
  const before = { ...process.env }; const envBefore = { ...f.env };
  const result = await f.run(script, ['arg-secret-is-not-a-value']);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.stdout.slice(0, '[key:FIXTURE_TOKEN] [key:FIXTURE_TOKEN] '.length), '[key:FIXTURE_TOKEN] [key:FIXTURE_TOKEN] ');
  assert.equal(result.stderr, '[key:FIXTURE_TOKEN] [key:FIXTURE_TOKEN] ');
  const payload = JSON.parse(result.stdout.slice('[key:FIXTURE_TOKEN] [key:FIXTURE_TOKEN] '.length));
  assert.deepEqual(payload.argv, ['arg-secret-is-not-a-value']); assert.equal(payload.inherited, 'must-not-be-a-dotenv-value');
  assert.ok(!payload.node?.includes('not-allowed.cjs'), 'inherited executor control was stripped'); assert.equal(payload.home, f.env.HOME);
  assert.deepEqual({ ...process.env }, before); assert.deepEqual(f.env, envBefore);
  const records = JSON.stringify(f.records()); absent(records, SECRET, Buffer.from(SECRET).toString('base64'));
  assert.equal(f.records()[1].content_hash, null);
  rememberRuntimeSecretNames(['FIXTURE_TOKEN'], f.env);
  assert.equal(scrubRuntimeSecretsFromEnv({ ...f.env, FIXTURE_TOKEN: SECRET }).FIXTURE_TOKEN, undefined);
  assert.equal(scrubProviderApiKeysFromEnv({ ...f.env, FIXTURE_TOKEN: SECRET }).FIXTURE_TOKEN, undefined);
});

test('shared dotenv compatibility preserves --help argv exit status signals and names-only list output', async t => {
  const f = await fixture(t, `FIXTURE_TOKEN=${SECRET}\nZ_CONFIG="z-value"\nA_CONFIG=value\n`);
  const script = write(f.cwd, 'args.cjs', "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode=7;");
  const result = await f.run(script, ['--help', 'two']);
  assert.equal(result.exit, 7); assert.deepEqual(JSON.parse(result.stdout), ['--help', 'two']);
  assert.ok(handlesHelp(['run', 'args.cjs', '--help']));
  assert.deepEqual(invocationShape(['keys', 'run', 'args.cjs', '--private', 'opaque']), { verb: 'keys', sub: 'run', args: [], flags: [], argc: 5 });
  const stdout = capture(); const stderr = capture();
  assert.equal(await listScriptKeys({ cwd: f.cwd, env: f.env, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(stdout.text(), 'A_CONFIG\nFIXTURE_TOKEN\nZ_CONFIG\n'); assert.equal(stderr.text(), '');
  absent(stdout.text(), SECRET, 'value', 'held', 'missing');
  const waiting = write(f.cwd, 'wait.mjs', "await new Promise(()=>{});");
  const running = runScriptWithKeys(waiting, [], { cwd: f.cwd, env: f.env, stdout: capture().stream, stderr: capture().stream });
  await new Promise(resolve => setTimeout(resolve, 10));
  process.emit('SIGTERM');
  assert.equal(await running, 143);
});

test('the byte filter redacts base64 across every chunk edge and keeps nonmatching bytes', async () => {
  const value = 'fixture-token-abcdefghi'; const encoded = Buffer.from(value).toString('base64');
  const input = Buffer.from(`before ${value} middle ${encoded} after`);
  const expected = `before [key:TOKEN] middle [key:TOKEN] after`;
  for (let split = 0; split <= input.length; split++) {
    const out = capture();
    await pipeline(Readable.from([input.subarray(0, split), input.subarray(split)]), keyOutputFilter({ TOKEN: value, EMPTY: '' }), out.stream);
    assert.equal(out.text(), expected, `split ${split}`);
  }
});
