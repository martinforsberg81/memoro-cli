/**
 * Antigravity CLI plan quota, read from `agy -p /usage --output-format text`.
 *
 * agy has no usage API, so the one read is its own `/usage` slash command run
 * headless (slash commands enabled: the launch's `--disable-slash-commands` is
 * not passed). It prints, per model group, a "Five Hour Limit Remaining" and a
 * "Weekly Limit Remaining" percentage, and may print when each resets. The
 * format is documented, not recorded (the goal's R1/R3): the parse is strict
 * about what it takes as a number and says nothing it did not read.
 *
 * What is stored is only what was read (mc-run.md, the capacity contract):
 *   - a window with a printed reset is a window, `{ fraction_used, resets_at }`;
 *   - a window with no printed reset is not stored, so it reads unknown and the
 *     tool bootstraps on it; no reset is invented;
 *   - a window at or over the plan limit without a printed reset is a refusal
 *     (`refusal_until` = the read's time + `QUOTA_SLEEP_MS`, as `refuseProvider`
 *     does for a refusal that names no reset), renewed by each read while it
 *     stays full;
 *   - output that does not parse is a failed read: the last valid snapshot is
 *     kept and marked failed, and the reader stops for the life of the runner
 *     (a `/usage` agy took as a prompt would otherwise cost a turn every poll).
 * Of the model groups, the tightest window is the provider's (conservative
 * until a recorded output shows which group a slug belongs to).
 *
 * The child runs in the runner's environment with the provider API keys and the
 * tool's own launch-dropped variables removed, as every unattended launch does.
 */
import { execFile } from 'node:child_process';

import { declared, resolveLaunch } from '../adapters/index.js';
import { PLAN_LIMIT_UTILIZATION } from './model-choice.js';
import { applyCollectedCapacity, applyRefusal, readCapacity, writeCapacity } from './model-capacity.js';
import { runnerDir, workRoot } from './paths.js';
import { realLock } from './runner-lock.js';
import { scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { QUOTA_SLEEP_MS } from './run-plan.js';

export const AGY_USAGE_TIMEOUT_MS = 60_000;
export const AGY_USAGE_MAX_BYTES = 1 << 20;
/** The arguments of the one read: the slash command as the prompt, in text mode. */
export const AGY_USAGE_ARGS = Object.freeze(['-p', '/usage', '--output-format', 'text']);

const WINDOW_LINE = /\b(five[\s-]*hour|weekly)\s+limit\s+remaining\b[^0-9\n]*?(\d+(?:\.\d+)?)\s*%/iu;
const RESET_INSTANT = /\b(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))/u;
const RESET_IN = /\bresets?\s+in\s+((?:\d+\s*[dhm]\s*)+)/iu;

const instant = (text) => {
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/** The instant a line prints a reset at, an ISO instant or "resets in 2d 3h 10m" from `now`, or null. */
function printedReset(line, now) {
  const iso = RESET_INSTANT.exec(line)?.[1];
  if (iso) return instant(iso);
  const span = RESET_IN.exec(line)?.[1];
  if (!span) return null;
  let ms = 0;
  for (const [, count, unit] of span.matchAll(/(\d+)\s*([dhm])/giu)) ms += Number(count) * ({ d: 86_400_000, h: 3_600_000, m: 60_000 })[unit.toLowerCase()];
  return ms > 0 ? new Date(now.getTime() + ms).toISOString() : null;
}

/**
 * `{ windows, full }` of a `/usage` text, or null when it holds no limit line.
 * `windows` is `{ five_hour, weekly }`, each `{ fraction_used, resets_at }` of
 * the tightest group that printed a reset, or null; `full` is true when a
 * window at or over the plan limit printed none. A reset on the next line
 * ("Resets …") belongs to the limit line above it.
 */
export function parseAgyUsage(text, now = new Date()) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const readings = { five_hour: [], weekly: [] };
  lines.forEach((line, at) => {
    const match = WINDOW_LINE.exec(line);
    if (!match) return;
    const remaining = Number(match[2]);
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) return;
    const name = /^five/iu.test(match[1]) ? 'five_hour' : 'weekly';
    const next = lines[at + 1] ?? '';
    const reset = printedReset(line, now) ?? (WINDOW_LINE.test(next) ? null : printedReset(next, now));
    readings[name].push({ fraction_used: 1 - remaining / 100, resets_at: reset });
  });
  if (!readings.five_hour.length && !readings.weekly.length) return null;
  const windows = {};
  let full = false;
  for (const [name, list] of Object.entries(readings)) {
    const tightest = list.reduce((a, b) => (!a || b.fraction_used > a.fraction_used ? b : a), null);
    if (!tightest) { windows[name] = null; continue; }
    if (tightest.resets_at) { windows[name] = { fraction_used: Math.round(tightest.fraction_used * 1e6) / 1e6, resets_at: tightest.resets_at }; continue; }
    windows[name] = null;
    if (tightest.fraction_used >= PLAN_LIMIT_UTILIZATION) full = true;
  }
  return { windows, full };
}

/** What the child runs with: the runner's environment less provider API keys and the tool's own dropped variables. */
function childEnv(env, tool) {
  const next = scrubProviderApiKeysFromEnv(env);
  for (const name of declared(tool, 'LAUNCH_DROP_ENV') ?? []) delete next[name];
  return next;
}

function defaultRun(bin, args, { env, timeout, maxBuffer }) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout, maxBuffer, encoding: 'utf8' }, (error, stdout) => {
      resolve({ error, stdout: String(stdout ?? '') });
    });
  });
}

/**
 * One read: `{ ok: true, windows, full }`, or `{ ok: false, why, unparsed }`
 * where `unparsed` marks output agy printed that holds no limit line. Never
 * throws; injectable `run` and `launch` keep tests off the binary.
 */
export async function collectAgyCapacity({ tool = 'agy', env = process.env, now = new Date(), run = defaultRun, launch = resolveLaunch, timeoutMs = AGY_USAGE_TIMEOUT_MS, maxBytes = AGY_USAGE_MAX_BYTES } = {}) {
  const resolved = launch(tool);
  if (!resolved?.ok) return { ok: false, why: resolved?.hint || 'agy is not installed', unparsed: false };
  let answer;
  try { answer = await run(resolved.spec.bin, [...AGY_USAGE_ARGS], { env: childEnv(env, resolved.id), timeout: timeoutMs, maxBuffer: maxBytes }); } catch (error) { answer = { error, stdout: '' }; }
  const read = parseAgyUsage(answer.stdout, now);
  if (read) return { ok: true, ...read };
  if (answer.error && !answer.stdout.trim()) {
    return { ok: false, why: answer.error.killed ? `agy /usage did not answer within ${timeoutMs} ms` : `agy /usage failed: ${answer.error.message?.split('\n')[0] || 'no reason given'}`, unparsed: false };
  }
  return { ok: false, why: 'agy /usage printed no five-hour or weekly limit line', unparsed: true };
}

/**
 * The reader `run.js` registers for the `agy-usage` mechanism: collect, then
 * apply under the runner lock. The first unparsed read answers `stop: true`
 * with its reason: the runner's ticker says it once in the runner log and
 * never calls the reader again, and the reader itself runs agy no more.
 */
export function makeAgyUsageReader({ provider, env = process.env, now = () => new Date(), collect = collectAgyCapacity, lock = realLock, ...options } = {}) {
  let stopped = false;
  return async () => {
    if (stopped) return { ok: false, stop: true, why: 'agy /usage printed no limit line earlier in this run' };
    const at = now();
    const before = JSON.stringify(readCapacity({ root: runnerDir(env) }).providers[provider]);
    const got = await collect({ env, now: at, ...options });
    if (got.unparsed) stopped = true;
    const root = runnerDir(env);
    const state = lock(workRoot(env), () => {
      let next = applyCollectedCapacity(readCapacity({ root }), provider, got, at, before);
      if (got.ok && got.full) next = applyRefusal(next, provider, new Date(at.getTime() + QUOTA_SLEEP_MS).toISOString());
      return writeCapacity(next, { root });
    }, { name: 'agy-capacity' });
    return { ...got, stop: got.unparsed === true, state };
  };
}
