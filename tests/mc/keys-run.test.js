import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run as keysCommand, handlesHelp } from '../../src/mc/commands/keys.js';
import { runScriptWithKeys, listScriptKeys } from '../../src/mc/keys-run.js';
import { keyOutputFilter } from '../../src/mc/keys-filter.js';
import { rememberRuntimeSecretNames, scrubProviderApiKeysFromEnv, scrubRuntimeSecretsFromEnv, scrubRuntimeSecretsInPlace } from '../../src/mc/runtime-secrets.js';
import { invocationShape } from '../../src/mc/logger.js';
import { importVaultKey } from '../../src/vault/engine/client-crypto.js';
import { encryptEnvelopeSecret, mintCustodyRoot } from '../../src/vault/engine/custody-crypto.js';

// All values and all encryption keys below are synthetic. No keychain or network.
const KEY = 'fixture-only-å-script-key-0123456789';
const OTHER = 'fixture-only-unreleased-key';
const digest = value => createHash('sha256').update(value).digest('hex');
const capture = () => {
  let bytes = Buffer.alloc(0);
  const stream = new Writable({ write(chunk, _encoding, callback) { bytes = Buffer.concat([bytes, chunk]); callback(); } });
  return { stream, text: () => bytes.toString('utf8'), bytes: () => bytes };
};
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t, source, { names = { FIXTURE_KEY: 'dotenv:fixture:FIXTURE_KEY' }, sources = ['script.mjs'], files = {} } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mc-keys-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo'); mkdirSync(root);
  const env = { ...process.env, MC_HOME: join(directory, 'mc'), SECOND_KEY: 'inherited-and-must-be-removed' };
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']); git(root, ['config', 'core.hooksPath', join(directory, 'no-hooks')]);
  const manifest = { version: 1, scripts: {
    'script.mjs': { keys: names, sources },
    'other.mjs': { keys: { SECOND_KEY: 'other' }, sources: ['other.mjs'] },
  } };
  const write = (file, content) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), content); };
  write('package.json', JSON.stringify({ type: 'module' }));
  write('script.mjs', source); write('other.mjs', 'process.exit(0);');
  write('.mc-keys.json', JSON.stringify(manifest));
  for (const [file, content] of Object.entries(files)) write(file, content);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const vaultKey = await importVaultKey(new Uint8Array(32).fill(9));
  const custody = await mintCustodyRoot(vaultKey);
  const rows = [];
  async function add(label, token, secretClass = 'secret') {
    const encrypted = await encryptEnvelopeSecret(custody.crk, { label, data: { kind: 'api_token', token }, secretClass });
    rows.push({ encrypted_label: encrypted.encryptedLabel, label_iv: encrypted.labelIv,
      encrypted_data: encrypted.encryptedData, iv: encrypted.iv, wrapped_dek: encrypted.wrapped_dek,
      dek_iv: encrypted.dek_iv, class: encrypted.class, schema_version: encrypted.schema_version });
  }
  await add('dotenv:fixture:FIXTURE_KEY', KEY); await add('other', OTHER);
  let locked = false; let reads = 0;
  const vaultDeps = {
    readCachedVaultKey: async () => { reads++; return locked ? null : { vaultKey, vaultKeyBytes: new Uint8Array(32).fill(9), authHash: 'fixture-hash' }; },
    portal: { apiUrl: 'https://fixture.invalid', token: 'fixture-login' },
    api: {
      unlockVault: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true, vault: { setup: true, unlocked: true, wrapped_crk: custody.wrapped_crk, crk_iv: custody.crk_iv } }),
      listSecrets: async () => ({ ok: true, secrets: rows }),
    },
  };
  async function run(args = [], script = 'script.mjs', options = {}) {
    const stdout = capture(); const stderr = capture();
    const exit = await keysCommand(['run', script, ...args], { cwd: root, env, vaultDeps, stdout: stdout.stream, stderr: stderr.stream, ...options });
    return { exit, stdout: stdout.text(), stderr: stderr.text() };
  }
  return { directory, root, env, vaultDeps, manifest, run, write, rows, add,
    lock: () => { locked = true; }, reads: () => reads,
    records: () => readFileSync(join(env.MC_HOME, 'keys', 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}
function allFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? allFiles(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function absent(text) {
  for (const value of [KEY, OTHER]) {
    assert.ok(!text.includes(value)); assert.ok(!text.includes(Buffer.from(value).toString('base64')));
  }
}

test('a key reaches the declared script and nothing else', async t => {
  const f = await fixture(t, `import { createHash } from 'node:crypto';
    process.stdout.write(JSON.stringify({ digest: createHash('sha256').update(process.env.FIXTURE_KEY || '').digest('hex'),
      argv: process.argv.slice(2), fullArgv: process.argv, execArgv: process.execArgv, other: process.env.SECOND_KEY, token: process.env.MEMORO_TOKEN }));`);
  const before = { ...process.env }; const incoming = { ...f.env };
  const result = await f.run(['--help', 'one', '--flag=two']);
  assert.equal(result.exit, 0, result.stderr);
  const received = JSON.parse(result.stdout);
  assert.equal(received.digest, digest(KEY));
  assert.deepEqual(received.argv, ['--help', 'one', '--flag=two']);
  assert.equal(received.other, undefined); assert.equal(received.token, undefined);
  assert.deepEqual({ ...process.env }, before); assert.deepEqual(f.env, incoming);
  const records = f.records();
  assert.equal(records.length, 2); assert.equal(records[1].exit, 0);
  assert.deepEqual(records[1].names, ['FIXTURE_KEY']); assert.match(records[1].content_hash, /^[a-f0-9]{64}$/u);
  assert.equal(records[1].script, 'script.mjs'); assert.ok(Date.parse(records[1].time));
  absent(JSON.stringify(result)); absent(JSON.stringify(records));
  for (const file of allFiles(f.directory)) absent(readFileSync(file).toString('utf8'));
  assert.ok(handlesHelp(['run', 'script.mjs', '--help']));
  assert.deepEqual(invocationShape(['keys', 'run', 'script.mjs', '--private-argument', 'opaque']), {
    verb: 'keys', sub: 'run', args: [], flags: [], argc: 5,
  });
  const scrubbed = scrubRuntimeSecretsFromEnv({ ...f.env, FIXTURE_KEY: KEY });
  assert.equal(scrubbed.FIXTURE_KEY, undefined);
  assert.equal(scrubRuntimeSecretsInPlace({ ...f.env, FIXTURE_KEY: KEY }).FIXTURE_KEY, undefined);
  // A second worktree uses the same global custody and needs no local setup.
  const worktree = join(f.directory, 'second'); git(f.root, ['worktree', 'add', '--detach', worktree, 'origin/main']);
  const again = await f.run([], 'script.mjs', { cwd: worktree });
  assert.equal(again.exit, 0, again.stderr); assert.equal(JSON.parse(again.stdout).digest, digest(KEY));
});

test('changed source gets no key', async t => {
  const f = await fixture(t, "import { message } from './helper.mjs'; process.stdout.write('started:' + message);", {
    sources: ['script.mjs', 'helper.mjs'], files: { 'helper.mjs': "export const message = 'main';" },
  });
  const original = readFileSync(join(f.root, 'script.mjs'), 'utf8');
  f.write('script.mjs', original + "process.stdout.write('edited');");
  let result = await f.run(); assert.equal(result.exit, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /differs from origin\/main/u);
  f.write('script.mjs', original); f.write('helper.mjs', "export const message = 'edited';");
  result = await f.run(); assert.equal(result.exit, 1); assert.equal(result.stdout, '');
  f.write('helper.mjs', "export const message = 'main';");
  result = await f.run([], 'undeclared.mjs'); assert.equal(result.exit, 1); assert.match(result.stderr, /undeclared/u);
  f.manifest.scripts['script.mjs'].keys.UNDECLARED_KEY = 'other'; f.write('.mc-keys.json', JSON.stringify(f.manifest));
  result = await f.run(); assert.equal(result.exit, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /manifest differs/u);
  assert.equal(f.reads(), 0, 'source refusal happens before custody opens');
  absent(JSON.stringify(f.records()));
});

test('a printed key never reaches the session', async t => {
  const f = await fixture(t, `const value = process.env.FIXTURE_KEY;
    const encoded = Buffer.from(value).toString('base64');
    process.stdout.write(value + ' ' + encoded + ' ');
    process.stderr.write(value + ' ' + encoded + ' ');
    for (const text of [value, encoded]) {
      for (const char of text) {
        process.stdout.write(char); process.stderr.write(char);
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      process.stdout.write(' '); process.stderr.write(' ');
    }
    throw new Error('failure includes ' + value);`);
  const result = await f.run();
  assert.equal(result.exit, 1); absent(result.stdout); absent(result.stderr);
  assert.equal(result.stdout, '[key:FIXTURE_KEY] [key:FIXTURE_KEY] [key:FIXTURE_KEY] [key:FIXTURE_KEY] ');
  assert.ok(result.stderr.match(/\[key:FIXTURE_KEY\]/gu).length >= 5);
  absent(JSON.stringify(f.records()));
});

test('a missing key or locked vault stops the run', async t => {
  const f = await fixture(t, "process.stdout.write('started');", { names: { FIXTURE_KEY: 'dotenv:fixture:FIXTURE_KEY', MISSING_KEY: 'not-held' } });
  let result = await f.run();
  assert.equal(result.exit, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /missing key: MISSING_KEY/u); absent(JSON.stringify(result));
  f.lock(); result = await f.run();
  assert.equal(result.exit, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /vault locked/u); assert.match(result.stderr, /FIXTURE_KEY, MISSING_KEY/u);
  absent(JSON.stringify(result)); assert.ok(f.records().every(row => row.exit === 1));
});

test('list reports only names and whether envelope custody holds them', async t => {
  const f = await fixture(t, 'process.exit(0);');
  const stdout = capture(); const stderr = capture();
  assert.equal(await listScriptKeys({ cwd: f.root, env: f.env, vaultDeps: f.vaultDeps, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(stdout.text(), 'FIXTURE_KEY  held\nSECOND_KEY  held\n'); absent(stdout.text()); assert.equal(stderr.text(), '');
  f.lock(); const locked = capture();
  assert.equal(await listScriptKeys({ cwd: f.root, env: f.env, vaultDeps: f.vaultDeps, stdout: locked.stream, stderr: stderr.stream }), 1);
  assert.match(locked.text(), /unknown \(vault locked or unavailable\)/u); absent(locked.text());
});

test('the loader rejects unlisted static imports before the script executes', async t => {
  const f = await fixture(t, "import './unlisted.mjs'; process.stdout.write('started');", { files: { 'unlisted.mjs': "process.stdout.write('unlisted started');" } });
  const result = await f.run();
  assert.equal(result.exit, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /outside committed source closure/u); absent(result.stderr);
});

test('CommonJS require is restricted to the committed source closure too', async t => {
  const f = await fixture(t, "import './helper.cjs'; process.stdout.write('started');", {
    sources: ['script.mjs', 'helper.cjs'], files: { 'helper.cjs': "require('./unlisted.cjs');", 'unlisted.cjs': "process.stdout.write(process.env.FIXTURE_KEY);" },
  });
  const result = await f.run();
  assert.equal(result.exit, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /outside committed source closure/u); absent(result.stderr);
});

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

test('changed package metadata, symlinks and unlanded source fail closed', async t => {
  const f = await fixture(t, "process.stdout.write('started');");
  f.write('package.json', '{"type":"commonjs"}');
  let result = await f.run(); assert.equal(result.exit, 1); assert.equal(result.stdout, '');
  f.write('package.json', '{"type":"module"}');
  f.write('new.mjs', "process.stdout.write('new');");
  result = await f.run([], 'new.mjs'); assert.equal(result.exit, 1); assert.equal(result.stdout, '');
  const mainSource = readFileSync(join(f.root, 'script.mjs'));
  f.write('saved.mjs', mainSource); unlinkSync(join(f.root, 'script.mjs'));
  symlinkSync('saved.mjs', join(f.root, 'script.mjs'));
  result = await f.run(); assert.equal(result.exit, 1); assert.equal(result.stdout, '');
  assert.equal(f.reads(), 0);
});


test('registered arbitrary dotenv names are scrubbed globally without storing values', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mc-key-names-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { MC_HOME: directory, banana: KEY, ['long_' + 'x'.repeat(300)]: KEY, TERM: 'xterm' };
  rememberRuntimeSecretNames(['banana', 'long_' + 'x'.repeat(300)], env);
  assert.deepEqual(scrubRuntimeSecretsFromEnv(env), { MC_HOME: directory, TERM: 'xterm' });
  assert.deepEqual(scrubProviderApiKeysFromEnv(env), { MC_HOME: directory, TERM: 'xterm' }, 'interactive, helper and mend sessions scrub registered script names too');
  for (const file of allFiles(directory)) absent(readFileSync(file, 'utf8'));
  writeFileSync(join(directory, 'runtime-secret-names', 'invalid'), '');
  assert.throws(() => scrubRuntimeSecretsFromEnv(env), /cannot read script-key name registry/u);
});
