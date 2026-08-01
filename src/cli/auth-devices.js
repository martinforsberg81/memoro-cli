/**
 * `mc auth devices [list|revoke]` (§14e).
 *
 * Manages the device-scoped api-tokens for the signed-in account. Talks
 * to the server endpoints that ship in drev 5b-server:
 *   GET  /api/auth/devices
 *   POST /api/auth/devices/:id/revoke
 *
 * Resolution policy for `revoke <target>`:
 *   - exact tokenId match
 *   - case-insensitive name match (full string)
 *   - prefix match on token_prefix (e.g. "mem_a1b2…")
 *   Ambiguous prefix → friendly error listing candidates.
 *
 * Refuses to revoke the current device unless --confirm-self is passed.
 * The server enforces this too (rejecting same-token revoke), but the
 * client refuses first so the user gets a clear error.
 *
 * Per drev 5b-client brief: no `rename` sub-verb (server doesn't expose
 * it yet — §14 phase 3).
 */

import { getSecret as defaultGetSecret } from '../lib/keychain.js';
import { memoroFetch as defaultMemoroFetch } from '../lib/api.js';
import { ACCOUNTS } from '../commands/auth.js';
import { readConfig, getApiUrl } from '../lib/config.js';

const SUB_VERBS = new Set(['list', 'revoke']);

/**
 * Entry point. `argv` excludes the `devices` keyword (so argv[0] is the
 * optional sub-verb).
 *
 * `deps`: injectable for tests
 *   { getSecret, memoroFetch, apiUrl, stdout, stderr, readConfig, getApiUrl }
 */
export async function run(argv, deps = {}) {
  const sub = argv[0];
  if (!sub || sub === 'list' || sub === '--json' || (sub && sub.startsWith('-') && sub !== '--help')) {
    // `mc auth devices` defaults to list. Flags like `--json` slip through.
    const rest = sub === 'list' ? argv.slice(1) : argv;
    return runList(rest, deps);
  }
  if (sub === 'revoke') return runRevoke(argv.slice(1), deps);

  const { stderr = process.stderr } = deps;
  if (!SUB_VERBS.has(sub)) {
    stderr.write(`mc: unknown devices subcommand "${sub}". Try \`mc auth devices\` or \`mc auth devices revoke <prefix>\`.\n`);
    return 2;
  }
  return 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────────────────────

export async function runList(argv, deps = {}) {
  const opts = parseListArgs(argv);
  if (opts.error) {
    (deps.stderr || process.stderr).write(`mc: ${opts.error}\n`);
    return 2;
  }
  const ctx = await resolveContext(argv, deps);
  if (!ctx.ok) return ctx.code;

  let res;
  try {
    res = await ctx.memoroFetch(ctx.apiUrl, '/api/auth/devices', { token: ctx.token });
  } catch (err) {
    ctx.stderr.write(`mc: failed to list devices: ${err.message}\n`);
    return 1;
  }
  const devices = Array.isArray(res?.devices) ? res.devices : [];

  if (opts.json) {
    ctx.stdout.write(JSON.stringify({ devices }, null, 2) + '\n');
    return 0;
  }

  if (devices.length === 0) {
    ctx.stdout.write('No devices found.\n');
    return 0;
  }

  ctx.stdout.write(formatDeviceTable(devices));
  return 0;
}

/**
 * Pure renderer — takes the server's devices array, returns a formatted
 * string. Exported for tests.
 */
export function formatDeviceTable(devices) {
  const rows = devices.map((d) => ({
    name: d.name || '(unnamed)',
    expires: shortDate(d.expires_at),
    lastUsed: humanRelative(d.last_used_at) || '(never)',
    current: d.is_current ? '*' : '',
    prefix: d.token_prefix || '',
  }));
  const headers = { name: 'name', expires: 'expires_at', lastUsed: 'last_used', current: 'current', prefix: 'token_prefix' };
  const widths = {
    name:     Math.max(headers.name.length,     ...rows.map((r) => r.name.length)),
    expires:  Math.max(headers.expires.length,  ...rows.map((r) => r.expires.length)),
    lastUsed: Math.max(headers.lastUsed.length, ...rows.map((r) => r.lastUsed.length)),
    current:  Math.max(headers.current.length,  ...rows.map((r) => r.current.length)),
    prefix:   Math.max(headers.prefix.length,   ...rows.map((r) => r.prefix.length)),
  };
  const line = (r) =>
    `${r.name.padEnd(widths.name)}  ${r.expires.padEnd(widths.expires)}  ${r.lastUsed.padEnd(widths.lastUsed)}  ${r.current.padEnd(widths.current)}  ${r.prefix.padEnd(widths.prefix)}`.trimEnd() + '\n';
  const out = [];
  out.push(line(headers));
  out.push('-'.repeat(widths.name + widths.expires + widths.lastUsed + widths.current + widths.prefix + 8) + '\n');
  for (const r of rows) out.push(line(r));
  return out.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// revoke
// ─────────────────────────────────────────────────────────────────────────────

export async function runRevoke(argv, deps = {}) {
  const opts = parseRevokeArgs(argv);
  if (opts.error) {
    (deps.stderr || process.stderr).write(`mc: ${opts.error}\n`);
    return 2;
  }
  const ctx = await resolveContext(argv, deps);
  if (!ctx.ok) return ctx.code;

  // Fetch the list so we can resolve prefix-or-name-or-id.
  let res;
  try {
    res = await ctx.memoroFetch(ctx.apiUrl, '/api/auth/devices', { token: ctx.token });
  } catch (err) {
    ctx.stderr.write(`mc: failed to list devices: ${err.message}\n`);
    return 1;
  }
  const devices = Array.isArray(res?.devices) ? res.devices : [];

  const resolution = resolveTarget(devices, opts.target);
  if (resolution.kind === 'none') {
    ctx.stderr.write(`mc: no device matches "${opts.target}"\n`);
    return 1;
  }
  if (resolution.kind === 'ambiguous') {
    ctx.stderr.write(`mc: "${opts.target}" matched ${resolution.candidates.length} devices:\n`);
    for (const c of resolution.candidates) {
      ctx.stderr.write(`  - ${c.name || '(unnamed)'}  ${c.token_prefix || ''}\n`);
    }
    ctx.stderr.write(`Use a more specific prefix or the full token_prefix.\n`);
    return 1;
  }
  const device = resolution.device;

  if (device.is_current && !opts.confirmSelf) {
    ctx.stderr.write(`mc: refusing to revoke the current device. Re-run with --confirm-self to force.\n`);
    return 1;
  }

  try {
    await ctx.memoroFetch(
      ctx.apiUrl,
      `/api/auth/devices/${encodeURIComponent(device.id)}/revoke`,
      { token: ctx.token, method: 'POST' },
    );
  } catch (err) {
    ctx.stderr.write(`mc: failed to revoke device: ${err.message}\n`);
    return 1;
  }

  if (opts.json) {
    ctx.stdout.write(JSON.stringify({ ok: true, revoked: { id: device.id, name: device.name } }, null, 2) + '\n');
  } else {
    ctx.stdout.write(`✓ Revoked: ${device.name || device.id}\n`);
  }
  return 0;
}

/**
 * Resolution: try id → name (case-insensitive exact) → token_prefix
 * prefix-match. Pure. Exported for tests.
 */
export function resolveTarget(devices, target) {
  if (!target || !Array.isArray(devices) || devices.length === 0) {
    return { kind: 'none' };
  }
  // Direct id
  const byId = devices.find((d) => d.id === target);
  if (byId) return { kind: 'one', device: byId };
  // Exact name (case-insensitive)
  const byName = devices.filter((d) => (d.name || '').toLowerCase() === target.toLowerCase());
  if (byName.length === 1) return { kind: 'one', device: byName[0] };
  if (byName.length > 1)   return { kind: 'ambiguous', candidates: byName };
  // Prefix on token_prefix
  const byPrefix = devices.filter((d) => (d.token_prefix || '').startsWith(target));
  if (byPrefix.length === 1) return { kind: 'one', device: byPrefix[0] };
  if (byPrefix.length > 1)   return { kind: 'ambiguous', candidates: byPrefix };
  return { kind: 'none' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveContext(argv, deps) {
  const {
    getSecret = defaultGetSecret,
    memoroFetch = defaultMemoroFetch,
    stdout = process.stdout,
    stderr = process.stderr,
  } = deps;

  // apiUrl resolution: deps.apiUrl wins (tests), then config.
  let apiUrl = deps.apiUrl;
  if (!apiUrl) {
    apiUrl = getApiUrl(argv);
    if (!apiUrl) {
      try {
        const cfg = await readConfig();
        apiUrl = cfg.apiUrl;
      } catch { /* default below */ }
    }
  }
  if (!apiUrl) apiUrl = 'https://meetmemoro.app';

  let token;
  try {
    token = await getSecret(ACCOUNTS.TOKEN);
  } catch {
    token = null;
  }
  if (!token) {
    stderr.write(`mc: no Memoro token. Run \`mc\` to start the device-flow, or \`memoro-cli login\` for CI.\n`);
    return { ok: false, code: 1 };
  }
  return { ok: true, apiUrl, token, memoroFetch, getSecret, stdout, stderr };
}

export function parseListArgs(argv) {
  const opts = { json: false };
  for (const a of argv || []) {
    if (a === '--json') { opts.json = true; continue; }
    if (a === 'list')    { continue; }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
}

export function parseRevokeArgs(argv) {
  const opts = { target: null, confirmSelf: false, json: false };
  for (const a of argv || []) {
    if (a === '--confirm-self') { opts.confirmSelf = true; continue; }
    if (a === '--json')         { opts.json = true; continue; }
    if (a.startsWith('--'))     { return { error: `unknown flag: ${a}` }; }
    if (!opts.target) { opts.target = a; continue; }
    return { error: `unexpected positional arg: ${a}` };
  }
  if (!opts.target) return { error: 'revoke requires a prefix, name, or id' };
  return opts;
}

function shortDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

export function humanRelative(iso, { now = Date.now } = {}) {
  if (!iso) return '';
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const delta = Math.max(0, now() - t);
    const sec = Math.floor(delta / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24)  return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  } catch {
    return '';
  }
}
