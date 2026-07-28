#!/usr/bin/env node
/**
 * Minimal provider SessionStart bridge used by the isolated managed Codex
 * domain. Keep this file dependency-free apart from Node built-ins: its exact
 * bytes and interpreter are hash-bound before hook trust is bypassed.
 */
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';

const MAX_STDIN_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024;
const TIMEOUT_MS = 1_000;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildProviderArtifactHookRequest({ tool, env, event } = {}) {
  if (tool !== 'codex' && tool !== 'claude-code') return null;
  if (env?.MEMORO_MC_PARENT !== '1'
    || !ID.test(env.MC_CODING_SESSION_ID || '')
    || !UUID_V4.test(env.MC_RUNTIME_GENERATION || '')
    || !absolutePath(env.MC_PROVIDER_ARTIFACT_SOCKET)) return null;
  if (event?.hook_event_name !== 'SessionStart'
    || !ID.test(event.session_id || '')
    || !absolutePath(event.transcript_path)
    || !absolutePath(event.cwd)) return null;
  return {
    socketPath: env.MC_PROVIDER_ARTIFACT_SOCKET,
    message: {
      type: 'capture_provider_artifact',
      id: env.MC_CODING_SESSION_ID,
      runtime_generation: env.MC_RUNTIME_GENERATION,
      tool,
      cwd: event.cwd,
      provider_session_id: event.session_id,
      transcript_path: event.transcript_path,
    },
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const tool = parseTool(argv);
  if (env.MEMORO_MC_PARENT !== '1') return 0;
  const event = await readBoundedJson(process.stdin);
  const request = buildProviderArtifactHookRequest({ tool, env, event });
  if (!request) return 1;
  const response = await sendBrokerRequest(request).catch(() => null);
  return response?.ok === true ? 0 : 1;
}

async function readBoundedJson(stream) {
  if (stream.isTTY) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += value.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendBrokerRequest({ socketPath, message }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let raw = '';
    let socket = null;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.removeAllListeners();
      try { socket?.destroy(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('timeout')), TIMEOUT_MS);
    timer.unref?.();
    try { socket = createConnection(socketPath); } catch (error) {
      done(error);
      return;
    }
    socket.setEncoding('utf8');
    socket.on('error', (error) => done(error));
    socket.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) done(new Error('oversized response'));
    });
    socket.on('end', () => {
      try { done(null, JSON.parse(raw || '{}')); } catch (error) { done(error); }
    });
    socket.on('connect', () => socket.end(`${JSON.stringify(message)}\n`));
  });
}

function parseTool(argv) {
  const index = argv.indexOf('--tool');
  return index >= 0 ? argv[index + 1] || null : null;
}

function absolutePath(value) {
  return typeof value === 'string'
    && value.startsWith('/')
    && value.length <= 2048
    && !/[\0-\x1f\x7f]/.test(value);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
