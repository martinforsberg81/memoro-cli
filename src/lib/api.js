/**
 * Memoro HTTP client.
 * Thin wrapper around fetch — auth header + JSON + error mapping.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

export async function memoroFetch(apiUrl, path, { token, method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiUrl) throw new Error('apiUrl missing');
  if (!token) throw new Error('Not logged in. Run `memoro-cli login` first.');

  const url = `${apiUrl.replace(/\/$/, '')}${path}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': `memoro-cli/${await pkgVersion()}`,
  };
  if (body != null) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Memoro request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`Memoro request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { /* leave raw */ }
  }

  if (!response.ok) {
    const msg = data?.error || text || `HTTP ${response.status}`;
    const err = new Error(`Memoro ${response.status}: ${msg}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
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
