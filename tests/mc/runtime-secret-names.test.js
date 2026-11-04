import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rememberRuntimeSecretNames, scrubProviderApiKeysFromEnv, scrubRuntimeSecretsFromEnv } from '../../src/mc/runtime-secrets.js';

// The name registry mc keys run writes for every delivered dotenv name. Values
// are synthetic; the registry must hold names only.
const SECRET = 'fixture-only-å-registry-secret-0123456789';

function allFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? allFiles(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function absent(text) {
  assert.ok(!text.includes(SECRET)); assert.ok(!text.includes(Buffer.from(SECRET).toString('base64')));
}

test('registered arbitrary dotenv names are scrubbed globally without storing values', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mc-key-names-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { MC_HOME: directory, banana: SECRET, ['long_' + 'x'.repeat(300)]: SECRET, TERM: 'xterm' };
  rememberRuntimeSecretNames(['banana', 'long_' + 'x'.repeat(300)], env);
  assert.deepEqual(scrubRuntimeSecretsFromEnv(env), { MC_HOME: directory, TERM: 'xterm' });
  assert.deepEqual(scrubProviderApiKeysFromEnv(env), { MC_HOME: directory, TERM: 'xterm' }, 'interactive, helper and mend sessions scrub registered script names too');
  for (const file of allFiles(directory)) absent(readFileSync(file, 'utf8'));
  writeFileSync(join(directory, 'runtime-secret-names', 'invalid'), '');
  assert.throws(() => scrubRuntimeSecretsFromEnv(env), /cannot read script-key name registry/u);
});

test('a name registered over a crashed empty entry reads back, and no partial file stays', t => {
  const home = mkdtempSync(join(tmpdir(), 'mc-key-names-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { MC_HOME: home };
  rememberRuntimeSecretNames(['SERVICE_TOKEN'], env);
  const [directory] = readdirSync(home);
  const [entry] = readdirSync(join(home, directory));
  writeFileSync(join(home, directory, entry), '');
  rememberRuntimeSecretNames(['SERVICE_TOKEN'], env);
  assert.equal(scrubRuntimeSecretsFromEnv({ ...env, SERVICE_TOKEN: 'x' }).SERVICE_TOKEN, undefined);
  assert.deepEqual(readdirSync(home), [directory]);
});
