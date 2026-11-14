import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
  assert.ok(codex.args.includes('model_providers.mc_api.supports_websockets=true'));
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
    readApi: () => ({ claude: true, codex: true }),
    createGateway: ({ keys, grants }) => createBillingGateway({ keys, grants, fetchImpl: async () => new Response('ok') }),
  });
  assert.equal(result, 0, 'the fake tool received no key and the gateway accepted its Claude model');
});

test('each provider receives one exact-model grant bounded to 500 requests and 12 hours', async () => {
  const twelveHours = 12 * 60 * 60 * 1000;
  for (const { provider, model, keyEnvName, grantEnvName } of [
    { provider: 'claude', model: 'opus', keyEnvName: 'claude', grantEnvName: 'ANTHROPIC_AUTH_TOKEN' },
    { provider: 'codex', model: 'gpt-6-astra', keyEnvName: 'codex', grantEnvName: 'MC_GATEWAY_GRANT' },
  ]) {
    let captured;
    let childEnv;
    const before = Date.now();
    const result = await runGatewaySession({
      provider, model, bin: process.execPath, args: [], terminal: false,
      readKey: async () => ({ ok: true, key: `${provider}-provider-secret` }),
      readApi: () => ({ claude: true, codex: true }),
      createGateway: (input) => {
        captured = input;
        return createBillingGateway(input);
      },
      spawnTool: (_bin, _args, options) => {
        childEnv = options.env;
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
    });
    const after = Date.now();
    assert.equal(result, 0);
    assert.deepEqual(Object.keys(captured.keys), [keyEnvName], 'only the selected provider key enters the gateway');
    assert.equal(captured.grants.length, 1);
    const [grant] = captured.grants;
    assert.equal(grant.provider, provider);
    assert.deepEqual(grant.models, [model], 'the grant contains exactly the selected model, never a wildcard');
    assert.ok(!grant.models.includes('*'));
    assert.ok(Number.isFinite(grant.maxRequests) && grant.maxRequests > 0);
    assert.equal(grant.maxRequests, 500);
    const expiry = Date.parse(grant.expiresAt);
    assert.ok(Number.isFinite(expiry));
    assert.ok(expiry >= before + twelveHours, 'expiry is no earlier than twelve hours after invocation began');
    assert.ok(expiry <= after + twelveHours, 'expiry is no later than twelve hours after invocation ended');
    assert.equal(childEnv[grantEnvName], grant.token, 'the child receives the exact grant token');
  }
});

test('API off: the key is never opened and the tool never starts', async () => {
  let opened = false;
  let spawned = false;
  const result = await runGatewaySession({
    provider: 'codex', model: 'gpt-6-astra', bin: '/bin/false', args: [],
    readKey: async () => { opened = true; return { ok: true, key: 'k' }; },
    readApi: () => ({ claude: true, codex: false }),
    spawnTool: () => { spawned = true; throw new Error('must not spawn'); },
  });
  assert.equal(result, 1);
  assert.equal(opened, false);
  assert.equal(spawned, false);
});

test('off a terminal the tool gets pipes of its own, not this process\'s stdout', async () => {
  let stdio = null;
  const result = await runGatewaySession({
    provider: 'claude', model: 'opus', bin: process.execPath, args: ['-e', ''], terminal: false,
    readKey: async () => ({ ok: true, key: 'k' }),
    readApi: () => ({}),
    spawnTool: (bin, args, options) => { stdio = options.stdio; return spawn(bin, ['-e', ''], options); },
  });
  assert.equal(result, 0);
  assert.deepEqual(stdio, ['inherit', 'pipe', 'pipe']);
});

test('sessionDirectory opts a detached server into grant-expiry stop; ordinary wrappers have no expiry timer and cancel nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mc-gateway-expiry-'));
  try {
    for (const sessionDirectory of [null, directory]) {
      const child = new EventEmitter();
      child.pid = 123;
      const signals = [];
      child.kill = signal => { signals.push(signal); child.emit('close', null, signal); };
      let timer;
      let cancelled;
      let closed = false;
      const result = runGatewaySession({ provider: 'codex', model: '*', bin: 'resolved-codex', args: [], sessionDirectory,
        now: () => 100,
        openGrant: async () => ({ ok: true, grant: 'bounded-grant', base: 'http://gateway', expiresAt: new Date(150).toISOString(),
          close: async () => { closed = true; } }),
        spawnTool: () => child,
        setTimer: (fire, ms) => { timer = { fire, ms }; return timer; }, clearTimer: handle => { cancelled = handle; },
      });
      await new Promise(resolve => setImmediate(resolve));
      if (sessionDirectory) {
        assert.equal(timer.ms, 50);
        timer.fire();
        assert.equal(await result, 143);
        assert.deepEqual(signals, ['SIGTERM']);
        assert.equal(cancelled, timer);
      } else {
        assert.equal(timer, undefined);
        child.emit('close', 0, null);
        assert.equal(await result, 0);
        assert.deepEqual(signals, []);
        assert.equal(cancelled, undefined);
      }
      assert.equal(closed, true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
