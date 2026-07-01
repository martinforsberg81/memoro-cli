/**
 * Memoro HTTP client.
 * Thin wrapper around fetch — auth header + JSON + error mapping.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 20_000;

export async function memoroFetch(apiUrl, path, {
  token,
  method = 'GET',
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  curlImpl = runCurlRequest,
  curlFallback = process.env.MEMORO_CURL_FALLBACK !== '0',
} = {}) {
  if (!apiUrl) throw new Error('apiUrl missing');
  if (!token) throw new Error('Not logged in. Run `memoro-cli login` first.');

  const url = `${apiUrl.replace(/\/$/, '')}${path}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': `memoro-cli/${await pkgVersion()}`,
  };
  if (body != null) headers['Content-Type'] = 'application/json';

  return _doFetch(url, { method, headers, body, timeoutMs, fetchImpl, curlImpl, curlFallback });
}

/**
 * Anonymous variant — used by pre-auth endpoints like the OAuth Device
 * Flow init/poll. No Authorization header. Same response/error shape as
 * memoroFetch so callers can share error handling.
 *
 * Kept as a separate export rather than relaxing memoroFetch's `token`
 * check so the "not logged in" guard on the authenticated path stays
 * loud + early — every existing caller still trips it on a missing token.
 */
export async function memoroFetchAnon(apiUrl, path, {
  method = 'GET',
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  curlImpl = runCurlRequest,
  curlFallback = process.env.MEMORO_CURL_FALLBACK !== '0',
} = {}) {
  if (!apiUrl) throw new Error('apiUrl missing');
  const url = `${apiUrl.replace(/\/$/, '')}${path}`;
  const headers = {
    'User-Agent': `memoro-cli/${await pkgVersion()}`,
  };
  if (body != null) headers['Content-Type'] = 'application/json';

  return _doFetch(url, { method, headers, body, timeoutMs, fetchImpl, curlImpl, curlFallback });
}

async function _doFetch(url, { method, headers, body, timeoutMs, fetchImpl, curlImpl, curlFallback }) {

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Memoro request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (curlFallback) {
      let fallback;
      try {
        fallback = await curlImpl(url, { method, headers, body, timeoutMs });
      } catch (curlErr) {
        throw new Error(`Memoro request failed: ${describeFetchError(err)}; curl fallback failed: ${curlErr.message}`);
      }
      return parseMemoroResponse(fallback.status, fallback.text);
    }
    throw new Error(`Memoro request failed: ${describeFetchError(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  return parseMemoroResponse(response.status, text);
}

function parseMemoroResponse(status, text) {
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { /* leave raw */ }
  }

  if (status < 200 || status >= 300) {
    const msg = data?.error || text || `HTTP ${status}`;
    const err = new Error(`Memoro ${status}: ${msg}`);
    err.status = status;
    err.data = data;
    throw err;
  }

  return data;
}

function describeFetchError(err) {
  const cause = err?.cause;
  if (cause?.code && cause?.hostname) {
    return `${err.message} (${cause.code} ${cause.hostname})`;
  }
  if (cause?.code) {
    return `${err.message} (${cause.code})`;
  }
  return err?.message || String(err);
}

async function runCurlRequest(url, { method, headers, body, timeoutMs }) {
  const args = [
    '--silent',
    '--show-error',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '--config', '-',
    '--write-out', '\n%{http_code}',
  ];
  const config = buildCurlConfig(url, { method, headers, body });

  const { stdout, stderr, code } = await spawnWithInput('curl', args, config);
  if (code !== 0) {
    throw new Error(stderr.trim() || `curl exited ${code}`);
  }

  const marker = stdout.match(/\n([0-9]{3})$/);
  if (!marker) {
    throw new Error('curl returned an unexpected response');
  }
  return {
    status: Number(marker[1]),
    text: stdout.slice(0, marker.index),
  };
}

function buildCurlConfig(url, { method, headers, body }) {
  const lines = [
    `url = ${curlQuote(url)}`,
    `request = ${curlQuote(method)}`,
  ];
  for (const [name, value] of Object.entries(headers || {})) {
    lines.push(`header = ${curlQuote(`${name}: ${value}`)}`);
  }
  if (body != null) {
    lines.push(`data-binary = ${curlQuote(JSON.stringify(body))}`);
  }
  return `${lines.join('\n')}\n`;
}

function curlQuote(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function spawnWithInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

let _cachedVersion = null;
async function pkgVersion() {
  if (_cachedVersion) return _cachedVersion;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '..', '..', 'package.json'), 'utf8'));
    _cachedVersion = pkg.version || 'dev';
  } catch {
    _cachedVersion = 'dev';
  }
  return _cachedVersion;
}
