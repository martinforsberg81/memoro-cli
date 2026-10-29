#!/usr/bin/env node
/**
 * Trusted API-session wrapper. It opens one fixed provider key from mc vault,
 * keeps it in this process, and runs the coding tool against a loopback gateway.
 * The tool receives only an expiring, request-limited gateway grant.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readBillingApiKey } from '../vault/engine/step-credit-key.js';
import { scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';
import { createBillingGateway, listenBillingGateway } from './billing-gateway.js';

export const GATEWAY_SESSION_REQUEST_LIMIT = 500;
export const GATEWAY_SESSION_MS = 12 * 60 * 60 * 1000;
let activeChild = null;

/** Tool-facing settings, with no provider secret. */
export function gatewayToolConfig({ provider, base, grant, args, env = process.env }) {
  const clean = scrubRuntimeSecretsFromEnv(env);
  if (provider === 'claude') {
    return {
      args,
      env: { ...clean, ANTHROPIC_BASE_URL: `${base}/claude`, ANTHROPIC_AUTH_TOKEN: grant },
    };
  }
  if (provider === 'codex') {
    return {
      args: [
        '-c', 'model_provider="mc_api"',
        '-c', 'model_providers.mc_api.name="MC API gateway"',
        '-c', `model_providers.mc_api.base_url="${base}/codex/v1"`,
        '-c', 'model_providers.mc_api.env_key="MC_GATEWAY_GRANT"',
        '-c', 'model_providers.mc_api.wire_api="responses"',
        '-c', 'model_providers.mc_api.requires_openai_auth=false',
        '-c', 'model_providers.mc_api.supports_websockets=false',
        ...args,
      ],
      env: { ...clean, MC_GATEWAY_GRANT: grant },
    };
  }
  throw new Error('unsupported billing provider');
}

/** Runs until the coding tool exits; never returns the provider key. */
export async function runGatewaySession({ provider, model, bin, args, env = process.env, readKey = readBillingApiKey, spawnTool = spawn, createGateway = createBillingGateway } = {}) {
  if (!['claude', 'codex'].includes(provider) || !bin || !Array.isArray(args) || !model) return 2;
  const opened = await readKey(provider);
  if (!opened?.ok || !opened.key) {
    process.stderr.write(`mc: ${provider} API reserve unavailable (${opened?.reason || 'key-unreadable'})\n`);
    return 1;
  }
  const grant = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + GATEWAY_SESSION_MS).toISOString();
  const keys = { [provider]: opened.key };
  const gateway = createGateway({
    keys,
    grants: [{ provider, token: grant, models: [model], maxRequests: GATEWAY_SESSION_REQUEST_LIMIT, expiresAt }],
  });
  let child;
  try {
    const base = await listenBillingGateway(gateway);
    const tool = gatewayToolConfig({ provider, base, grant, args, env });
    return await new Promise((resolve) => {
      child = spawnTool(bin, tool.args, { env: tool.env, stdio: 'inherit' });
      activeChild = child;
      child.once('error', () => resolve(1));
      child.once('close', (code, signal) => resolve(signal ? 128 + (signal === 'SIGTERM' ? 15 : 2) : code ?? 1));
    });
  } finally {
    if (child?.pid) { try { child.kill('SIGTERM'); } catch {} }
    if (activeChild === child) activeChild = null;
    await new Promise((resolve) => gateway.close(resolve));
    keys[provider] = null;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [provider, model, bin, ...args] = process.argv.slice(2);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (activeChild?.pid) activeChild.kill(signal);
      else process.exitCode = signal === 'SIGTERM' ? 143 : 130;
    });
  }
  process.exitCode = await runGatewaySession({ provider, model, bin, args });
}
