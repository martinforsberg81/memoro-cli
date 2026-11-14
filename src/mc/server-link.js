/** The only SSH boundary: the person's OpenSSH, never keys, agents or SSH configuration. */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { workRoot } from './paths.js';
import { terminalEnvironment } from './session-entrance.js';
import { MC_VERSION, validateDescriptor } from './server-protocol.js';

import { sshDestination } from './server-settings.js';
export { sshDestination, readServer, saveServer, clearServer } from './server-settings.js';

const refusal = message => { throw new Error(message); };

/** OpenSSH sends one shell command, not an argv vector. Quote every word once here. */
export function remoteCommand(argv) {
  return argv.map(arg => {
    if (typeof arg !== 'string' || arg.includes('\0')) refusal('remote arguments must be strings without NUL');
    return `'${arg.replaceAll("'", "'\\''")}'`;
  }).join(' ');
}

export function serverLink(destination, {
  env = process.env, io = fs, spawnProcess = spawn, run = spawnSync, now = Date.now, sleep = delay, stderr = process.stderr,
} = {}) {
  sshDestination(destination);
  const options = { env: terminalEnvironment(env) };
  const prefix = message => `on ${destination}: ${message}`;
  const decode = text => {
    let value;
    try { value = JSON.parse(text); } catch { refusal(`ssh ${destination}: mc returned invalid JSON`); }
    validateDescriptor(value, { destination, localVersion: MC_VERSION });
    if (value.kind === 'refusal') refusal(prefix(value.reason));
    return value;
  };
  const command = (operation, entrance, args, answers) => ['mc', 'session', operation,
    ...(entrance ? [entrance] : []), ...args, '--json', '--answers', JSON.stringify(answers)];
  function request(operation, entrance = null, args = [], answers = []) {
    const result = run('ssh', [destination, remoteCommand(command(operation, entrance, args, answers))],
      { ...options, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 });
    // A server refusal is structured even when mc exits nonzero.
    if (result.stdout?.trim()) {
      const value = decode(result.stdout);
      if (!result.error && result.status === 0) return value;
    }
    refusal(`ssh ${destination}: ${result.error?.message || result.stderr?.trim() || `exited ${result.status ?? result.signal ?? 'unknown'}`}`);
  }
  function passthrough(operation, entrance, args = [], answers = []) {
    const result = run('ssh', ['-t', destination, remoteCommand(['mc', 'session', operation, entrance, ...args,
      '--answers', JSON.stringify(answers), '--host', destination])], { ...options, stdio: 'inherit' });
    return { status: result.status ?? 1, signal: result.signal, error: result.error };
  }

  /** Keep a server-side mc client registration for precisely this connection's lifetime. */
  async function connect(operation, entrance, args = [], answers = []) {
    const child = spawnProcess('ssh', [destination, remoteCommand(command(operation, entrance, args, answers))],
      { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = ''; let response; let problem; let exited = false;
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (response || problem) return;
      output += chunk;
      if (Buffer.byteLength(output) > 1 << 20) { problem = new Error(`ssh ${destination}: descriptor exceeds 1 MiB`); return; }
      if (output.includes('\n')) {
        try { response = decode(output.slice(0, output.indexOf('\n'))); } catch (error) { problem = error; }
      }
    });
    child.once('error', error => { problem = new Error(`ssh ${destination}: ${error.message}`); });
    child.once('close', (status, signal) => {
      exited = true;
      resolveClosed({ status: status ?? 1, signal });
      if (!response && !problem) problem = new Error(`ssh ${destination}: ${errors.trim() || `exited ${status ?? signal}`}`);
    });
    const waitFor = async (done, ms) => {
      for (const deadline = now() + ms; !done();) {
        if (now() >= deadline) return false;
        await sleep(25);
      }
      return true;
    };
    const abort = async () => {
      child.stdin.destroy();
      if (!exited) {
        child.kill('SIGTERM');
        if (!await waitFor(() => exited, 5000)) {
          child.kill('SIGKILL');
          await waitFor(() => exited, 1000);
        }
      }
    };
    try {
      if (!await waitFor(() => response || problem, 30_000)) refusal(`ssh ${destination}: no session descriptor within 30000 ms`);
      if (problem) throw problem;
      if (response.kind !== 'session') refusal(`ssh ${destination}: expected a session descriptor, got ${response.kind}`);
      return { session: response, closed, finish: async clean => {
        child.stdin.end(clean && !exited ? 'end\n' : '');
        if (!await waitFor(() => exited, 30_000)) {
          await abort();
          refusal(`ssh ${destination}: session connection did not close within 30000 ms`);
        }
        if (errors.trim()) stderr.write(`${errors.trim().split('\n').map(line => prefix(line.replace(/^mc: /u, ''))).join('\n')}\n`);
        return await closed;
      }, abort };
    } catch (error) { await abort(); throw error; }
  }

  async function tunnel(remote) {
    const root = join(resolve(workRoot(env)), 'runner', 's');
    io.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = io.mkdtempSync(join(root, 'c-'));
    let child;
    let lost = false;
    let closed = false;
    let reason = null;
    let completion;
    const cleanup = async () => {
      if (child && !closed) { child.kill('SIGTERM'); await completion; }
      io.rmSync(directory, { recursive: true, force: true });
    };
    try {
      io.chmodSync(directory, 0o700);
      const stat = io.statSync(directory);
      if ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) refusal(`local tunnel directory is not private: mode ${(stat.mode & 0o777).toString(8)}, owner ${stat.uid}`);
      const socket = join(directory, 's');
      if (Buffer.byteLength(socket) >= 100) refusal(`local socket path is ${Buffer.byteLength(socket)} bytes (must be under 100); use a shorter MC_WORK_ROOT`);
      child = spawnProcess('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${socket}:${remote}`, destination],
        { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
      completion = new Promise(resolve => child.once('close', () => { closed = true; lost = true; resolve(); }));
      child.once('error', error => { reason = error.message; lost = true; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { reason = (reason || '') + chunk; });
      for (const deadline = now() + 10_000; !io.existsSync(socket);) {
        if (lost || now() >= deadline) refusal(`ssh ${destination}: ${reason?.trim() || (lost ? 'tunnel exited before its socket appeared' : 'tunnel socket did not appear within 10000 ms')}`);
        await sleep(25);
      }
      return { socket, child, get lost() { return lost; }, completion, cleanup };
    } catch (error) { await cleanup(); throw error; }
  }

  /** Access and the opening user message cross; role configuration remains server-owned. */
  async function codexClient(connection) {
    let forward;
    let client;
    let result;
    let linkLost = false;
    try {
      const session = validateDescriptor(connection.session, { destination });
      if (session.kind !== 'session' || session.provider !== 'codex') refusal(`on ${destination}: expected a Codex session descriptor`);
      const measured = run('codex', ['--version'], { ...options, encoding: 'utf8' });
      const localVersion = measured.status === 0 && measured.stdout?.trim() ? measured.stdout.trim() : `unavailable (${measured.error?.message || measured.stderr?.trim() || measured.status})`;
      if (localVersion !== session.providerVersion) refusal(`${localVersion} here, ${session.providerVersion} on ${destination}`);
      forward = await tunnel(session.socket);
      result = await new Promise(resolve => {
        client = spawnProcess('codex', [...(session.sessionId ? ['resume', session.sessionId] : session.access), '--remote', `unix://${forward.socket}`,
          ...(session.prompt ? (session.prompt.startsWith('-') ? ['--', session.prompt] : [session.prompt]) : [])],
          { ...options, stdio: 'inherit' });
        client.once('error', error => resolve({ status: 1, error }));
        client.once('close', (status, signal) => resolve({ status: status ?? 1, signal }));
        forward.completion.then(() => { linkLost = true; client.kill('SIGTERM'); });
        connection.closed.then(() => { linkLost = true; client.kill('SIGTERM'); });
      });
      await connection.finish(result.status === 0 && !result.signal && !result.error && !forward.lost && !linkLost);
      return result;
    } finally {
      // Finish first: removing the tunnel must not turn a clean quit into a lost connection.
      try { if (!result) await connection.finish(false); }
      finally { await forward?.cleanup(); }
    }
  }
  return { destination, request, handshake: () => request('version'), passthrough, connect, tunnel, codexClient };
}
