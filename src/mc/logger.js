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
 *
 * ## The run id
 *
 * On 2026-08-30 two merge rounds were killed from outside mid-round, the
 * first after #11082 had already landed and before #11085 was reached. The
 * facts survived — but in three files that nothing joined: `leases.log` had
 * the claim at 09:48 and the reap at 10:01 saying pid 175 was gone,
 * `gate-rounds.jsonl` had no line at all for either round (it is written when
 * a round ends, and these did not end), and `mc.log` was not written by the
 * merge path in the first place. Reconstructing it took reading three files
 * by hand and a throwaway script.
 *
 * So every line one invocation writes carries the same `run` — the id that
 * makes those files one story instead of three. It is a process-lifetime id,
 * generated on first use and never reported in from outside, because a
 * caller that could name its own run could also name somebody else's.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { mcHome } from './paths.js';

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_FIELD_CHARS = 2048;

let logPathOverride = null;
let currentRun = null;

export function setLogPath(path) {
  logPathOverride = path || null;
}

export function logPath() {
  return logPathOverride || join(mcHome(), 'logs', 'mc.log');
}

/**
 * This process's run id, stable for its lifetime.
 *
 * Short and prefixed so it can be typed at `mc log --round`: a uuid is
 * unambiguous and nobody transcribes one correctly from a terminal.
 */
export function runId() {
  if (!currentRun) currentRun = `run_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  return currentRun;
}

/** Start a fresh run id. For tests, which need two runs in one process. */
export function resetRunId() {
  currentRun = null;
  return runId();
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
      run: runId(),
      event: String(event).slice(0, 128),
      ...bounded(fields),
    })}\n`;
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rotateIfLarge(path);
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  } catch { /* logging never fails the caller */ }
}

/**
 * An invocation reduced to what is safe to keep forever.
 *
 * The argument vector is the most useful thing to have when a command
 * misbehaved and the most dangerous thing to write down: `mc work send x
 * "<message>"` carries a person's words, and this file's whole promise is
 * that it holds identifiers, paths, codes and counts and nothing else.
 *
 * So the rule is shape, not content. Flags are kept by NAME and their values
 * dropped — `--model opus` becomes `--model`, because which flags were passed
 * is what a diagnosis turns on and the value rarely is. Positionals are kept
 * only when they look like an identifier: no whitespace, a short conservative
 * alphabet, 64 characters at most. That admits `memoro`, `11082`, `#473`,
 * `mc-log`; it excludes prose, quoted text, urls with query strings, and
 * anything with a space in it.
 *
 * A single-word message would still pass that filter, so verbs whose tail is
 * free text by construction drop their positionals entirely. Two mechanisms
 * where one would do, deliberately: the filter is the rule, and the list is
 * the admission that the rule is not tight enough on its own.
 */
const FREE_TEXT_TAILS = new Set(['claim', 'helper']);
const IDENTIFIERISH = /^[A-Za-z0-9@#._/-]{1,64}$/u;

export function invocationShape(argv = []) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const verb = args[0] && !args[0].startsWith('-') ? args[0] : null;
  const sub = args[1] && !args[1].startsWith('-') ? args[1] : null;
  const freeText = FREE_TEXT_TAILS.has(verb) || FREE_TEXT_TAILS.has(sub);
  const flags = [];
  const rest = [];
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith('-')) {
      const [name] = arg.split('=');
      if (!flags.includes(name)) flags.push(name);
      continue;
    }
    // Already named as verb and subcommand; not repeated here.
    if (arg === verb && index === 0) continue;
    if (arg === sub && index === 1) continue;
    // The value of a flag is not a positional. Dropped without inspecting it:
    // `--model opus` and `--message "…"` are the same shape from here.
    if (index > 0 && args[index - 1].startsWith('-') && !args[index - 1].includes('=')) continue;
    if (freeText) continue;
    if (IDENTIFIERISH.test(arg)) rest.push(arg);
  }
  return {
    verb: verb || '(page)',
    sub: sub || null,
    args: rest.slice(0, 12),
    flags: flags.slice(0, 24),
    argc: args.length,
  };
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
