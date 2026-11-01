/** Explicit autonomous stream boundary. No v1 caller supplies it.
 * Persistent checkpoint commands are the only control delivery on both paths. */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createSessionObservation } from './session-observation.js';
import { controlResponse, interruptSessionControl, validateControlState } from './session-control.js';
import { observeProjectSessionControl, interruptProjectSessionControl, readAutonomousState } from './autonomous-state.js';
import { writeJsonAtomic } from './atomic-write.js';
import { takeClaim, releaseClaim } from './resource-claim.js';
import { assertSessionDirectory, groupAlive, preserveSession, reconcilePreviousSession, reconcileSessionGate, sessionGitDir } from './session-recovery.js';

/** How long a process group gets between SIGTERM and SIGKILL. */
export const SESSION_TERM_MS = 1000;

/** Atomic durable connector; callbacks can race a sample's expected revision,
 * which fails closed rather than overwriting a checkpoint request. `verify`
 * is trusted runner measurement, never the model's callback payload itself. */
export function projectSessionObserver({ root, programme, project, actor, verify = () => null, ...deps }) {
  const read = () => readAutonomousState(root, programme, project, deps);
  return {
    control: read().session_control,
    observe(observation) {
      const state = read();
      const progress = verify(state.session_control?.request, state);
      return observeProjectSessionControl(root, programme, project, { ...deps, actor, revision: state.revision,
        observation: { ...observation, progress } }).session_control;
    },
    interrupt(reason) {
      const state = read();
      return interruptProjectSessionControl(root, programme, project, { ...deps, actor, revision: state.revision, reason }).session_control;
    },
  };
}

export async function streamAutonomousSession({ bin, args, cwd, env, unsetEnv = [], prompt = null,
  onSpawn = null, spawn: spawnFn = spawn, autonomous }) {
  const { version, tool, control: initial, clock, observe, interrupt, directory,
    pollMs, termMs = SESSION_TERM_MS, contextWindow = null, activity = () => null } = autonomous;
  validateControlState(initial);
  if (!['running', 'closing'].includes(initial.phase)) throw new Error('terminal control cannot launch a builder');
  if (version !== 1 || typeof clock !== 'function' || typeof observe !== 'function' || typeof interrupt !== 'function'
    || !directory || !Number.isSafeInteger(pollMs) || pollMs <= 0
    || pollMs > Math.min(initial.profile.reserve_active_ms, initial.profile.closing_ms, initial.profile.tool_wait_ms, initial.profile.lane_wait_ms)
    || !Number.isSafeInteger(termMs) || termMs <= 0 || termMs > 30_000) throw new Error('invalid autonomous supervision contract');
  const observation = createSessionObservation(tool, { contextWindow });
  const piped = observation.transport.prompt === 'stdin-jsonl';
  if (piped && typeof prompt !== 'string') throw new Error('stream-json prompt required');
  assertSessionDirectory(cwd, directory);
  const gitDir = sessionGitDir(cwd);
  const claimPath = join(gitDir, 'mc-autonomous-session.claim');
  const held = takeClaim(claimPath, { pid: process.pid, run_id: initial.binding.run_id });
  if (!held.ok) throw new Error('autonomous workarea is held');
  try {
    const previous = reconcilePreviousSession(gitDir);
    if (!previous.ok) throw new Error(`autonomous recovery required: ${previous.reason}`);
    mkdirSync(directory, { mode: 0o700 }); // caller supplies a new immutable attempt directory
    const path = join(gitDir, 'mc-autonomous-session.json');
    const record = { run_id: initial.binding.run_id, binding: initial.binding, cwd, pid: null, process_closed: false, snapshot: null };
    const save = () => writeJsonAtomic(path, record);
    save(); // crash during spawn is unknown, never an invitation to start again
    let childEnv = env;
    if (unsetEnv.length) {
      childEnv = { ...(env || process.env) };
      for (const name of unsetEnv) delete childEnv[name];
    }
    return await new Promise((resolve) => {
      let control = initial; let child = null; let stopped = false; let settled = false;
      let closed = false; let exit = null; let exitSignal = null; let reason = null; let durable = true;
      let timer = null; let escalation = null; let finalTimer = null; let signalled = false;
      let fd = null; let output = ''; let errors = ''; let sequence = initial.observation.sequence;
      const decoder = new StringDecoder('utf8'); let partial = ''; let oversized = false;
      const cap = 1 << 20;
      const remember = (bytes, stderr = false) => {
        if (stderr) errors = (errors + bytes.toString('utf8')).slice(-cap);
        else output = (output + bytes.toString('utf8')).slice(-cap);
      };
      const persistInterrupt = why => {
        reason ||= why;
        try { const next = interrupt(reason); validateControlState(next); control = next; }
        catch (error) {
          durable = false; control = interruptSessionControl(control, reason);
          errors += `\ncontrol persistence failed: ${error.message}`;
        }
      };
      const signal = name => {
        if (!child?.pid) return;
        // Only this invocation's freshly spawned process group, never a pid
        // discovered in a previous manifest or transport event.
        try { process.kill(-child.pid, name); signalled = true; } catch (error) { if (error.code !== 'ESRCH') errors += `\n${name}: ${error.code}`; }
      };
      const finish = () => {
        if (settled) return;
        settled = true; clearInterval(timer); clearTimeout(escalation); clearTimeout(finalTimer);
        const dead = !child?.pid || !groupAlive(child.pid);
        let normal = !stopped && closed && exit === 0 && !exitSignal && observation.completed
          && !['incomplete', 'plan_pending'].includes(control.phase) && dead;
        if (!normal) persistInterrupt(reason || 'unexpected-process-exit');
        if (fd !== null) { try { closeSync(fd); } catch { /* recorded below */ } fd = null; }
        record.process_closed = closed;
        const processResult = { status: normal ? 0 : (exit || 1), signal: exitSignal, normal_exit: normal,
          interrupted: !normal, reason, group_dead: dead };
        let recovery = { ok: false, reason: 'process-group-not-reconciled' };
        try {
          if (dead && closed) {
            recovery = durable ? reconcileSessionGate(gitDir) : { ok: false, reason: 'control-persistence-failed' };
            record.unreconciled_tools = observation.telemetry.active_jobs.length > 0;
            if (recovery.ok && record.unreconciled_tools) recovery = { ok: false, reason: 'tool-children-unknown' };
            if (!recovery.ok) {
              normal = false; persistInterrupt(recovery.reason);
              Object.assign(processResult, { status: 1, normal_exit: false, interrupted: true, reason });
            }
            record.snapshot = preserveSession({ cwd, directory, control, telemetry: observation.telemetry, process: processResult });
          }
          record.recovery = recovery; record.control_persisted = durable;
          writeJsonAtomic(join(directory, 'result.json'), { ...processResult, recovery, control_persisted: durable, control: controlResponse(control) });
          // Finalize the workarea manifest LAST. Any failed artifact write
          // leaves the pre-closure record, which refuses another builder.
          save();
        } catch (error) {
          persistInterrupt('preservation-failed');
          normal = false; Object.assign(processResult, { status: 1, normal_exit: false, interrupted: true, reason });
          recovery = { ok: false, reason: error.message };
        }
        // Pipes held open by a detached/unknown descendant cannot keep this
        // promise alive. Unknown ownership still forbids the next builder.
        child?.stdout?.destroy(); child?.stderr?.destroy(); child?.stdin?.destroy();
        resolve({ ...processResult, status: normal && recovery.ok ? 0 : (processResult.status || 1),
          normal_exit: normal && recovery.ok, interrupted: !normal || !recovery.ok,
          recovery_ready: recovery.ok, recovery, control_persisted: durable, stdout: output, stderr: errors,
          control: controlResponse(control), timedOut: stopped, signalled, stalled: false, lingered: false });
      };
      const stop = why => {
        if (stopped || settled) return;
        stopped = true; clearInterval(timer); persistInterrupt(why);
        signal('SIGTERM');
        escalation = setTimeout(() => { signal('SIGKILL'); finalTimer = setTimeout(finish, termMs); }, termMs);
      };
      const sample = () => {
        if (stopped || settled || closed) return;
        try {
          const time = clock();
          const next = observe(observation.sample({ sequence: ++sequence, ...time, activity: activity() }));
          validateControlState(next);
          if (JSON.stringify(next.binding) !== JSON.stringify(initial.binding)) throw new Error('observation binding changed');
          control = next;
          if (['stop-session', 'needs-plan'].includes(controlResponse(control).next_action)) stop(control.reason);
        } catch (error) { errors += `\nobservation failed: ${error.message}`; stop('observation-unavailable'); }
      };
      try {
        fd = openSync(join(directory, 'transport.jsonl'), 'wx', 0o600);
        child = spawnFn(bin, args, { cwd, env: childEnv, detached: true, stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        record.pid = child.pid ?? null;
        child.on('error', error => { errors += `\n${error.message}`; stop('process-error'); if (!child.pid) { closed = true; finish(); } });
        child.on('exit', (code, signal) => { exit = code; exitSignal = signal; });
        child.on('close', (code, signal) => {
          closed = true; exit = code; exitSignal = signal;
          if (!groupAlive(child.pid)) finish(); else stop('process-descendants-remain');
        });
        child.stdout.on('data', bytes => {
          remember(bytes);
          try {
            writeSync(fd, bytes);
            const lines = (partial + decoder.write(bytes)).split('\n'); partial = lines.pop();
            for (const line of lines) {
              if (!oversized && Buffer.byteLength(line) <= cap) {
                let event; try { event = JSON.parse(line); } catch { continue; }
                observation.event(event, clock().at_ms);
              }
              oversized = false;
            }
            if (Buffer.byteLength(partial) > cap) { partial = ''; oversized = true; }
            if (piped && observation.completed) child.stdin.end();
          } catch (error) { errors += `\nstream observation failed: ${error.message}`; stop('observation-unavailable'); }
        });
        child.stderr.on('data', bytes => remember(bytes, true));
        child.stdin?.on('error', () => {});
        save();
        onSpawn?.(child.pid);
        if (piped) child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
        sample();
        if (!stopped) timer = setInterval(sample, pollMs);
      } catch (error) { errors += `\n${error.message}`; stop('launch-failed'); if (!child) { closed = true; finish(); } }
    });
  } finally { releaseClaim(claimPath, held.marker); }
}
