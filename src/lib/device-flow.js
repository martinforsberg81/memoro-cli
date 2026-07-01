/**
 * OAuth Device Flow (RFC 8628) — client side.
 *
 * Plan reference: docs/plans/worktree-lifecycle.md §14c + §14f.
 *
 * Two phases:
 *   1. `needsDeviceAuth(deps)` — gate predicate for the top of bin-mc.js's
 *      main(). Returns true only when ALL of the following hold:
 *        - no Memoro token in keychain
 *        - stdout is a TTY
 *        - MC_TEST_MODE !== '1'
 *        - MEMORO_TOKEN env var is unset (CI workaround stays intact)
 *        - argv[0] is not one of the auth-bypass commands
 *          (--help / --version / mc auth memoro / ...)
 *      A single false → false, so this is cheap + auditable.
 *
 *   2. `runDeviceFlow(deps)` — the actual flow: POST /init, print the
 *      verification URL + user_code, best-effort browser open, poll
 *      /poll with jitter + 429 backoff, store the token in keychain,
 *      print success. Returns the int exit code (0 success, 1 expired
 *      / denied / network failure, 130 SIGINT).
 *
 * All side-effecting dependencies are taken as injection parameters with
 * defaults so tests never touch the real network, real shell, or real
 * keychain. Pattern: dep-portal with soft-degrade (drev 1+2 +3 +4 pattern
 * 2).
 *
 * Security expectations (§14 brief):
 *   - device_code is a secret. Never log, never print, never include in
 *     error messages bubbled to the user.
 *   - The raw token is written to keychain and is never echoed beyond
 *     the safe `token_prefix` server returns.
 *   - On SIGINT: no partial token in keychain, no orphaned polling loop.
 *
 * The no-leak invariant is exercised by tests (see tests/lib/device-flow.test.js).
 */

import { hostname, platform, release } from 'node:os';
import { spawn } from 'node:child_process';

import {
  setSecret as defaultSetSecret,
  getSecret as defaultGetSecret,
} from './keychain.js';
import { memoroFetchAnon as defaultMemoroFetchAnon } from './api.js';
import { ACCOUNTS } from '../commands/auth.js';

const DEFAULT_API_URL = 'https://meetmemoro.app';

// Commands that should NEVER auto-trigger the device flow when no token is
// stored. `--help` / `--version` are diagnostic; `memoro-cli login` and
// `mc auth memoro` are the explicit (token-installing) escape hatches.
// We allow-list the bypass set rather than try to enumerate the trigger
// set, because the trigger surface is "every other mc invocation".
const AUTH_BYPASS_FIRST_ARGS = new Set([
  '--help', '-h', 'help',
  '--version', '-v',
  // `mc supervisor` owns a narrower scoped device-flow and must not receive
  // the primary Memoro auth token used by ordinary coding/session verbs.
  'supervisor',
]);

// `mc auth memoro <...>` should also bypass: the user is opting into the
// memoro-cli login path explicitly. We match on argv[0]==='auth' && argv[1]==='memoro'.
// Same for `mc auth devices ...` — managing devices requires a token, but
// if you're hitting this path without one we want the friendly
// "no token" error from the verb itself, not a forced device-flow loop.
// Per drev 5b-client brief: only auto-trigger on real work invocations.

/**
 * Pure-helper predicate version: take all the state as arguments, no I/O.
 * Exported so tests can drive each branch cheaply.
 */
export function shouldTriggerDeviceFlow({
  hasToken,
  isTty,
  mcTestMode,
  memoroTokenEnv,
  argv,
}) {
  if (hasToken) return false;
  if (!isTty) return false;
  if (mcTestMode === '1') return false;
  if (memoroTokenEnv) return false;
  const first = argv[0];
  if (AUTH_BYPASS_FIRST_ARGS.has(first)) return false;
  // `mc auth memoro <...>` is the explicit login path.
  if (first === 'auth' && argv[1] === 'memoro') return false;
  // `mc auth devices ...` needs a token to do anything useful, but should
  // surface its own "no token" error, not silently re-enter the flow.
  if (first === 'auth' && argv[1] === 'devices') return false;
  return true;
}

/**
 * I/O-bound wrapper. `deps` injectable for tests.
 */
export async function needsDeviceAuth(deps = {}) {
  const {
    getSecret = defaultGetSecret,
    env = process.env,
    isTty = process.stdout?.isTTY === true,
    argv = process.argv.slice(2),
  } = deps;
  let hasToken = false;
  try {
    const tok = await getSecret(ACCOUNTS.TOKEN);
    hasToken = !!tok;
  } catch {
    hasToken = false;
  }
  return shouldTriggerDeviceFlow({
    hasToken,
    isTty,
    mcTestMode: env.MC_TEST_MODE,
    memoroTokenEnv: env.MEMORO_TOKEN,
    argv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// runDeviceFlow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a human-friendly device name + OS string from `os.*`. Best-effort;
 * empty / unknown values are tolerated server-side (see device-flow.js
 * server route: device_os defaults to 'unknown').
 */
export function deriveDeviceIdentity({
  hostname: hostFn = hostname,
  platform: platFn = platform,
  release: relFn = release,
} = {}) {
  let host = '';
  try { host = (hostFn() || '').trim(); } catch { host = ''; }
  // Strip ".local" suffix that macOS bonjour adds — it's noise.
  host = host.replace(/\.local$/, '');
  if (!host) host = 'unknown-host';

  let plat = '';
  try { plat = (platFn() || '').trim(); } catch { plat = ''; }
  let rel = '';
  try { rel = (relFn() || '').trim(); } catch { rel = ''; }

  // Keep the joined OS string short — server enforces 40-char max.
  let osStr = [plat, rel].filter(Boolean).join(' ').trim();
  if (osStr.length > 40) osStr = osStr.slice(0, 40);
  return { deviceName: host.slice(0, 80), deviceOs: osStr || 'unknown' };
}

/**
 * Pick the platform-appropriate "open URL" command. Returns null on
 * unsupported platforms so callers can print the URL manually.
 */
export function openCommandFor(p) {
  if (p === 'darwin') return { cmd: 'open',     args: [] };
  if (p === 'linux')  return { cmd: 'xdg-open', args: [] };
  if (p === 'win32')  return { cmd: 'cmd',      args: ['/c', 'start', ''] };
  return null;
}

/**
 * Spawn the open command. Resolves true on a zero-exit; false otherwise.
 * Never throws — caller decides what to do with the boolean.
 */
export function openBrowser(url, {
  platform: platFn = platform,
  spawnFn = spawn,
} = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = platFn(); } catch { p = 'unknown'; }
    const desc = openCommandFor(p);
    if (!desc) return resolve(false);
    let child;
    try {
      child = spawnFn(desc.cmd, [...desc.args, url], {
        stdio: 'ignore',
        detached: true,
      });
    } catch {
      return resolve(false);
    }
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; resolve(ok); };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
    // Belt-and-braces: detach so a missing tool doesn't keep the loop
    // alive longer than expected.
    try { child.unref(); } catch {}
    // If for some reason the child never fires close/error, fall through
    // after a short window — the polling loop continues regardless of
    // browser-open outcome (best-effort per §14 brief).
    setTimeout(() => done(false), 1500).unref();
  });
}

/**
 * Compute a poll interval with ±20% jitter. Floor is `intervalSec` (server
 * may rate-limit faster polls). Returns ms.
 *
 * Pure for testing. `rand` injectable.
 */
export function jitteredInterval(intervalSec, { rand = Math.random } = {}) {
  const base = Math.max(1, intervalSec) * 1000;
  // Range: [base, base * 1.4) — never poll faster than the server's floor,
  // up to +40% slower so concurrent devices don't all poll on the same tick.
  const jitter = base * 0.4 * rand();
  return Math.floor(base + jitter);
}

/**
 * Format an ISO-ish expires_at into a short user-facing line.
 */
export function formatExpiresAt(expiresAtIso) {
  if (!expiresAtIso) return null;
  try {
    const d = new Date(expiresAtIso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toUTCString();
  } catch {
    return null;
  }
}

const TERMINAL_STATUSES = new Set(['authorized', 'expired', 'denied']);

/**
 * The main flow. Returns an integer exit code:
 *   0   — token stored in keychain
 *   1   — expired / denied / network failure
 *   130 — SIGINT (Ctrl-C)
 *
 * All deps injectable. The default deps shell out to the real network +
 * keychain; tests pass stubs.
 *
 * Note: this function intentionally writes only safe substrings of
 * server-returned data to the terminal. `device_code` is never written.
 * `token` itself is written to keychain and never echoed beyond
 * `token_prefix` which the server pre-redacts.
 */
export async function runDeviceFlow(deps = {}) {
  const {
    apiUrl = DEFAULT_API_URL,
    memoroFetchAnon = defaultMemoroFetchAnon,
    setSecret = defaultSetSecret,
    openBrowserFn = openBrowser,
    deriveIdentity = deriveDeviceIdentity,
    sleep = defaultSleep,
    now = Date.now,
    rand = Math.random,
    stdout = process.stdout,
    stderr = process.stderr,
    onSigint = installSigintHandler,
    account = ACCOUNTS.TOKEN,
    scope = null,
    audience = null,
    client = null,
    successLabel = 'Device',
    nextMessage = 'Next: run `mc setup` to finish local setup.',
    initPath = '/api/auth/device/init',
    pollPath = '/api/auth/device/poll',
    // For tests: a pre-set AbortController-style flag to interrupt the loop.
    sigintFlag = { cancelled: false },
  } = deps;

  const identity = deriveIdentity();

  // ── init ───────────────────────────────────────────────────────────────
  let init;
  try {
    init = await memoroFetchAnon(apiUrl, initPath, {
      method: 'POST',
      body: {
        device_name: identity.deviceName,
        device_os: identity.deviceOs,
        ...(scope ? { scope } : {}),
        ...(audience ? { audience } : {}),
        ...(client ? { client } : {}),
      },
    });
  } catch (err) {
    stderr.write(`mc: failed to start device authorization: ${err.message}\n`);
    return 1;
  }

  // Guard against malformed responses — the server always returns
  // user_code + device_code on success, but a deploy-in-progress could
  // return ok:false.
  if (!init || !init.device_code || !init.user_code || !init.verification_url) {
    stderr.write(`mc: device authorization init returned an unexpected response\n`);
    return 1;
  }

  const verificationUrl = init.verification_url;
  const completeUrl = init.verification_uri_complete || `${verificationUrl}?code=${encodeURIComponent(init.user_code)}`;
  const expiresInMs = Math.max(60, init.expires_in || 600) * 1000;
  let intervalSec = Math.max(1, init.interval || 5);

  // ── prompt + browser-open ──────────────────────────────────────────────
  // Stderr keeps stdout clean for scripting. The user code is printed
  // prominently; the verification URL gets two forms (bare + ?code=…).
  stderr.write('\n');
  stderr.write(`Sign in to Memoro to authorize this device:\n`);
  stderr.write(`\n`);
  stderr.write(`  Code:    ${init.user_code}\n`);
  stderr.write(`  Open:    ${completeUrl}\n`);
  stderr.write(`\n`);

  let opened = false;
  try {
    opened = await openBrowserFn(completeUrl);
  } catch {
    opened = false;
  }
  if (!opened) {
    stderr.write(`(Couldn't open the browser automatically. Open the URL manually.)\n\n`);
  } else {
    stderr.write(`Opened your browser. Waiting for approval`);
  }

  // ── poll loop ──────────────────────────────────────────────────────────
  // Stop conditions: terminal status, hard timeout at expires_in,
  // SIGINT (130), or repeated network failures (1).
  const restoreSigint = onSigint(sigintFlag);

  const startedAt = now();
  let pollFailures = 0;
  const MAX_NETWORK_FAILURES = 5;

  let exitCode = 1;
  try {
    while (true) {
      if (sigintFlag.cancelled) {
        stderr.write(`\nmc: cancelled. No token stored.\n`);
        exitCode = 130;
        break;
      }
      if (now() - startedAt > expiresInMs) {
        stderr.write(`\nmc: device authorization timed out (${Math.floor(expiresInMs / 1000)}s). Try again.\n`);
        exitCode = 1;
        break;
      }

      const waitMs = jitteredInterval(intervalSec, { rand });
      await sleep(waitMs, sigintFlag);
      if (sigintFlag.cancelled) {
        stderr.write(`\nmc: cancelled. No token stored.\n`);
        exitCode = 130;
        break;
      }

      // Liveness dot — only when the user might be looking.
      if (opened) stderr.write('.');

      let poll;
      try {
        poll = await memoroFetchAnon(apiUrl, pollPath, {
          method: 'POST',
          body: { device_code: init.device_code },
        });
        pollFailures = 0;
      } catch (err) {
        // Server returns 429 → throw with status 429 (see memoroFetch).
        // Treat any 429 as "slow down": double the interval and continue.
        if (err && (err.status === 429 || /429/.test(err.message || ''))) {
          intervalSec = Math.min(60, intervalSec * 2);
          continue;
        }
        pollFailures++;
        if (pollFailures >= MAX_NETWORK_FAILURES) {
          stderr.write(`\nmc: too many network errors polling for device authorization. Aborting.\n`);
          exitCode = 1;
          break;
        }
        continue;
      }

      const status = poll && poll.status;
      if (!TERMINAL_STATUSES.has(status)) {
        // 'pending' or unknown → keep polling.
        continue;
      }

      if (status === 'denied') {
        stderr.write(`\nmc: authorization denied. No token stored.\n`);
        exitCode = 1;
        break;
      }
      if (status === 'expired') {
        stderr.write(`\nmc: authorization expired before approval. Try again.\n`);
        exitCode = 1;
        break;
      }

      // authorized
      const token = poll.token;
      const tokenPrefix = poll.token_prefix || '';
      const expiresAt = poll.expires_at || null;
      if (!token || typeof token !== 'string') {
        stderr.write(`\nmc: device authorization response missing token. Aborting.\n`);
        exitCode = 1;
        break;
      }
      if (scope && !authorizedResponseIncludesScope(poll, scope)) {
        stderr.write(`\nmc: device authorization response missing required scope "${scope}". No token stored.\n`);
        exitCode = 1;
        break;
      }
      if (audience && !authorizedResponseIncludesAudience(poll, audience)) {
        stderr.write(`\nmc: device authorization response missing required audience "${audience}". No token stored.\n`);
        exitCode = 1;
        break;
      }
      try {
        await setSecret(account, token);
      } catch (err) {
        stderr.write(`\nmc: failed to store token: ${err.message}\n`);
        exitCode = 1;
        break;
      }
      stderr.write('\n\n');
      const expiryLine = formatExpiresAt(expiresAt);
      stderr.write(`✓ ${successLabel} authorized. Token saved to keychain.\n`);
      if (tokenPrefix) stderr.write(`  Prefix:  ${tokenPrefix}\n`);
      if (expiryLine)  stderr.write(`  Expires: ${expiryLine}\n`);
      stderr.write(`\n`);
      if (nextMessage) stderr.write(`${nextMessage}\n`);
      exitCode = 0;
      break;
    }
  } finally {
    try { restoreSigint(); } catch {}
  }
  return exitCode;
}

export function authorizedResponseIncludesScope(response, requiredScope) {
  if (!requiredScope) return true;
  const scopes = new Set();
  if (typeof response?.scope === 'string') {
    for (const value of response.scope.split(/[,\s]+/)) {
      if (value.trim()) scopes.add(value.trim());
    }
  }
  if (Array.isArray(response?.scopes)) {
    for (const value of response.scopes) {
      if (typeof value === 'string' && value.trim()) scopes.add(value.trim());
    }
  }
  return scopes.has(requiredScope);
}

export function authorizedResponseIncludesAudience(response, requiredAudience) {
  if (!requiredAudience) return true;
  if (typeof response?.audience === 'string' && response.audience.trim() === requiredAudience) {
    return true;
  }
  if (Array.isArray(response?.audiences)) {
    return response.audiences.some((value) => (
      typeof value === 'string' && value.trim() === requiredAudience
    ));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sleep that bails early if the sigint flag flips. Returns when either
 * the time elapses OR the flag is set. Exported for tests via the deps
 * portal.
 */
export async function defaultSleep(ms, sigintFlag) {
  const start = Date.now();
  // Poll on a 100ms granularity so Ctrl-C cancels promptly without
  // hooking process-level signal handlers from inside the helper.
  while (Date.now() - start < ms) {
    if (sigintFlag && sigintFlag.cancelled) return;
    const remaining = ms - (Date.now() - start);
    const step = Math.min(100, remaining);
    if (step <= 0) return;
    await new Promise(r => setTimeout(r, step));
  }
}

/**
 * Install a one-shot SIGINT handler that flips the flag. Returns a
 * function that uninstalls the handler. Tests inject a no-op.
 */
export function installSigintHandler(flag) {
  const handler = () => { flag.cancelled = true; };
  process.on('SIGINT', handler);
  return () => {
    try { process.removeListener('SIGINT', handler); } catch {}
  };
}
