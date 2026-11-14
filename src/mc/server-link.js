/** The only SSH boundary: the person's OpenSSH, never keys, agents or SSH configuration. */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { workRoot } from './paths.js';
import { terminalEnvironment } from './session-entrance.js';
import { MC_VERSION, validateDescriptor } from './server-protocol.js';

const settingPath = env => join(workRoot(env), 'runner', 'server.json');
const refusal = message => { throw new Error(message); };

export function sshDestination(value) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\x00-\x20\x7f]/u.test(value)) refusal('SSH destination must be one OpenSSH destination, not options or a command');
  return value;
}
export function readServer(env = process.env, io = fs) {
  let value;
  try { value = JSON.parse(io.readFileSync(settingPath(env), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!value || Object.keys(value).join() !== 'destination') refusal('invalid mc server setting');
  return sshDestination(value.destination);
}
export function saveServer(destination, env = process.env, io = fs) {
  sshDestination(destination);
  const file = settingPath(env);
  io.mkdirSync(join(workRoot(env), 'runner'), { recursive: true, mode: 0o700 });
  const pending = `${file}.${process.pid}.tmp`;
  try { io.writeFileSync(pending, `${JSON.stringify({ destination })}\n`, { mode: 0o600 }); io.renameSync(pending, file); }
  finally { io.rmSync(pending, { force: true }); }
}
export function clearServer(env = process.env, io = fs) { io.rmSync(settingPath(env), { force: true }); }

/** OpenSSH sends one shell command, not an argv vector. Quote every word once here. */
export function remoteCommand(argv) {
  return argv.map(arg => {
    if (typeof arg !== 'string' || arg.includes('\0')) refusal('remote arguments must be strings without NUL');
    return `'${arg.replaceAll("'", "'\\''")}'`;
  }).join(' ');
}

export function serverLink(destination, {
  env = process.env, io = fs, spawnProcess = spawn, run = spawnSync, now = Date.now, sleep = delay,
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
    if (result.stdout?.trim()) return decode(result.stdout);
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
    let output = ''; let errors = ''; let settled = false;
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.on('error', () => {});
    const first = new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 1 << 20) { reject(new Error(`ssh ${destination}: descriptor exceeds 1 MiB`)); child.kill(); return; }
        if (!settled && output.includes('\n')) {
          settled = true;
          try { resolve(decode(output.slice(0, output.indexOf('\n')))); } catch (error) { reject(error); }
        }
      });
      child.once('error', error => reject(new Error(`ssh ${destination}: ${error.message}`)));
      child.once('close', (status, signal) => {
        resolveClosed({ status: status ?? 1, signal });
        if (!settled) reject(new Error(`ssh ${destination}: ${errors.trim() || `exited ${status ?? signal}`}`));
      });
    });
    try {
      const session = await first;
      if (session.kind !== 'session') refusal(`ssh ${destination}: expected a session descriptor, got ${session.kind}`);
      return { session, closed, finish: async clean => {
        child.stdin.end(clean ? 'end\n' : '');
        return await closed;
      }, abort: () => child.kill('SIGTERM') };
    } catch (error) { child.stdin.destroy(); child.kill('SIGTERM'); throw error; }
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

  /** Only access flags cross for a new thread; the provider's launch remains server-owned. */
  async function codexClient(connection) {
    const session = validateDescriptor(connection.session, { destination });
    let forward;
    let client;
    let result;
    let linkLost = false;
    try {
      const measured = run('codex', ['--version'], { ...options, encoding: 'utf8' });
      const localVersion = measured.status === 0 ? measured.stdout.trim() : `unavailable (${measured.error?.message || measured.stderr?.trim() || measured.status})`;
      if (localVersion !== session.providerVersion) refusal(`${localVersion} here, ${session.providerVersion} on ${destination}`);
      forward = await tunnel(session.socket);
      result = await new Promise(resolve => {
        client = spawnProcess('codex', [...(session.sessionId ? ['resume', session.sessionId] : session.access), '--remote', `unix://${forward.socket}`],
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
      if (!result) await connection.finish(false);
      await forward?.cleanup();
    }
  }
  return { destination, request, handshake: () => request('version'), passthrough, connect, tunnel, codexClient };
}
