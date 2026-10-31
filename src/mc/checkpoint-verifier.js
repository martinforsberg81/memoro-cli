/** The runner's own measurement behind `projectSessionObserver.verify`. A model
 * callback only asks: its text is never executed and never becomes a reference.
 * What runs comes from the goal contract or is `mc gate --json`, in the
 * background, and only exit 0 over unchanged content is progress. Anything else
 * withholds progress and is never a failure observation. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BUDGET, gateReservation, run as runGate } from './commands/gate.js';
import { takeLane } from './gate-lane-wait.js';
import { releaseGateLock } from './gate-lock.js';
import { tryGit } from './git.js';
import { runnerScratchDir } from './paths.js';
import { PROVIDER_API_ENV_NAMES } from './runtime-secrets.js';
import { captureWorktree, sameContent } from './session-gate-evidence.js';
import { groupAlive } from './session-recovery.js';
import { SESSION_TERM_MS } from './session-supervision.js';

const LIMIT_MS = DEFAULT_BUDGET * 1000;
const TAIL_BYTES = 8 * 1024;
const CHECKPOINT = 'checkpoint';
const GATE_TEXT = 'mc gate --json';
/** What `mc gate` answers past its budget: the tests run on. */
const GATE_RUNNING = 3;
/** How long a stopped gate's worker gets to settle its bounded children. */
const GATE_SETTLE_SECONDS = 60;

const requestKey = ({ operation, reference, criterion_id = null, observation_sequence }) =>
  JSON.stringify([operation, reference, criterion_id, observation_sequence]);

function appendTail(tail, bytes) {
  const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  return Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
}

export function createCheckpointVerifier({ root, programme, project, worktree, env = process.env, ...deps }) {
  const scratch = deps.scratch || env.MC_SCRATCH || join(runnerScratchDir(env), `checkpoint-verifier-${programme}-${project}`);
  const childEnv = { ...env, MC_SCRATCH: scratch };
  for (const name of PROVIDER_API_ENV_NAMES) delete childEnv[name];
  const io = {
    capture: captureWorktree, head: cwd => tryGit(cwd, ['rev-parse', 'HEAD']), gate: runGate,
    reservation: cwd => gateReservation(cwd, childEnv), take: takeLane, release: releaseGateLock,
    spawn, signal: (pid, name) => process.kill(-pid, name), groupAlive,
    setTimer: setTimeout, clearTimer: clearTimeout, termMs: SESSION_TERM_MS, limitMs: LIMIT_MS, ...deps,
  };
  const seen = new Set();
  let active = null;
  let halt = null;
  let pending = null;
  let closed = false;

  /** Runs from timers and process events, so nothing here may throw: a group that
   * cannot be signalled is no progress, and the final bound still ends the wait. */
  const signalGroup = (pid, name) => {
    try { io.signal(pid, name); } catch { /* gone, or refused; progress stays withheld */ }
  };

  /** One shell, one process group, the whole group ended on a halt. The promise
   * answers true only for exit 0 with nothing of the group left behind. */
  const runCheck = (check, halted, onOutput) => new Promise((resolve) => {
    let child = null; let stopped = false; let settled = false;
    let escalation = null; let finalTimer = null;
    const finish = (passed) => {
      if (settled) return;
      settled = true; io.clearTimer(escalation); io.clearTimer(finalTimer);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve(passed);
    };
    const stop = () => {
      if (stopped || settled) return;
      stopped = true;
      signalGroup(child.pid, 'SIGTERM');
      escalation = io.setTimer(() => {
        signalGroup(child.pid, 'SIGKILL');
        finalTimer = io.setTimer(() => finish(false), io.termMs);
      }, io.termMs);
    };
    try {
      child = io.spawn('/bin/sh', ['-c', check], { cwd: worktree, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', () => { if (!child.pid) finish(false); else stop(); });
      child.on('close', (code, signal) => {
        if (io.groupAlive(child.pid)) stop(); // a leftover must not outlive the lane
        else finish(code === 0 && !signal && !stopped);
      });
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);
      if (child.pid) { halt = stop; if (halted()) stop(); }
    } catch { finish(false); }
  });

  /** The gate worker owns its reservation and test children. Only its SIGTERM
   * lets it settle them and write the result recovery needs, so it is never
   * sent SIGKILL. A gate past its budget is stopped, not left running. */
  const runCheckpoint = async (halted, onOutput) => {
    let worker = null; let answer = Buffer.alloc(0);
    const stop = () => { if (worker) signalGroup(worker, 'SIGTERM'); };
    const options = {
      cwd: worktree, env: childEnv, stdout: { write: (text) => { answer = Buffer.concat([answer, Buffer.from(text)]); onOutput(text); } },
      stderr: { write: onOutput },
      spawn: (...args) => { const child = io.spawn(...args); worker = child.pid; return child; },
    };
    halt = stop;
    const code = await io.gate(['--json'], options);
    if (code === GATE_RUNNING) {
      stop();
      await io.gate(['--wait', '--json', '--budget', String(GATE_SETTLE_SECONDS)], options);
      return false;
    }
    if (code !== 0 || halted()) return false;
    // "NOTHING CHANGED" is exit 0 with no measurement behind it.
    try { return JSON.parse(answer.toString('utf8')).ok === true; } catch { return false; }
  };

  const measured = async (plan, execute) => {
    const before = io.capture(worktree);
    const head = io.head(worktree);
    const passed = await execute();
    if (!passed) return null;
    const after = io.capture(worktree);
    if (!sameContent(before, after) || !head) return null;
    const subject = plan.criterion_id ?? CHECKPOINT;
    const digest = createHash('sha256')
      .update(JSON.stringify([plan.goal_revision, subject, plan.check, before.tree, before.fingerprint]))
      .digest('hex').slice(0, 16);
    return {
      id: `measured-${digest}`,
      reference: `${subject} passed at ${head} on goal revision ${plan.goal_revision}`,
      criterion_id: plan.criterion_id,
    };
  };

  const holdingLane = async (signal, write, work) => {
    const reservation = io.reservation(worktree);
    const sleep = ms => new Promise((resolve) => {
      const timer = io.setTimer(resolve, ms);
      signal.addEventListener('abort', () => { io.clearTimer(timer); resolve(); }, { once: true });
    });
    await io.take({ ...reservation, signal, sleep, write });
    try { return await work(); } finally { io.release(reservation); }
  };

  /** Everything here runs after `verify` returned. */
  const measure = async (plan) => {
    await new Promise((resolve) => { setImmediate(resolve); });
    const aborted = new AbortController();
    const halted = () => aborted.signal.aborted;
    let tail = Buffer.alloc(0);
    const remember = (bytes) => { tail = appendTail(tail, bytes); };
    const stop = () => { aborted.abort(); halt?.(); };
    active.stop = stop;
    if (closed) return null;
    const deadline = io.setTimer(stop, io.limitMs);
    try {
      if (plan.criterion_id === null) return await measured(plan, () => runCheckpoint(halted, remember));
      return await holdingLane(aborted.signal, remember, () => {
        if (halted()) return null;
        return measured(plan, () => runCheck(plan.check, halted, remember));
      });
    } catch { return null; } finally {
      io.clearTimer(deadline); halt = null;
      try {
        mkdirSync(scratch, { recursive: true, mode: 0o700 });
        writeFileSync(join(scratch, `${plan.criterion_id ?? CHECKPOINT}-${plan.sequence}.log`), tail, { mode: 0o600 });
      } catch { /* the output is a courtesy; the measurement stands without it */ }
    }
  };

  /** The check is the contract's or the gate's, never the request's. */
  const planFor = (request, state) => {
    const base = { goal_revision: state.goal_revision, sequence: Number.isSafeInteger(request.observation_sequence) ? request.observation_sequence : 0 };
    if (request.operation === CHECKPOINT) return { ...base, criterion_id: null, check: GATE_TEXT };
    if (request.operation !== 'criterion') return null;
    const criterion = state.contract?.success_criteria?.find(item => item.id === request.criterion_id);
    if (criterion?.verification !== 'premerge') return null;
    return { ...base, criterion_id: criterion.id, check: criterion.check };
  };

  const begin = (plan) => {
    const running = { stop: null, done: null };
    active = running;
    running.done = measure(plan).catch(() => null).then((progress) => {
      active = null;
      if (progress && !closed) pending = { progress, goal_revision: plan.goal_revision };
    });
  };

  function verify(request, state) {
    const finished = pending;
    pending = null;
    if (!closed && !active && request && state) {
      const key = requestKey(request);
      if (!seen.has(key)) {
        seen.add(key);
        const plan = planFor(request, state);
        if (plan) begin(plan);
      }
    }
    return finished && finished.goal_revision === state?.goal_revision ? finished.progress : null;
  }

  verify.close = async () => {
    closed = true;
    pending = null;
    const running = active;
    if (!running) return;
    running.stop?.();
    await running.done;
  };

  return verify;
}
