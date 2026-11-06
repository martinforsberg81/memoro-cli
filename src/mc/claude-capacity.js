/** Read Claude subscription windows from the installed Claude Code login. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Leave the installed Keychain lookup's 5 s bound inside the 20 s total.
export const CLAUDE_TIMEOUT_MS = 15_000;
export const CLAUDE_MAX_BYTES = 1 << 20;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export function readClaudeCredential({ platform = process.platform, home = homedir(), readFile = readFileSync, exists = existsSync, readKeychain } = {}) {
  if (platform === 'darwin') {
    try {
      const result = (readKeychain || ((service) => spawnSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: 5_000 })))(KEYCHAIN_SERVICE);
      const raw = typeof result === 'string' ? result : result?.status === 0 ? result.stdout : null;
      if (raw) return JSON.parse(raw).claudeAiOauth?.accessToken || null;
    } catch { /* try the tool's standard file below */ }
  }
  try {
    const path = join(home, '.claude', '.credentials.json');
    if (!exists(path)) return null;
    return JSON.parse(readFile(path, 'utf8')).claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

function resetInstant(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u);
  if (!match) return null;
  const [, year, month, day] = match;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendarDate.getUTCFullYear() !== Number(year) || calendarDate.getUTCMonth() + 1 !== Number(month) || calendarDate.getUTCDate() !== Number(day)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function claudeUsageWindows(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const windows = {};
  for (const key of ['five_hour', 'seven_day']) {
    const item = value[key];
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.utilization !== 'number' || !Number.isFinite(item.utilization)
      || item.utilization < 0 || item.utilization > 100) return null;
    const resets_at = resetInstant(item.resets_at);
    if (!resets_at) return null;
    windows[key] = { fraction_used: item.utilization / 100, resets_at };
  }
  return windows;
}

async function readBounded(response, cap) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('response body unavailable');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel(); throw new Error('response exceeds size limit'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Sanitized {ok, windows} or {ok:false, why}; injectable boundaries keep tests offline. */
export async function collectClaudeCapacity({ credentials = readClaudeCredential, fetch: fetcher = globalThis.fetch, timeoutMs = CLAUDE_TIMEOUT_MS, maxBytes = CLAUDE_MAX_BYTES, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let token;
  try { token = await credentials(); } catch { token = null; }
  if (typeof token !== 'string' || !token.trim()) return { ok: false, why: 'Claude subscription login unavailable' };
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimer(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); });
    const response = await Promise.race([fetcher(CLAUDE_USAGE_URL, {
      method: 'GET', headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      redirect: 'manual', signal: controller.signal,
    }), timeout]);
    if (response.status >= 300 && response.status < 400) return { ok: false, why: 'Claude subscription request redirected' };
    if (!response.ok) return { ok: false, why: `Claude subscription request failed (HTTP ${response.status})` };
    const raw = await Promise.race([readBounded(response, maxBytes), timeout]);
    let body;
    try { body = JSON.parse(raw); } catch { return { ok: false, why: 'Claude subscription response was not valid JSON' }; }
    const windows = claudeUsageWindows(body);
    return windows ? { ok: true, windows } : { ok: false, why: 'Claude subscription response had an invalid schema' };
  } catch (error) {
    return { ok: false, why: error?.message === 'timeout' || controller.signal.aborted ? 'Claude subscription request timed out' : 'Claude subscription request unavailable' };
  } finally { if (timer) clearTimer(timer); }
}
