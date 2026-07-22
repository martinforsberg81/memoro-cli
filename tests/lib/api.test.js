import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoroFetch, memoroFetchAnon } from '../../src/lib/api.js';

function dnsFailure() {
  const err = new TypeError('fetch failed');
  err.cause = {
    code: 'ENOTFOUND',
    hostname: 'meetmemoro.app',
  };
  return err;
}

describe('memoro HTTP client', () => {
  test('uses fetch response when fetch succeeds', async () => {
    let curlCalled = false;
    const result = await memoroFetchAnon('https://meetmemoro.app', '/api/version', {
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      curlImpl: async () => {
        curlCalled = true;
        throw new Error('must not call curl');
      },
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(curlCalled, false);
  });

  test('falls back to curl when Node fetch fails before an HTTP response', async () => {
    const calls = [];
    const result = await memoroFetchAnon('https://meetmemoro.app', '/api/mc/supervisor/device/init', {
      method: 'POST',
      body: { device_name: 'h', device_os: 'darwin' },
      fetchImpl: async () => {
        throw dnsFailure();
      },
      curlImpl: async (url, opts) => {
        calls.push({ url, opts });
        return { status: 200, text: JSON.stringify({ ok: true, user_code: 'ABCD-1234' }) };
      },
    });

    assert.deepEqual(result, { ok: true, user_code: 'ABCD-1234' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://meetmemoro.app/api/mc/supervisor/device/init');
    assert.deepEqual(calls[0].opts.body, { device_name: 'h', device_os: 'darwin' });
  });

  test('curl fallback is available to authenticated requests without changing headers', async () => {
    const result = await memoroFetch('https://meetmemoro.app', '/api/mc/supervisor', {
      token: 'mem_secret_token',
      fetchImpl: async () => {
        throw dnsFailure();
      },
      curlImpl: async (_url, opts) => {
        assert.equal(opts.headers.Authorization, 'Bearer mem_secret_token');
        return { status: 200, text: JSON.stringify({ ok: true, revision: 1 }) };
      },
    });

    assert.deepEqual(result, { ok: true, revision: 1 });
  });

  test('adds only a validated Memoro source identity header', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await memoroFetch('https://meetmemoro.app', '/api/mc/github/test', {
      token: 'mem_secret_token',
      sourceId: 'cloud:cld_123456',
      fetchImpl,
    });
    await memoroFetch('https://meetmemoro.app', '/api/mc/github/test', {
      token: 'mem_secret_token',
      sourceId: 'invalid source\r\nX-Evil: yes',
      fetchImpl,
    });

    assert.equal(calls[0].init.headers['X-Memoro-Source-Id'], 'cloud:cld_123456');
    assert.equal(calls[1].init.headers['X-Memoro-Source-Id'], undefined);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer mem_secret_token');
  });

  test('maps curl fallback HTTP errors like fetch HTTP errors', async () => {
    await assert.rejects(
      () => memoroFetchAnon('https://meetmemoro.app', '/api/auth/device/poll', {
        method: 'POST',
        body: { device_code: 'secret-device-code' },
        fetchImpl: async () => {
          throw dnsFailure();
        },
        curlImpl: async () => ({ status: 429, text: JSON.stringify({ error: 'slow down' }) }),
      }),
      (err) => {
        assert.equal(err.status, 429);
        assert.match(err.message, /Memoro 429: slow down/);
        return true;
      },
    );
  });

  test('includes fetch cause details when curl fallback is disabled', async () => {
    await assert.rejects(
      () => memoroFetchAnon('https://meetmemoro.app', '/api/version', {
        curlFallback: false,
        fetchImpl: async () => {
          throw dnsFailure();
        },
      }),
      /Memoro request failed: fetch failed \(ENOTFOUND meetmemoro\.app\)/,
    );
  });
});
