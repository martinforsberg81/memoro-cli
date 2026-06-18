/**
 * Unit tests for the OAuth Device Flow client (§14c + §14f).
 *
 * All deps are injected — no real network, no real keychain, no real
 * spawn() to `open` / `xdg-open` / `start`.
 *
 * Key invariants under test:
 *   - shouldTriggerDeviceFlow: every gate short-circuits the right way
 *   - runDeviceFlow: happy path stores token + prints prefix
 *   - runDeviceFlow: denied / expired / network failure → exit 1
 *   - runDeviceFlow: SIGINT (sigintFlag) → exit 130, no token stored
 *   - runDeviceFlow: 429 doubles the interval rather than aborting
 *   - **No-leak invariant**: device_code never appears in stdout/stderr
 *     across the whole flow; token only appears in keychain, never echoed
 *     beyond token_prefix
 *   - jitteredInterval: never below the server floor; bounded above
 *   - deriveDeviceIdentity: strips .local, caps OS string at 40 chars
 *   - openCommandFor: returns null on unsupported platforms
 *   - openBrowser: best-effort, never throws
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldTriggerDeviceFlow,
  needsDeviceAuth,
  deriveDeviceIdentity,
  openCommandFor,
  openBrowser,
  jitteredInterval,
  formatExpiresAt,
  runDeviceFlow,
  defaultSleep,
} from '../../src/lib/device-flow.js';

// ─────────────────────────────────────────────────────────────────────────────
// shouldTriggerDeviceFlow — gate predicate
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldTriggerDeviceFlow', () => {
  const base = {
    hasToken: false,
    isTty: true,
    mcTestMode: undefined,
    memoroTokenEnv: undefined,
    argv: ['list'],
  };

  test('triggers on a fresh-install mc invocation with no token', () => {
    assert.equal(shouldTriggerDeviceFlow(base), true);
  });

  test('does NOT trigger when a token is already stored', () => {
    assert.equal(shouldTriggerDeviceFlow({ ...base, hasToken: true }), false);
  });

  test('does NOT trigger when stdout is not a TTY (CI / pipes)', () => {
    assert.equal(shouldTriggerDeviceFlow({ ...base, isTty: false }), false);
  });

  test('does NOT trigger under MC_TEST_MODE=1', () => {
    assert.equal(shouldTriggerDeviceFlow({ ...base, mcTestMode: '1' }), false);
  });

  test('does NOT trigger when MEMORO_TOKEN env is set (CI workaround)', () => {
    assert.equal(shouldTriggerDeviceFlow({ ...base, memoroTokenEnv: 'mem_x' }), false);
  });

  test('bypasses help variants', () => {
    for (const a of ['--help', '-h', 'help']) {
      assert.equal(shouldTriggerDeviceFlow({ ...base, argv: [a] }), false, `argv[0]=${a}`);
    }
  });

  test('bypasses --version / -v', () => {
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['--version'] }), false);
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['-v'] }), false);
  });

  test('bypasses `mc auth memoro <...>` so login alias still works without a token', () => {
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['auth', 'memoro'] }), false);
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['auth', 'memoro', '--status'] }), false);
  });

  test('bypasses `mc auth devices` so the verb prints its own no-token error', () => {
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['auth', 'devices'] }), false);
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['auth', 'devices', 'list'] }), false);
  });

  test('does NOT bypass `mc auth status` — auth-less status invocation should auto-trigger', () => {
    // Surprising but intentional: a brand-new user typing `mc auth status`
    // expects to land in the auth flow, not see a static "no token" line.
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['auth', 'status'] }), true);
  });

  test('triggers on `mc list`, `mc new`, plain `mc`', () => {
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['list'] }), true);
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: ['new', 'fix-x'] }), true);
    assert.equal(shouldTriggerDeviceFlow({ ...base, argv: [] }), true);
  });
});

describe('needsDeviceAuth (deps wiring)', () => {
  test('returns false when keychain throws', async () => {
    const got = await needsDeviceAuth({
      getSecret: async () => { throw new Error('locked'); },
      env: {},
      isTty: true,
      argv: ['list'],
    });
    // getSecret throwing → hasToken=false → still trigger.
    assert.equal(got, true);
  });

  test('returns false when the keychain returns a token', async () => {
    const got = await needsDeviceAuth({
      getSecret: async () => 'mem_existing',
      env: {},
      isTty: true,
      argv: ['list'],
    });
    assert.equal(got, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveDeviceIdentity / openCommandFor / openBrowser
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveDeviceIdentity', () => {
  test('strips trailing .local from hostname', () => {
    const id = deriveDeviceIdentity({
      hostname: () => 'Martins-MBP.local',
      platform: () => 'darwin',
      release:  () => '25.4.0',
    });
    assert.equal(id.deviceName, 'Martins-MBP');
    assert.match(id.deviceOs, /darwin 25\.4\.0/);
  });

  test('caps deviceOs at 40 chars (server enforces this)', () => {
    const id = deriveDeviceIdentity({
      hostname: () => 'host',
      platform: () => 'linux',
      release:  () => 'X'.repeat(80),
    });
    assert.ok(id.deviceOs.length <= 40, `os len ${id.deviceOs.length}`);
  });

  test('falls back to "unknown-host" / "unknown" on empty values', () => {
    const id = deriveDeviceIdentity({
      hostname: () => '',
      platform: () => '',
      release:  () => '',
    });
    assert.equal(id.deviceName, 'unknown-host');
    assert.equal(id.deviceOs, 'unknown');
  });

  test('tolerates os.* throwing', () => {
    const id = deriveDeviceIdentity({
      hostname: () => { throw new Error('oops'); },
      platform: () => 'darwin',
      release:  () => '25.4.0',
    });
    assert.equal(id.deviceName, 'unknown-host');
  });
});

describe('openCommandFor', () => {
  test('darwin uses `open`', () => {
    assert.deepEqual(openCommandFor('darwin'), { cmd: 'open', args: [] });
  });
  test('linux uses `xdg-open`', () => {
    assert.deepEqual(openCommandFor('linux'), { cmd: 'xdg-open', args: [] });
  });
  test('win32 uses `cmd /c start ""`', () => {
    assert.deepEqual(openCommandFor('win32'), { cmd: 'cmd', args: ['/c', 'start', ''] });
  });
  test('unsupported platform returns null', () => {
    assert.equal(openCommandFor('haiku'), null);
    assert.equal(openCommandFor(''), null);
  });
});

describe('openBrowser', () => {
  test('resolves false when platform has no opener', async () => {
    const ok = await openBrowser('https://example.com/x', {
      platform: () => 'haiku',
      spawnFn: () => { throw new Error('should not spawn'); },
    });
    assert.equal(ok, false);
  });

  test('resolves true on a zero-exit', async () => {
    const fakeChild = makeFakeChild();
    const p = openBrowser('https://example.com/x', {
      platform: () => 'darwin',
      spawnFn: () => fakeChild,
    });
    // Fire close(0) on next tick so the handler is wired up first.
    setImmediate(() => fakeChild.emit('close', 0));
    assert.equal(await p, true);
  });

  test('resolves false on spawn throwing (binary missing)', async () => {
    const ok = await openBrowser('https://example.com/x', {
      platform: () => 'darwin',
      spawnFn: () => { throw new Error('ENOENT'); },
    });
    assert.equal(ok, false);
  });

  test('resolves false on non-zero exit', async () => {
    const fakeChild = makeFakeChild();
    const ok = openBrowser('https://example.com/x', {
      platform: () => 'darwin',
      spawnFn: () => fakeChild,
    });
    setImmediate(() => fakeChild.emit('close', 1));
    assert.equal(await ok, false);
  });
});

function makeFakeChild() {
  const handlers = {};
  return {
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, ...args) { if (handlers[ev]) handlers[ev](...args); },
    unref() {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// jitteredInterval + formatExpiresAt
// ─────────────────────────────────────────────────────────────────────────────

describe('jitteredInterval', () => {
  test('never returns less than the server-supplied floor (in ms)', () => {
    for (const i of [1, 5, 10]) {
      // rand() ∈ [0,1) — even at 0 we should equal the floor.
      const v = jitteredInterval(i, { rand: () => 0 });
      assert.equal(v, i * 1000);
    }
  });

  test('upper bound is floor * 1.4 (±20% jitter)', () => {
    for (const i of [1, 5, 10]) {
      const v = jitteredInterval(i, { rand: () => 0.9999 });
      assert.ok(v >= i * 1000, `>= floor`);
      assert.ok(v <= i * 1400, `<= +40%: got ${v}`);
    }
  });

  test('coerces 0 / negative intervals to a 1s floor', () => {
    const v = jitteredInterval(0, { rand: () => 0 });
    assert.equal(v, 1000);
  });
});

describe('formatExpiresAt', () => {
  test('returns null for missing input', () => {
    assert.equal(formatExpiresAt(null), null);
    assert.equal(formatExpiresAt(''), null);
    assert.equal(formatExpiresAt('not-a-date'), null);
  });
  test('formats a valid ISO timestamp', () => {
    const s = formatExpiresAt('2026-08-29T12:00:00.000Z');
    assert.ok(/2026/.test(s), `got: ${s}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDeviceFlow — happy path, errors, security invariants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fake "writable stream" that buffers all writes into an array.
 */
function makeFakeWritable() {
  const writes = [];
  return {
    writes,
    write(s) { writes.push(s); return true; },
    get text() { return writes.join(''); },
  };
}

describe('runDeviceFlow — happy path', () => {
  test('stores token in keychain and exits 0', async () => {
    const stored = {};
    const stdout = makeFakeWritable();
    const stderr = makeFakeWritable();

    let pollCount = 0;
    const memoroFetchAnon = async (apiUrl, path, opts) => {
      if (path === '/api/auth/device/init') {
        return {
          ok: true,
          user_code: 'ABCD-1234',
          device_code: 'secret-device-code-deadbeef',
          verification_url: 'https://example.com/auth/device',
          verification_uri_complete: 'https://example.com/auth/device?code=ABCD-1234',
          expires_in: 600,
          interval: 1,
        };
      }
      if (path === '/api/auth/device/poll') {
        pollCount++;
        if (pollCount < 2) return { ok: true, status: 'pending' };
        return {
          ok: true,
          status: 'authorized',
          token: 'mem_secrettokenvaluethatshouldneverechoexceptprefix',
          token_prefix: 'mem_a1b2…',
          expires_at: '2026-08-29T12:00:00.000Z',
        };
      }
      throw new Error(`unexpected ${path}`);
    };

    const code = await runDeviceFlow({
      apiUrl: 'http://test',
      memoroFetchAnon,
      setSecret: async (acct, val) => { stored[acct] = val; return 'keychain'; },
      openBrowserFn: async () => true,
      deriveIdentity: () => ({ deviceName: 'TestHost', deviceOs: 'darwin 25.4' }),
      sleep: async () => {},
      now: () => 1000,
      rand: () => 0,
      stdout, stderr,
      onSigint: () => () => {},
      sigintFlag: { cancelled: false },
    });

    assert.equal(code, 0);
    assert.equal(stored['memoro-api-token'], 'mem_secrettokenvaluethatshouldneverechoexceptprefix');
    // Success message printed
    assert.match(stderr.text, /✓ Device authorized/);
    assert.match(stderr.text, /Next: run `mc setup` to finish local setup\./);
    // Token prefix shown — but NOT the full token
    assert.match(stderr.text, /mem_a1b2…/);
    assert.doesNotMatch(stderr.text, /secrettokenvaluethatshouldneverecho/);
    // device_code never echoed
    assert.doesNotMatch(stderr.text, /secret-device-code-deadbeef/);
    assert.doesNotMatch(stdout.text, /secret-device-code-deadbeef/);
  });

  test('no-leak invariant: device_code is never in any user-visible output', async () => {
    const DEVICE_CODE = 'ULTRASECRET-DEVICE-CODE-XYZ';
    const stdout = makeFakeWritable();
    const stderr = makeFakeWritable();

    let pollCount = 0;
    const memoroFetchAnon = async (apiUrl, path) => {
      if (path === '/api/auth/device/init') {
        return {
          ok: true,
          user_code: 'WXYZ-9876',
          device_code: DEVICE_CODE,
          verification_url: 'https://example.com/auth/device',
          verification_uri_complete: 'https://example.com/auth/device?code=WXYZ-9876',
          expires_in: 600,
          interval: 1,
        };
      }
      pollCount++;
      if (pollCount < 3) return { ok: true, status: 'pending' };
      return {
        ok: true,
        status: 'authorized',
        token: 'mem_realtoken',
        token_prefix: 'mem_real…',
        expires_at: '2026-08-29T12:00:00.000Z',
      };
    };

    await runDeviceFlow({
      apiUrl: 'http://test',
      memoroFetchAnon,
      setSecret: async () => 'keychain',
      openBrowserFn: async () => true,
      deriveIdentity: () => ({ deviceName: 'h', deviceOs: 'o' }),
      sleep: async () => {},
      now: () => 1000,
      rand: () => 0,
      stdout, stderr,
      onSigint: () => () => {},
      sigintFlag: { cancelled: false },
    });

    assert.equal(stdout.text.includes(DEVICE_CODE), false, 'stdout leaked device_code');
    assert.equal(stderr.text.includes(DEVICE_CODE), false, 'stderr leaked device_code');
    assert.equal(stdout.text.includes('mem_realtoken'), false, 'stdout leaked raw token');
    assert.equal(stderr.text.includes('mem_realtoken'), false, 'stderr leaked raw token');
  });
});

describe('runDeviceFlow — terminal statuses', () => {
  test('denied → exit 1', async () => {
    const stderr = makeFakeWritable();
    const code = await runDeviceFlow({
      apiUrl: 'http://test',
      memoroFetchAnon: async (_u, path) => {
        if (path === '/api/auth/device/init') {
          return {
            ok: true,
            user_code: 'ABCD',
            device_code: 'dc',
            verification_url: 'https://x/auth/device',
            verification_uri_complete: 'https://x/auth/device?code=ABCD',
            expires_in: 600,
            interval: 1,
          };
        }
        return { ok: true, status: 'denied' };
      },
      setSecret: async () => { throw new Error('should not be called'); },
      openBrowserFn: async () => true,
      deriveIdentity: () => ({ deviceName: 'h', deviceOs: 'o' }),
      sleep: async () => {},
      now: () => 1000,
      rand: () => 0,
      stdout: makeFakeWritable(),
      stderr,
      onSigint: () => () => {},
      sigintFlag: { cancelled: false },
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /denied/);
  });

  test('expired → exit 1', async () => {
    const stderr = makeFakeWritable();
    const code = await runDeviceFlow({
      apiUrl: 'http://test',
      memoroFetchAnon: async (_u, path) => {
        if (path === '/api/auth/device/init') {
          return {
            ok: true,
            user_code: 'ABCD',
            device_code: 'dc',
            verification_url: 'https://x/auth/device',
            verification_uri_complete: 'https://x/auth/device?code=ABCD',
            expires_in: 600,
            interval: 1,
          };
        }
        return { ok: true, status: 'expired' };
      },
      setSecret: async () => { throw new Error('nope'); },
      openBrowserFn: async () => true,
      deriveIdentity: () => ({ deviceName: 'h', deviceOs: 'o' }),
      sleep: async () => {},
      now: () => 1000,
      rand: () => 0,
      stdout: makeFakeWritable(),
      stderr,
      onSigint: () => () => {},
      sigintFlag: { cancelled: false },
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /expired/);
  });

  test('hard timeout at expires_in → exit 1', async () => {
    const stderr = makeFakeWritable();
    let t = 1000;
    const code = await runDeviceFlow({
      apiUrl: 'http://test',
      memoroFetchAnon: async (_u, path) => {
        if (path === '/api/auth/device/init') {
          return {
            ok: true,
            user_code: 'ABCD',
            device_code: 'dc',
            verification_url: 'https://x/auth/device',
            verification_uri_complete: 'https://x/auth/device?code=ABCD',
            expires_in: 2,  // 2 second window
            interval: 1,
          };
        }
        // Advance virtual time past the window on each poll.
        t += 5000;
        return { ok: true, status: 'pending' };
      },
      setSecret: async () => { throw new Error('nope'); },
      openBrowserFn: async () => true,
      deriveIdentity: () => ({ deviceName: 'h', deviceOs: 'o' }),
      sleep: async () => {},
      now: () => t,
      rand: () => 0,
      stdout: makeFakeWritable(),
      stderr,
      onSigint: () => () => {},
      sigintFlag: { cancelled: false },
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /timed out/);
  });

  test('init failure → exit 1', async () => {
    const stderr = makeFakeWritable();
    const code = await runDeviceFlow({
      apiUrl: 'http://test',
      memoroFetchAnon: async () => { throw new Error('network down'); },
      setSecret: async () => { throw new Error('nope'); },
      openBrowserFn: async () => true,
      deriveIdentity: () => ({ deviceName: 'h', deviceOs: 'o' }),
      sleep: async () => {},
      now: () => 1000,
      rand: () => 0,
      stdout: makeFakeWritable(),
      stderr,
      onSigint: () => () => {},
      sigintFlag: { cancelled: false },
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /failed to start device authorization/);
  });

  test('SIGINT mid-poll → exit 130, no token stored', async () => {
    const stderr = makeFakeWritable();
    const sigintFlag = { cancelled: false };
    let setCalled = false;
    const code = await runDeviceFlow({
      apiUrl: 'http://test',
      memoroFetchAnon: async (_u, path) => {
        if (path === '/api/auth/device/init') {
          return {
            ok: true,
            user_code: 'ABCD',
            device_code: 'dc',
            verification_url: 'https://x/auth/device',
            verification_uri_complete: 'https://x/auth/device?code=ABCD',
            expires_in: 600,
            interval: 1,
          };
        }
        // Flip the flag as soon as we'd poll.
        sigintFlag.cancelled = true;
        return { ok: true, status: 'pending' };
      },
      setSecret: async () => { setCalled = true; return 'keychain'; },
      openBrowserFn: async () => true,
      deriveIdentity: () => ({ deviceName: 'h', deviceOs: 'o' }),
      sleep: async () => {},
      now: () => 1000,
      rand: () => 0,
      stdout: makeFakeWritable(),
      stderr,
      onSigint: () => () => {},
      sigintFlag,
    });
    assert.equal(code, 130);
    assert.equal(setCalled, false, 'no token stored on cancel');
    assert.match(stderr.text, /cancelled/i);
  });
});

describe('runDeviceFlow — 429 backoff', () => {
  test('throws-429 on poll → doubles interval, keeps going', async () => {
    const stderr = makeFakeWritable();
    let pollCount = 0;
    const intervals = [];
    const code = await runDeviceFlow({
      apiUrl: 'http://test',
      memoroFetchAnon: async (_u, path) => {
        if (path === '/api/auth/device/init') {
          return {
            ok: true,
            user_code: 'ABCD',
            device_code: 'dc',
            verification_url: 'https://x/auth/device',
            verification_uri_complete: 'https://x/auth/device?code=ABCD',
            expires_in: 600,
            interval: 1,
          };
        }
        pollCount++;
        if (pollCount === 1) {
          const err = new Error('Memoro 429: too many requests');
          err.status = 429;
          throw err;
        }
        return {
          ok: true,
          status: 'authorized',
          token: 'mem_x',
          token_prefix: 'mem_x…',
          expires_at: '2026-08-29T12:00:00Z',
        };
      },
      setSecret: async () => 'keychain',
      openBrowserFn: async () => true,
      deriveIdentity: () => ({ deviceName: 'h', deviceOs: 'o' }),
      sleep: async (ms) => { intervals.push(ms); },
      now: () => 1000,
      rand: () => 0,
      stdout: makeFakeWritable(),
      stderr,
      onSigint: () => () => {},
      sigintFlag: { cancelled: false },
    });
    assert.equal(code, 0);
    // Two sleeps total: pre-poll-1 (1s), pre-poll-2 (2s after backoff doubled).
    assert.equal(intervals.length, 2);
    assert.equal(intervals[0], 1000);
    assert.equal(intervals[1], 2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// defaultSleep — sigintFlag bail-out
// ─────────────────────────────────────────────────────────────────────────────

describe('defaultSleep', () => {
  test('returns promptly when sigintFlag is already cancelled', async () => {
    const start = Date.now();
    await defaultSleep(500, { cancelled: true });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `expected fast bail, got ${elapsed}ms`);
  });

  test('sleeps roughly the requested duration when not cancelled', async () => {
    const start = Date.now();
    await defaultSleep(150, { cancelled: false });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 140, `slept ${elapsed}ms, want >= 140`);
    assert.ok(elapsed < 400, `slept ${elapsed}ms, want < 400`);
  });
});
