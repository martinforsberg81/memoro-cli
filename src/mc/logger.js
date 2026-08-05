/**
 * One place where mc says what it is doing.
 *
 * Today's debugging cost a day because every layer refused silently: six bare
 * `return 1`s in one file, a swallowed exception, a teardown check that
 * overwrote the cause, reason codes with no subject. The fix for that is not
 * another reason code — it is a record that exists whether or not anyone
 * thought to look.
 *
 * Append-only JSONL under `<mc home>/logs/mc.log`, bounded, private, never
 * transmitted. Values are recorded as given, so callers pass identifiers,
 * paths, codes and counts — never environment values, tokens, or transcript
 * text.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { mcHome } from './paths.js';

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_FIELD_CHARS = 2048;

let logPathOverride = null;

export function setLogPath(path) {
  logPathOverride = path || null;
}

export function logPath() {
  return logPathOverride || join(mcHome(), 'logs', 'mc.log');
}

/**
 * Record one event. Never throws: a logger that can fail a launch is worse
 * than no logger.
 */
export function log(event, fields = {}) {
  try {
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      event: String(event).slice(0, 128),
      ...bounded(fields),
    })}\n`;
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rotateIfLarge(path);
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  } catch { /* logging never fails the caller */ }
}

/** Record a failure with its reason, and return the value unchanged. */
export function logFailure(event, result, fields = {}) {
  log(event, {
    ok: result?.ok === true,
    reason: result?.reason || result?.code || null,
    ...fields,
  });
  return result;
}

function bounded(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 64).map((item) => String(item).slice(0, MAX_FIELD_CHARS));
      continue;
    }
    out[key] = String(value).slice(0, MAX_FIELD_CHARS);
  }
  return out;
}

function rotateIfLarge(path) {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch { /* absent or unrotatable is fine */ }
}
