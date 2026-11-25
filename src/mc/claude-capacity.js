/** Read Claude subscription windows from the installed Claude Code login. */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { patchBillingState, readBillingState } from './billing.js';
import { collectedCapacity, providerAt, readCapacity, writeCapacity } from './model-capacity.js';
import { runnerDir, workRoot } from './paths.js';
import { realLock } from './runner-lock.js';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Leave the installed Keychain lookup's 5 s bound inside the 20 s total.
export const CLAUDE_TIMEOUT_MS = 15_000;
export const CLAUDE_MAX_BYTES = 1 << 20;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** The login's item, read without blocking the runner's event loop: bounded to 5 s, no shell, nothing written. */
function keychainItem(service) {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1 << 16 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

export async function readClaudeCredential({ platform = process.platform, home = homedir(), readFile = readFileSync, exists = existsSync, readKeychain = keychainItem } = {}) {
  if (platform === 'darwin') {
    try {
      const result = await readKeychain(KEYCHAIN_SERVICE);
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

/** One window of a usage body: `{ window, unread }`, where `unread` is the first rule it fails, as a fixed word. */
function claudeWindow(item) {
  if (item === undefined || item === null) return { window: null, unread: 'absent' };
  if (typeof item !== 'object' || Array.isArray(item)) return { window: null, unread: 'not an object' };
  if (typeof item.utilization !== 'number' || !Number.isFinite(item.utilization)
    || item.utilization < 0 || item.utilization > 100) return { window: null, unread: 'utilization' };
  const resets_at = resetInstant(item.resets_at);
  if (!resets_at) return { window: null, unread: 'resets_at' };
  return { window: { fraction_used: item.utilization / 100, resets_at }, unread: null };
}

/**
 * `{ windows, unread }` of a usage body. Each of `five_hour` and `seven_day` is
 * validated on its own: a window that validates is `{ fraction_used, resets_at }`,
 * any other is null and named in `unread` by one of four fixed words. A body that
 * is not a plain object leaves both windows absent. No value from the body is kept.
 */
export function claudeUsageWindows(value) {
  const plain = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const windows = {};
  const unread = {};
  for (const key of ['five_hour', 'seven_day']) {
    const { window, unread: word } = plain ? claudeWindow(value[key]) : { window: null, unread: 'absent' };
    windows[key] = window;
    if (word) unread[key] = word;
  }
  return { windows, unread };
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
    const { windows, unread } = claudeUsageWindows(body);
    if (windows.five_hour || windows.seven_day) return { ok: true, windows, unread };
    return { ok: false, why: `Claude subscription response had an invalid schema (five_hour: ${unread.five_hour}; seven_day: ${unread.seven_day})` };
  } catch (error) {
    return { ok: false, why: error?.message === 'timeout' || controller.signal.aborted ? 'Claude subscription request timed out' : 'Claude subscription request unavailable' };
  } finally { if (timer) clearTimer(timer); }
}

const live = (value, now) => Number.isFinite(Date.parse(value || '')) && Date.parse(value) > now.getTime();

/**
 * The reader `run.js` registers for the `claude-usage` mechanism. The network
 * read is over before the runner lock; under it the latest whole capacity file
 * is patched (`collectedCapacity`), so stream and refusal observations and the
 * other providers survive, and a stale answer is dropped by the baseline taken
 * before the read. A read that shows no spent window lifts a held `quota` or
 * `login` refusal of claude and the plan refusal billing-state.json holds
 * (`plan.refused_until`, a quota's); while a `host` refusal still holds claude
 * it lifts them and says nothing is lifted. Answers the collector's
 * `{ ok, windows, unread }` or `{ ok: false, why }` with the `state` written
 * and `lifted`: `{ cause, until }` of the refusal it lifted, else null.
 * `capacity`, `billing`, `collect`, `lock` and `now` are injectable.
 */
export function makeClaudeUsageReader({
  provider = 'claude', env = process.env, now = () => new Date(), collect = () => collectClaudeCapacity(), lock = realLock,
  capacity = { read: () => readCapacity({ root: runnerDir(env) }), write: (state) => writeCapacity(state, { root: runnerDir(env) }) },
  billing = { readState: () => readBillingState({ root: runnerDir(env) }), patchState: (patch) => patchBillingState(patch, { root: runnerDir(env) }) },
} = {}) {
  return async () => {
    const at = now();
    const before = JSON.stringify(capacity.read().providers[provider]);
    const got = await collect();
    let lifted = null;
    const state = lock(workRoot(env), () => {
      const read = collectedCapacity(capacity.read(), provider, got, at, before);
      lifted = read.lifted;
      const written = capacity.write(read.state) ?? read.state;
      if (read.clean) {
        const plan = billing.readState()?.plan?.refused_until;
        if (plan) billing.patchState({ plan: { refused_until: null } });
        // Claude is usable again only when no refusal still holds it: a host refusal stays with its check.
        if (!lifted && live(plan, at) && !providerAt(written, provider, at).refusal_until) lifted = { cause: 'quota', until: plan };
      }
      return written;
    }, { name: 'claude-capacity' });
    return { ...got, state, lifted };
  };
}
