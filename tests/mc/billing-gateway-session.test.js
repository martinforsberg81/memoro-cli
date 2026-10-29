import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBillingGateway } from '../../src/mc/billing-gateway.js';
import { gatewayToolConfig, runGatewaySession } from '../../src/mc/billing-gateway-session.js';

test('tool settings carry only a bounded gateway grant, never a provider key', () => {
  const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'provider-secret', OPENAI_API_KEY: 'other-provider-secret', GH_TOKEN: 'github-secret' };
  const claude = gatewayToolConfig({ provider: 'claude', base: 'http://127.0.0.1:1234', grant: 'session-grant', args: ['-p', 'hello'], env });
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.env.OPENAI_API_KEY, undefined);
  assert.equal(claude.env.GH_TOKEN, undefined);
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'session-grant');
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234/claude');
  const codex = gatewayToolConfig({ provider: 'codex', base: 'http://127.0.0.1:1234', grant: 'session-grant', args: ['exec', '--json'], env });
  assert.equal(codex.env.OPENAI_API_KEY, undefined);
  assert.equal(codex.env.MC_GATEWAY_GRANT, 'session-grant');
  assert.ok(codex.args.includes('model_providers.mc_api.supports_websockets=false'));
  assert.equal(codex.args.at(-2), 'exec');
});

test('a gateway session can call its provider without seeing the provider key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-gateway-session-'));
  const bin = join(dir, 'fake-tool.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
const env = process.env;
if (env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.MC_VAULT_PASSPHRASE) process.exit(2);
const res = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + env.ANTHROPIC_AUTH_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
});
process.exit(res.status === 200 ? 0 : 3);
`, { mode: 0o700 });
  const result = await runGatewaySession({
    provider: 'claude', model: 'opus', bin, args: [],
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'provider-secret', MC_VAULT_PASSPHRASE: 'vault-secret' },
    readKey: async () => ({ ok: true, key: 'provider-secret' }),
    createGateway: ({ keys, grants }) => createBillingGateway({ keys, grants, fetchImpl: async () => new Response('ok') }),
  });
  assert.equal(result, 0, 'the fake tool received no key and the gateway accepted its Claude model');
});
