/**
 * A child process, without holding the event loop.
 *
 * The gate and the merger used to run git, gh, `npm ci`, the derived
 * commands and the selector with the synchronous spawn, and for as long as
 * one ran the process did nothing else. On 2026-10-10 17:40-17:47 the old
 * merger was blocked through `npm ci` (268 s), derived (33 s) and the
 * selector (107 s): its SIGTERM waited seven minutes to be seen, and the
 * other lane stood still beside it.
 *
 * Both functions resolve to the result shape the synchronous spawn gives —
 * `{ status, signal, stdout, stderr, error }`, as utf8 strings — so a caller
 * reads it as it always did, and a test that injects a stub returning a plain
 * object still works: `await` of an object is the object. The promise never
 * rejects. A child that does not start resolves with `status: null` and
 * `error`.
 *
 * `maxBuffer` is stated because Node's default is 1 MiB and a child that
 * prints more is killed for it (`ENOBUFS`, status null): memoro's selector
 * printed 1.3 MB for #12720 and the round stopped with nothing measured. The
 * limit is per stream, as the synchronous spawn has it; past it the child is
 * killed and the result says `ENOBUFS`.
 *
 * A timeout kills with SIGTERM and resolves `signal: 'SIGTERM'`,
 * `error.code: 'ETIMEDOUT'`.
 */
import { spawn } from 'node:child_process';

const MAX_BUFFER = 256 << 20;

/** `tool` with `args`, no shell. */
export function runTool(tool, args = [], { cwd, env, maxBuffer = MAX_BUFFER, timeoutMs = null } = {}) {
  return collect(() => spawn(tool, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] }), { maxBuffer, timeoutMs });
}

/**
 * A command line, through a shell — declarations are written the way a
 * person writes them (`npm ci`, `npm run test:msr:contract`), and splitting
 * those by hand would be a second grammar to get wrong.
 */
export function runShell(command, { cwd, env, maxBuffer = MAX_BUFFER, timeoutMs = null } = {}) {
  return collect(() => spawn(command, { cwd, env: env || process.env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }), { maxBuffer, timeoutMs });
}

function collect(start, { maxBuffer, timeoutMs }) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let error = null;
    let settled = false;
    let timer = null;
    const text = (chunks) => Buffer.concat(chunks).toString('utf8');
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: error ? null : status, signal: signal ?? null, stdout: text(out), stderr: text(err), error });
    };

    let child = null;
    try { child = start(); } catch (thrown) {
      error = thrown;
      settle(null, null);
      return;
    }
    const kill = (code, message) => {
      if (error) return;
      error = Object.assign(new Error(message), { code });
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };
    // Only what fits is kept, as the synchronous spawn keeps it.
    const take = (chunks, chunk, used) => {
      const room = maxBuffer - used;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        kill('ENOBUFS', `spawn ENOBUFS — output past maxBuffer (${maxBuffer} bytes)`);
        return maxBuffer;
      }
      chunks.push(chunk);
      return used + chunk.length;
    };
    child.stdout.on('data', (chunk) => { if (!error) outBytes = take(out, chunk, outBytes); });
    child.stderr.on('data', (chunk) => { if (!error) errBytes = take(err, chunk, errBytes); });
    child.on('error', (thrown) => {
      if (!error) error = thrown;
      // A child that never started has no `close` to wait for.
      if (child.pid === undefined) settle(null, null);
    });
    child.on('close', (status, signal) => settle(status, signal));
    if (timeoutMs !== null && timeoutMs !== undefined) {
      timer = setTimeout(() => kill('ETIMEDOUT', `spawn ETIMEDOUT — still running after ${timeoutMs} ms`), timeoutMs);
    }
  });
}
