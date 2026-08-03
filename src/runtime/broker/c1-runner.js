/**
 * Broker-owned C1 operation.
 *
 * The long-lived broker never imports the vault lease or any of its custody
 * dependencies. After verifying the fixed Claude artifact, it starts the
 * pinned short-lived lease host and accepts only its one-record status reply.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyInstalledClaudeC1Artifacts } from './c1-artifacts.js';
import { C1_INTERNAL_LEASE_HOST_ENV } from './c1-process-group.js';
import { verifyInstalledC1SourceClosure } from './c1-source-closure.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEASE_HOST_PATH = join(PACKAGE_ROOT, 'src', 'runtime', 'broker', 'c1-lease-host.js');
const SOURCE_CLOSURE_PATH = join(PACKAGE_ROOT, 'src', 'runtime', 'broker', 'c1-source-closure.js');
const C1_LEASE_HOST_SOURCE_SHA256 =
  '128126a1a9353ed46c0289d94578cb28cda99ebc22bb222d83abc24380ae6992';
const C1_SOURCE_CLOSURE_SOURCE_SHA256 =
  '3555d9349628044e907c22468825aa074ee3a1596b7753bdaeccaad16ad0c5d8';
const C1_LEASE_HOST_SCHEMA = 1;
const MAX_HOST_OUTPUT_BYTES = 64 * 1024;
const HOST_TIMEOUT_MS = 10 * 60_000;
const GROUP_EXIT_TIMEOUT_MS = 5_000;
const GROUP_EXIT_POLL_MS = 25;
const HOST_ENV = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'C',
  LC_ALL: 'C',
  [C1_INTERNAL_LEASE_HOST_ENV]: '1',
});
const STATUSES = new Set(['passed', 'failed', 'indeterminate']);

/** Production entrypoint. It offers no dependency or execution portal. */
export async function runClaudeC1BrokerOperation(context) {
  return runClaudeC1BrokerOperationCore(
    context,
    verifyFixedC1SourceClosure,
    verifyInstalledClaudeC1Artifacts,
    runFixedC1LeaseHost,
  );
}

function verifyFixedC1SourceClosure() {
  try {
    const sourceClosurePath = realpathSync(SOURCE_CLOSURE_PATH);
    return sourceClosurePath === SOURCE_CLOSURE_PATH
      && sha256(readFileSync(sourceClosurePath)) === C1_SOURCE_CLOSURE_SOURCE_SHA256
      && verifyInstalledC1SourceClosure()?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Token-free fixture seam. The fixture can replace only the verifier and the
 * zero-argument status operation; it cannot select a host path, argv, env,
 * vault record, or production dependency.
 */
export async function runClaudeC1BrokerOperationFixture(context, fixture = {}) {
  if (!isExactFixture(fixture)) return { status: 'failed' };
  return runClaudeC1BrokerOperationCore(
    context,
    fixture.verifySourceClosure,
    fixture.verifyArtifacts,
    fixture.runLeaseHost,
  );
}

export function parseC1LeaseHostReport(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_HOST_OUTPUT_BYTES) return null;
  let value;
  try { value = JSON.parse(raw.toString('utf8').trim()); } catch { return null; }
  if (!isExactRecord(value, ['schema', 'status'])
    || value.schema !== C1_LEASE_HOST_SCHEMA
    || !STATUSES.has(value.status)) return null;
  return { status: value.status };
}

export function isExactClaudeC1BrokerContext(context) {
  return isExactContext(context);
}

/** Token-free liveness fixture used to prove close is not enough on its own. */
export async function waitForC1ProcessGroupExitFixture(groupLeaderPid, {
  isAlive,
  kill,
  delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
  now = () => Date.now(),
  timeoutMs = GROUP_EXIT_TIMEOUT_MS,
  pollMs = GROUP_EXIT_POLL_MS,
} = {}) {
  if (!Number.isSafeInteger(groupLeaderPid) || groupLeaderPid < 1
    || typeof isAlive !== 'function' || typeof kill !== 'function'
    || typeof delay !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0
    || !Number.isSafeInteger(pollMs) || pollMs < 1) return { exited: false, survivorsObserved: false };
  try {
    if (!isAlive(groupLeaderPid)) return { exited: true, survivorsObserved: false };
    kill(groupLeaderPid);
    const deadline = now() + timeoutMs;
    while (isAlive(groupLeaderPid)) {
      if (now() >= deadline) return { exited: false, survivorsObserved: true };
      await delay(pollMs);
    }
    return { exited: true, survivorsObserved: true };
  } catch {
    return { exited: false, survivorsObserved: true };
  }
}

async function runClaudeC1BrokerOperationCore(
  context,
  verifySourceClosure,
  verifyArtifacts,
  runLeaseHost,
) {
  if (!isExactContext(context)) return { status: 'failed' };
  let sourceClosure;
  try { sourceClosure = await verifySourceClosure(); } catch { return { status: 'failed' }; }
  if (sourceClosure !== true && sourceClosure?.ok !== true) return { status: 'failed' };
  let artifacts;
  try { artifacts = await verifyArtifacts(); } catch { return { status: 'failed' }; }
  if (!artifacts?.ok) return { status: 'indeterminate' };
  let result;
  try { result = await runLeaseHost(); } catch { return { status: 'failed' }; }
  return isExactStatus(result) ? { status: result.status } : { status: 'failed' };
}

async function runFixedC1LeaseHost() {
  let hostPath;
  try {
    hostPath = realpathSync(LEASE_HOST_PATH);
    if (hostPath !== LEASE_HOST_PATH
      || sha256(readFileSync(hostPath)) !== C1_LEASE_HOST_SOURCE_SHA256) {
      return { status: 'failed' };
    }
  } catch {
    return { status: 'failed' };
  }

  return new Promise((resolveLease) => {
    let child = null;
    let done = false;
    let outputBytes = 0;
    const stdout = [];
    let terminationStatus = null;
    let groupLeaderPid = null;
    let brokerLivenessPipe = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      // Do not end this pipe while the host is live: EOF is its broker-death
      // signal. After close it is safe to release the broker endpoint.
      try { brokerLivenessPipe?.destroy(); } catch {}
      for (const chunk of stdout) chunk.fill(0);
      resolveLease(value);
    };
    const requestTermination = (status) => {
      terminationStatus = terminationStatus === 'failed' ? 'failed' : status;
      killC1ProcessGroup(groupLeaderPid, child);
      // Wait for `close`: it is the acknowledgement that inherited streams
      // and descendants have stopped. A second group kill handles a child that
      // forks while responding to the first signal.
      setTimeout(() => {
        if (!done) killC1ProcessGroup(groupLeaderPid, child);
      }, 2_000).unref?.();
    };
    const timeout = setTimeout(() => requestTermination('indeterminate'), HOST_TIMEOUT_MS);
    try {
      child = spawn(process.execPath, [hostPath], {
        cwd: PACKAGE_ROOT,
        env: HOST_ENV,
        shell: false,
        detached: true,
        // fd 3 is an empty liveness pipe, not a data or credential channel.
        // Retaining the broker endpoint makes host EOF equivalent to broker
        // death if this process is SIGKILLed or crashes.
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      groupLeaderPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
      brokerLivenessPipe = child.stdio[3] || null;
      if (!brokerLivenessPipe) {
        requestTermination('failed');
        return;
      }
      brokerLivenessPipe.once('error', () => requestTermination('failed'));
      const inspect = (chunk, collect) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_HOST_OUTPUT_BYTES) {
          requestTermination('failed');
          return;
        }
        if (collect) stdout.push(Buffer.from(chunk));
      };
      child.stdout.on('data', (chunk) => inspect(chunk, true));
      child.stderr.on('data', (chunk) => inspect(chunk, false));
      child.once('error', () => {
        requestTermination('failed');
        if (!child?.pid) finish({ status: 'failed' });
      });
      child.once('close', (code, signal) => {
        void finalizeClosedC1LeaseHost({
          code,
          signal,
          groupLeaderPid,
          terminationStatus,
          stdout,
          finish,
        });
      });
    } catch {
      killC1ProcessGroup(groupLeaderPid, child);
      finish({ status: 'failed' });
    }
  });
}

async function finalizeClosedC1LeaseHost({
  code,
  signal,
  groupLeaderPid,
  terminationStatus,
  stdout,
  finish,
}) {
  const group = await waitForC1ProcessGroupExitFixture(groupLeaderPid, {
    isAlive: isC1ProcessGroupAlive,
    kill: killC1ProcessGroupByLeader,
  });
  // A status can be trusted only after the broker has proved that no C1
  // descendant remains in the group. This also catches an outer host exit
  // that left a credential-bearing descendant alive.
  if (!group.exited || group.survivorsObserved || terminationStatus || code !== 0 || signal) {
    finish({ status: terminationStatus || 'failed' });
    return;
  }
  const raw = Buffer.concat(stdout);
  const report = parseC1LeaseHostReport(raw);
  raw.fill(0);
  finish(report || { status: 'failed' });
}

function killC1ProcessGroup(groupLeaderPid, child) {
  if (Number.isSafeInteger(groupLeaderPid) && groupLeaderPid > 0
    && killC1ProcessGroupByLeader(groupLeaderPid)) return;
  if (!child) return;
  try { child.kill('SIGKILL'); } catch {}
}

function isC1ProcessGroupAlive(groupLeaderPid) {
  if (!Number.isSafeInteger(groupLeaderPid) || groupLeaderPid < 1 || process.platform === 'win32') return false;
  try {
    process.kill(-groupLeaderPid, 0);
