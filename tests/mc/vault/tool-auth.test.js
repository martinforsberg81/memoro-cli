/** S3 (docs/plans/mc-custody.md): portable tool sign-in via custody. */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { importVaultKey } from '../../../src/mc/vault/client-crypto.js';
import { decryptEnvelopeSecret } from '../../../src/mc/vault/custody-crypto.js';
import { encryptForWrite } from '../../../src/mc/vault/custody-session.js';
import {
  captureToolAuth,
  hydrateToolAuth,
  resolveToolAuthSpec,
} from '../../../src/mc/vault/tool-auth.js';

const BODY = '{"claudeAiOauth":{"accessToken":"fake-for-test"}}';

describe('tool-auth capture', () => {
  test('claude on macOS prefers the Keychain, falls back to the file', () => {
    const viaKeychain = captureToolAuth('claude', {
      platform: 'darwin',
      readKeychain: () => BODY,
      exists: () => { throw new Error('file path must not be consulted'); },
    });
    assert.equal(viaKeychain.ok, true);
    assert.deepEqual(viaKeychain.payload, {
      kind: 'tool_auth', tool: 'claude-code', source: 'keychain', body: BODY,
    });
    assert.equal(viaKeychain.label, 'tool-auth:claude-code');

    const viaFile = captureToolAuth('claude', {
      platform: 'darwin',
      readKeychain: () => null,
      exists: () => true,
      readFile: () => BODY,
    });
    assert.equal(viaFile.payload.source, 'file');
  });

  test('codex reads its auth file; a missing sign-in fails with guidance', () => {
    const ok = captureToolAuth('codex', {
      platform: 'linux', exists: () => true, readFile: () => '{"t":1}',
    });
    assert.equal(ok.payload.tool, 'codex');
    const missing = captureToolAuth('codex', { platform: 'linux', exists: () => false });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /sign in to the tool first/);
  });

  test('unknown tools are refused; claude aliases to claude-code', () => {
    assert.equal(captureToolAuth('gemini', {}).ok, false);
    assert.equal(resolveToolAuthSpec('claude').id, 'claude-code');
  });
});

describe('tool-auth hydrate', () => {
  test('writes 0600, creates the directory, refuses overwrite without force', () => {
    const writes = [];
    const deps = {
      exists: () => false,
      mkdir: (d) => writes.push({ mkdir: d }),
      writeFile: (p, body, o) => writes.push({ path: p, body, mode: o.mode }),
      chmod: () => {},
      authPathOverride: '/fake/.claude/.credentials.json',
    };
    const payload = { kind: 'tool_auth', tool: 'claude-code', source: 'keychain', body: BODY };
    const res = hydrateToolAuth(payload, deps);
    assert.equal(res.ok, true);
    assert.equal(writes[0].mkdir, '/fake/.claude');
    assert.equal(writes[1].mode, 0o600);
    assert.equal(writes[1].body, BODY);

    const refused = hydrateToolAuth(payload, { ...deps, exists: () => true });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'already-signed-in');
    const forced = hydrateToolAuth(payload, { ...deps, exists: () => true, force: true });
    assert.equal(forced.ok, true);
  });

  test('rejects non-tool-auth payloads (a repurposed secret cannot become a login)', () => {
    assert.equal(hydrateToolAuth({ kind: 'api_token', body: 'x' }, {}).ok, false);
    assert.equal(hydrateToolAuth({ kind: 'tool_auth', tool: 'nope', body: 'x' }, {}).ok, false);
  });
});

describe('custody round-trip', () => {
  test('capture → envelope (tool-auth class) → decrypt → hydrate', async () => {
    const crk = await importVaultKey(new Uint8Array(32).fill(4));
    const captured = captureToolAuth('claude', {
      platform: 'darwin', readKeychain: () => BODY,
    });
    const enc = await encryptForWrite({
      vaultKey: null, crk, label: captured.label, data: captured.payload, secretClass: 'tool-auth',
    });
    assert.equal(enc.secretClass, 'tool-auth');
    const { data } = await decryptEnvelopeSecret(crk, {
      encrypted_label: enc.encryptedLabel, label_iv: enc.labelIv,
      encrypted_data: enc.encryptedData, iv: enc.iv,
      wrapped_dek: enc.wrappedDek, dek_iv: enc.dekIv, class: enc.secretClass,
    });
    const written = [];
    const res = hydrateToolAuth(data, {
      exists: () => false, mkdir: () => {}, chmod: () => {},
      writeFile: (p, body) => written.push(body),
      authPathOverride: '/fake/.claude/.credentials.json',
    });
    assert.equal(res.ok, true);
    assert.equal(written[0], BODY, 'the artifact survives custody byte-for-byte');
  });
});
