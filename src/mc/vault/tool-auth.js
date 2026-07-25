/**
 * Tool-auth adoption (docs/plans/mc-custody.md, S3).
 *
 * Captures a coding tool's own sign-in artifact into account custody
 * (class `tool-auth`) and hydrates it onto a fresh device, so "install +
 * sign in to memoro.me" yields tools that are already logged in.
 *
 * Trust rules (contract §1/§2): only this trusted runtime touches the
 * artifact — it is encrypted client-side before it leaves the process,
 * never logged, never printed, never placed anywhere the model can read.
 * Adoption is an explicit, confirmed user act.
 *
 * v1 semantics — portable login, not per-session JIT:
 *   - capture reads the tool's existing local auth (Claude Code: macOS
 *     Keychain first, then ~/.claude/.credentials.json; Codex:
 *     ~/.codex/auth.json).
 *   - hydrate writes the artifact to the tool's expected path (0600) and
 *     REFUSES to overwrite an existing login unless forced. The hydrated
 *     file becomes the device's login; it is not shredded at session end,
 *     because tools refresh these artifacts in place and shredding would
 *     lose the refreshed state. Tightening to JIT+shred needs refresh
 *     sync-back and is deliberately out of S3.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const TOOL_AUTH_LABEL_PREFIX = 'tool-auth:';

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Per-tool capture/hydrate description. Paths resolve lazily for tests. */
export const TOOL_AUTH_SPECS = Object.freeze({
  'claude-code': {
    label: `${TOOL_AUTH_LABEL_PREFIX}claude-code`,
    authPath: () => join(homedir(), '.claude', '.credentials.json'),
    keychainService: CLAUDE_KEYCHAIN_SERVICE,
  },
  codex: {
    label: `${TOOL_AUTH_LABEL_PREFIX}codex`,
    authPath: () => join(homedir(), '.codex', 'auth.json'),
    keychainService: null,
  },
});

export function resolveToolAuthSpec(tool) {
  const key = tool === 'claude' ? 'claude-code' : tool;
  return TOOL_AUTH_SPECS[key] ? { id: key, ...TOOL_AUTH_SPECS[key] } : null;
}

function defaultReadKeychain(service) {
  // -w prints only the secret body; stdout is captured, never echoed.
  const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const body = (r.stdout || '').trim();
  return body || null;
}

/**
 * Capture the tool's local auth artifact. Returns
 * { ok: true, payload: { kind: 'tool_auth', tool, source, body } } or
 * { ok: false, reason }. The body is an opaque string — this module never
 * parses or logs it.
 */
export function captureToolAuth(tool, {
  platform = process.platform,
  readKeychain = defaultReadKeychain,
  readFile = (p) => readFileSync(p, 'utf8'),
  exists = existsSync,
} = {}) {
  const spec = resolveToolAuthSpec(tool);
  if (!spec) return { ok: false, reason: `unknown tool "${tool}" — try claude or codex` };

  if (spec.keychainService && platform === 'darwin') {
    try {
      const body = readKeychain(spec.keychainService);
      if (body) {
        return { ok: true, payload: payloadFor(spec.id, 'keychain', body), label: spec.label };
      }
    } catch { /* fall through to the file path */ }
  }

  const path = spec.authPath();
  if (!exists(path)) {
    return { ok: false, reason: `no local ${spec.id} sign-in found — sign in to the tool first` };
  }
  try {
    const body = readFile(path);
    if (!body || !body.trim()) return { ok: false, reason: `local ${spec.id} auth file is empty` };
    return { ok: true, payload: payloadFor(spec.id, 'file', body), label: spec.label };
  } catch (err) {
    return { ok: false, reason: `could not read local ${spec.id} auth (${err.message})` };
  }
}

/**
 * Hydrate a captured artifact onto this device. Refuses to overwrite an
 * existing login unless `force` — a device with a live sign-in should not
 * be silently replaced by an older custody copy.
 */
export function hydrateToolAuth(payload, {
  force = false,
  exists = existsSync,
  writeFile = writeFileSync,
  mkdir = (d) => mkdirSync(d, { recursive: true, mode: 0o700 }),
  chmod = chmodSync,
  authPathOverride = null,
} = {}) {
  if (payload?.kind !== 'tool_auth' || typeof payload.body !== 'string' || !payload.body) {
    return { ok: false, reason: 'not a tool-auth payload' };
  }
  const spec = resolveToolAuthSpec(payload.tool);
  if (!spec) return { ok: false, reason: `unknown tool in payload: "${payload.tool}"` };
  const path = authPathOverride || spec.authPath();
  if (exists(path) && !force) {
    return { ok: false, reason: 'already-signed-in', path };
  }
  try {
    mkdir(dirname(path));
    writeFile(path, payload.body, { mode: 0o600 });
    try { chmod(path, 0o600); } catch { /* best effort */ }
    return { ok: true, path };
  } catch (err) {
    return { ok: false, reason: `could not write ${path} (${err.message})` };
  }
}

function payloadFor(toolId, source, body) {
  return { kind: 'tool_auth', tool: toolId, source, body };
}
