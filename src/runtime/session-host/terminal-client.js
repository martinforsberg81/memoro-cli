import { EventEmitter } from 'node:events';

import { inspectSessionRuntimeSync } from '../../mc/session-runtime-journal.js';
import { SessionRuntimeClient } from './client.js';

export async function attachLocalSessionTerminal({
  mcHomeDir,
  mcSessionId,
  generationId = null,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  clientFactory = (options) => new SessionRuntimeClient(options),
} = {}) {
  const identity = resolveRuntimeIdentity({ mcHomeDir, mcSessionId, generationId });
  if (!identity.ok) {
    stderr.write(`mc: session runtime is not attachable (${identity.reason})\n`);
    return { ok: false, code: 1, reason: identity.reason };
  }
  const client = clientFactory({
    mcHomeDir,
    mcSessionId,
    generationId: identity.generationId,
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    output: stdout,
  });
  let raw = false;
  const onInput = (chunk) => client.input(chunk);
  const onResize = () => client.resize(stdout.columns || 80, stdout.rows || 24);
  try {
    await client.connect();
    if (stdin.isTTY) {
      try { stdin.setRawMode(true); raw = true; } catch {}
    }
    stdin.resume?.();
    stdin.on?.('data', onInput);
    stdout.on?.('resize', onResize);
    const terminal = await waitForTerminal(client);
    return {
      ok: terminal.kind === 'exit',
      code: terminal.kind === 'exit' ? (terminal.frame.exit_code || 0) : 1,
      reason: terminal.kind,
      exit: terminal.kind === 'exit' ? terminal.frame : null,
    };
  } catch (error) {
    stderr.write(`mc: attach failed (${error?.reason || error?.message || 'unknown'})\n`);
    return { ok: false, code: 1, reason: error?.reason || 'attach-failed' };
  } finally {
    stdin.off?.('data', onInput);
    stdout.off?.('resize', onResize);
    if (raw && stdin.isTTY) {
      try { stdin.setRawMode(false); } catch {}
    }
    try { stdin.pause?.(); } catch {}
    try { client.detach(); } catch {}
  }
}

export async function sendLocalSessionInput({
  mcHomeDir,
  mcSessionId,
  generationId = null,
  message,
  tool = null,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clientFactory = (options) => new SessionRuntimeClient(options),
} = {}) {
  if (typeof message !== 'string' || !message.trim()) {
    return { ok: false, reason: 'message-required' };
  }
  const identity = resolveRuntimeIdentity({ mcHomeDir, mcSessionId, generationId });
  if (!identity.ok) return identity;
  const client = clientFactory({
    mcHomeDir,
    mcSessionId,
    generationId: identity.generationId,
    output: new NullOutput(),
  });
  try {
    await client.connect();
    client.input(`${message}\r`);
    if (tool === 'codex') {
      await wait(120);
      client.input('\r');
    }
    return { ok: true, mc_session_id: mcSessionId, generation_id: identity.generationId };
  } catch (error) {
    return { ok: false, reason: error?.reason || 'runtime-host-unreachable' };
  } finally {
    try { client.detach(); } catch {}
  }
}

export async function readLocalSessionScreen({
  mcHomeDir,
  mcSessionId,
  generationId = null,
  last = null,
  clientFactory = (options) => new SessionRuntimeClient(options),
} = {}) {
  const identity = resolveRuntimeIdentity({ mcHomeDir, mcSessionId, generationId });
  if (!identity.ok) return identity;
  const output = new CollectingOutput();
  const client = clientFactory({
    mcHomeDir,
    mcSessionId,
    generationId: identity.generationId,
    output,
  });
  try {
    await client.connect();
    const full = output.text();
    const text = Number.isSafeInteger(last) && last >= 0
      ? full.split('\n').slice(-last).join('\n')
      : full;
    return {
      ok: true,
      mc_session_id: mcSessionId,
      generation_id: identity.generationId,
      text,
    };
  } catch (error) {
    return { ok: false, reason: error?.reason || 'runtime-host-unreachable' };
  } finally {
    try { client.detach(); } catch {}
  }
}

function resolveRuntimeIdentity({ mcHomeDir, mcSessionId, generationId }) {
  if (generationId) return { ok: true, generationId };
  const runtime = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  if (runtime.kind !== 'present') return { ok: false, reason: runtime.reason || runtime.kind };
  const active = runtime.active_generation;
  if (!active || !['accepted', 'live'].includes(active.phase)) {
    return { ok: false, reason: 'runtime-not-live' };
  }
  return { ok: true, generationId: active.intent.generation_id };
}

function waitForTerminal(client) {
  if (client.exitFrame) {
    return Promise.resolve({ kind: 'exit', frame: client.exitFrame });
  }
  if (client.closed) return Promise.resolve({ kind: 'closed' });
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    client.once('exit', (frame) => finish({ kind: 'exit', frame }));
    client.once('close', () => finish({ kind: 'closed' }));
    client.once('error', (error) => finish({ kind: error?.reason || 'error', error }));
  });
}

class NullOutput extends EventEmitter {
  write() { return true; }
}

class CollectingOutput extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
