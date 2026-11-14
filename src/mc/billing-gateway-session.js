#!/usr/bin/env node
/**
 * Trusted API-session wrapper. It opens one fixed provider key from mc vault,
 * keeps it in this process, and runs the coding tool against a loopback gateway.
 * The tool receives only an expiring, request-limited gateway grant.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';

import { readBillingApiKey } from '../vault/engine/step-credit-key.js';
import { readBillingApi } from './billing.js';
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
        '-c', 'model_providers.mc_api.supports_websockets=true',
        ...args,
      ],
      env: { ...clean, MC_GATEWAY_GRANT: grant },
    };
  }
  throw new Error('unsupported billing provider');
}

/** The trusted key-opening boundary shared by foreground wrappers and detached holders. */
export async function openGatewayGrant({ provider, model = '*', readKey = readBillingApiKey,
  readApi = () => readBillingApi(), createGateway = createBillingGateway,
  listen = listenBillingGateway, now = Date.now, token = () => randomBytes(32).toString('hex'),
} = {}) {
  // The switch is read again here, where the key is opened: a launch decided
  // before `mc run --billing <provider> off` still never reaches the API.
  if (readApi()?.[provider] === false) {
    process.stderr.write(`mc: ${provider} API is off (mc run --billing ${provider} on)\n`);
    return { ok: false };
  }
  const opened = await readKey(provider);
  if (!opened?.ok || !opened.key) {
    process.stderr.write(`mc: ${provider} API reserve unavailable (${opened?.reason || 'key-unreadable'})\n`);
    return { ok: false };
  }
  const grant = token();
  const expiresAt = new Date(now() + GATEWAY_SESSION_MS).toISOString();
  const keys = { [provider]: opened.key };
  const gateway = createGateway({
    keys,
    grants: [{ provider, token: grant, models: [model], maxRequests: GATEWAY_SESSION_REQUEST_LIMIT, expiresAt }],
  });
  try {
    const base = await listen(gateway);
    return { ok: true, base, grant, expiresAt,
      close: async () => {
        await new Promise(resolve => gateway.close(resolve));
        keys[provider] = null;
      },
    };
  } catch (error) {
    keys[provider] = null;
    gateway.close();
    throw error;
  }
}

/** Runs until the coding tool exits; never returns the provider key. */
export async function runGatewaySession({ provider, model, bin, args, env = process.env, readKey = readBillingApiKey, readApi = () => readBillingApi(), spawnTool = spawn, createGateway = createBillingGateway, terminal = isatty(1),
  sessionDirectory = null, openGrant = openGatewayGrant, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (!['claude', 'codex'].includes(provider) || !bin || !Array.isArray(args) || !model) return 2;
  const session = await openGrant({ provider, model, readKey, readApi, createGateway, now });
  if (!session.ok) return 1;
  let child;
  let childExited = false;
  let expiryTimer;
  let expired = false;
  try {
    const tool = gatewayToolConfig({ provider, base: session.base, grant: session.grant, args, env });
    return await new Promise((resolve) => {
      // A terminal is handed over whole. Otherwise (the runner's pipes) the tool
      // gets pipes of its own: codex sharing this process's stdout panicked
      // with EAGAIN on 2026-10-29 (os error 35) and the step was lost.
      child = spawnTool(bin, tool.args, { env: tool.env, stdio: terminal ? 'inherit' : ['inherit', 'pipe', 'pipe'] });
      activeChild = child;
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
      child.once('error', () => resolve(1));
      child.once('close', (code, signal) => {
        childExited = true;
        resolve(signal ? 128 + (signal === 'SIGTERM' ? 15 : 2) : code ?? 1);
      });
      if (sessionDirectory) expiryTimer = setTimer(() => {
        expired = true;
        child.kill('SIGTERM');
      }, Math.max(0, Date.parse(session.expiresAt) - now()));
    });
  } finally {
    if (expiryTimer !== undefined) clearTimer(expiryTimer);
    if (child?.pid && !childExited) { try { child.kill('SIGTERM'); } catch {} }
    if (activeChild === child) activeChild = null;
    await session.close();
    if (sessionDirectory) {
      const { finishCodexGatewaySession } = await import('./codex-sessions.js');
      finishCodexGatewaySession(sessionDirectory, { expired, env });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const sessionDirectory = argv[0] === '--session-directory' ? (argv.shift(), argv.shift()) : null;
  const [provider, model, bin, ...args] = argv;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (activeChild?.pid) activeChild.kill(signal);
      else process.exitCode = signal === 'SIGTERM' ? 143 : 130;
    });
  }
  process.exitCode = await runGatewaySession({ provider, model, bin, args, sessionDirectory });
}
