/**
 * The one place a git process is started.
 *
 * Every git call mc makes goes through `run` (synchronous) or `runAsync`, in
 * the raw shape `spawnSync` gives — `{ status, stdout, stderr, error, signal }`
 * with utf8 strings — and the readers around them reshape it. One entrance so
 * a test can stand in for all of git at once: `useGitRunner` replaces the
 * process with a function of the same shape for this process, and a suite
 * that runs against a repository model never starts git at all (Martin,
 * 2026-11-01: tests make no git call; `tests/_isolate-home.mjs` counts the
 * ones that still do). It lives in `lib/` because `lib/` may not import
 * `mc/`; `src/mc/git.js` re-exports it with the readers built on top.
 */
import { spawn, spawnSync } from 'node:child_process';

export const GIT_TIMEOUT_MS = 300_000;

/**
 * The one place a git process is started.
 *
 * Every git call mc makes goes through `run` (synchronous) or `runAsync`, in
 * the raw shape `spawnSync` gives — `{ status, stdout, stderr, error, signal }`
 * with utf8 strings — and the readers above and around reshape it. One
 * entrance so a test can stand in for all of git at once: `useGitRunner`
 * replaces the process with a function of the same shape for this process,
 * and a suite that runs against a repository model never starts git at all
 * (Martin, 2026-11-01: tests make no git call; `tests/_isolate-home.mjs`
 * counts the ones that still do).
 */
let runner = null;

/**
 * Stand in for git in this process: `fn(cwd, args, options)` returns what
 * `spawnSync('git', …)` would — `{ status, stdout, stderr }`, `error` set when
 * the process could not run or timed out. Returns the function that restores
 * the previous runner. A test installs one in `before` and restores it in
 * `after`; production never calls this.
 */
export function useGitRunner(fn) {
  const previous = runner;
  runner = fn;
  return () => { runner = previous; };
}

/** The raw result of `git <args>` in `cwd`, or of the installed runner. */
export function run(cwd, args, { env, input, timeoutMs = GIT_TIMEOUT_MS, maxBuffer, stdio, encoding = 'utf8' } = {}) {
  if (runner) return runner(cwd, args, { env, input, timeoutMs, maxBuffer, encoding });
  const options = { cwd, encoding, timeout: timeoutMs };
  if (env) options.env = env;
  if (input !== undefined) options.input = input;
  if (maxBuffer) options.maxBuffer = maxBuffer;
  if (stdio) options.stdio = stdio;
  return spawnSync('git', args, options);
}

/** `run`, without blocking the event loop: the same shape, as a promise. */
export function runAsync(cwd, args, options = {}) {
  if (runner) return Promise.resolve(runner(cwd, args, { ...options, timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS }));
  return new Promise((resolve) => {
    const { env, input, timeoutMs = GIT_TIMEOUT_MS, maxBuffer, encoding = 'utf8' } = options;
    const spawnOptions = { cwd, stdio: ['pipe', 'pipe', 'pipe'] };
    if (env) spawnOptions.env = env;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    try { child = spawn('git', args, spawnOptions); } catch (error) { finish({ status: null, stdout, stderr, error, signal: null }); return; }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      const error = new Error(`git ${args.join(' ')} did not finish in ${seconds(timeoutMs)}`);
      error.code = 'ETIMEDOUT';
      finish({ status: null, stdout, stderr, error, signal: 'SIGKILL' });
    }, timeoutMs);
    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (maxBuffer && stdout.length > maxBuffer) {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        const error = new Error(`git ${args.join(' ')} wrote more than ${maxBuffer} bytes`);
        error.code = 'ENOBUFS';
        finish({ status: null, stdout, stderr, error, signal: 'SIGKILL' });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ status: null, stdout, stderr, error, signal: null }));
    child.on('close', (status, signal) => finish({ status, stdout, stderr, error: undefined, signal }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function seconds(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}
