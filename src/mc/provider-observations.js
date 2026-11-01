/**
 * What real provider sessions have shown on this machine, per tool version:
 * `~/mc/runner/provider-observations.json`, the only source of capability
 * support. A session is `session` (a clean build or review process), `control`
 * (it called `mc session-control`) or `interrupt` (supervision signalled it).
 *
 * Support is bound to the version observed, so a new tool version has none
 * until it is observed again. That refuses `autonomy on` and nothing else: a
 * sent goal never consults support.
 *
 * A fixture capability records nothing, and recording never fails a session.
 *
 * Deps: `toolVersion` (bin to version), so a test never runs a provider CLI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { releaseClaim, takeClaim } from './resource-claim.js';

export const SIGNALS = Object.freeze(['session', 'control', 'interrupt']);

/** Each control capability's one observation; no `role` means any role shows it. */
const NEEDS = Object.freeze({
  'programme-jobs': { signal: 'session' },
  'programme-plan': { signal: 'session' },
  build: { signal: 'session', role: 'step' },
  review: { signal: 'session', role: 'review' },
  'control-signals': { signal: 'control' },
  interrupt: { signal: 'interrupt' },
});

const VERSION_TIMEOUT_MS = 5000;
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 20;
const CONTROL_READ_FILE = 'session-control-read.json';

export function observationsPath(root) {
  return join(root, 'runner', 'provider-observations.json');
}

/** The first line `<bin> --version` prints, or null when it says nothing usable. */
export function toolVersion(bin, { spawn = spawnSync } = {}) {
  const result = spawn(bin, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim().split('\n')[0].trim() || null;
}

/** Every observation. No file is none; a file that is not ours throws. */
export function readObservations(root) {
  const path = observationsPath(root);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const document = JSON.parse(text);
  if (document?.version !== 1 || !Array.isArray(document.observations)) throw new Error(`invalid provider observations: ${path}`);
  return document.observations;
}

function lockObservations(path) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const held = takeClaim(path, { pid: process.pid });
    if (held.ok) return held;
    if (held.error || Date.now() >= deadline) throw new Error(held.error || 'provider observations are held');
    Atomics.wait(pause, 0, 0, LOCK_POLL_MS);
  }
}

/** Appends under a lock: lanes finish sessions concurrently, and one rewrite must not lose another's. */
export function recordObservations(root, entries) {
  if (!entries.length) return;
  const path = observationsPath(root);
  const lock = `${path}.claim`;
  const held = lockObservations(lock);
  try {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeJsonAtomic(path, { version: 1, observations: [...readObservations(root), ...entries] });
  } finally {
    releaseClaim(lock, held.marker);
  }
}

/** A status read changes no state, so the command leaves this mark in its session's own directory. */
export function markControlRead(directory, runId) {
  writeFileSync(join(directory, CONTROL_READ_FILE), `${JSON.stringify({ run_id: runId })}\n`);
}

/** The signals one finished process showed. A review has no session control to persist. */
export function sessionSignals({ role, result, controlCalled }) {
  const signals = [];
  if (result?.normal_exit === true && (role === 'review' || result.control_persisted === true)) signals.push('session');
  if (controlCalled) signals.push('control');
  if (result?.signalled === true) signals.push('interrupt');
  return signals;
}

/**
 * Taken before the process starts, so an observation names the version that ran.
 * `control` reads the run's session control afterwards. Returns `observe(result)`.
 */
export function providerObserver({ root, capability, tool, bin, role, runId, project, directory = null, control = null, deps = {}, say = () => {} }) {
  if (capability?.fixture === true) return () => {};
  let version = null;
  try { version = (deps.toolVersion || toolVersion)(bin); } catch { /* said at observe */ }
  return (result) => {
    try {
      if (!version) throw new Error(`no version from ${bin} --version`);
      const state = control?.();
      const requested = state?.binding?.run_id === runId && !!state.request;
      const read = directory !== null && existsSync(join(directory, CONTROL_READ_FILE));
      const at = new Date((deps.now || Date.now)()).toISOString();
      recordObservations(root, sessionSignals({ role, result, controlCalled: requested || read })
        .map(signal => ({ tool, tool_version: version, role, signal, run_id: runId, project, at })));
    } catch (error) {
      say(`${project}: provider observation not recorded: ${error.message}`);
    }
  };
}

/** One text per observation `capability` lacks across `tools` ([{ tool, version }]). Empty is supported. */
export function observationGaps(capability, tools, observations) {
  const { signal, role } = NEEDS[capability];
  const lacking = [signal === 'interrupt' ? 'an' : 'a', role, signal].filter(Boolean).join(' ');
  return tools.flatMap(({ tool, version }) => {
    if (!version) return [`${tool} (version unknown): ${lacking} not observed`];
    const seen = observations.some(item => item.tool === tool && item.tool_version === version
      && item.signal === signal && (!role || item.role === role));
    return seen ? [] : [`${tool} ${version}: ${lacking} not observed`];
  });
}
