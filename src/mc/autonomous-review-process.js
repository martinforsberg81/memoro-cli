/** Immutable review attempt and append-only process facts. Never signal a PID
 * recovered from disk. Missing facts retain the durable project owner. */
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { reviewDigest } from './autonomous-review-report.js';
import { STABLE_ID_RE } from './programme-contract.js';
import { takeClaim, releaseClaim, readClaim, processAlive } from './resource-claim.js';
import { groupAlive, reconcileSessionGate, sessionGitDir } from './session-recovery.js';
import { createSessionObservation } from './session-observation.js';

export function reviewProcessPaths(options) {
  if (!STABLE_ID_RE.test(options.actor?.run_id || '')) throw new Error('stable review run required');
  const directory = join(options.root, 'runner', 'reviews', options.actor.run_id);
  return Object.fromEntries(['manifest', 'spawn-intent', 'launch', 'spawned', 'terminal', 'report'].map(name => [name.replace('-', '_'), join(directory, `${name}.json`)]).concat([['claim', join(directory, 'process.claim')]]));
}
const read = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
/** Publish whole immutable facts, including across a writer crash. */
export function writeReviewFact(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    try { linkSync(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!isDeepStrictEqual(read(path), value)) throw new Error(`review fact is immutable: ${path}`);
    }
  } finally { unlinkSync(temporary); }
  return value;
}
export function prepareReviewProcess(options, session, sourceFingerprint) {
  const paths = reviewProcessPaths(options);
  return writeReviewFact(paths.manifest, {
    schema: 'mc-autonomous-review-process', version: 1, generation: randomUUID(),
    programme: options.programme, project: options.project, actor: options.actor,
    source: options.cwd, source_git_dir: sessionGitDir(options.cwd), checkout_git_dir: sessionGitDir(session.checkout),
    source_fingerprint: sourceFingerprint, session, session_digest: reviewDigest(session),
    supervisor: { pid: process.pid },
    facts: { spawn_intent: paths.spawn_intent, launch: paths.launch, spawned: paths.spawned, terminal: paths.terminal, report: paths.report },
  });
}
export function readReviewProcess(options) {
  const paths = reviewProcessPaths(options); const manifest = read(paths.manifest);
  if (manifest?.schema !== 'mc-autonomous-review-process' || manifest.version !== 1 || !manifest.generation
    || !isDeepStrictEqual(manifest.actor, options.actor) || manifest.programme !== options.programme
    || manifest.project !== options.project || manifest.source !== options.cwd
    || manifest.session_digest !== reviewDigest(manifest.session)) throw new Error('review process binding is missing or changed');
  const facts = {};
  for (const name of ['spawn_intent', 'launch', 'spawned', 'terminal', 'report']) {
    const fact = read(paths[name]);
    if (fact && (fact.generation !== manifest.generation || fact.manifest_digest !== reviewDigest(manifest))) throw new Error('review process generation changed');
    facts[name] = fact;
  }
  return { paths, manifest, ...facts };
}
function fact(options, name, value) {
  const { paths, manifest } = readReviewProcess(options);
  return writeReviewFact(paths[name], { generation: manifest.generation, manifest_digest: reviewDigest(manifest), ...value });
}
function takeReviewClaim({ paths, manifest }) {
  const previous = readClaim(paths.claim);
  if (existsSync(paths.claim) && (!previous || previous.generation !== manifest.generation
    || previous.run_id !== manifest.actor.run_id)) return { ok: false };
  return takeClaim(paths.claim, { pid: process.pid, generation: manifest.generation, run_id: manifest.actor.run_id }, {
    alive: pid => {
      const current = readClaim(paths.claim);
      // A successor can arrive between the initial read and claim reclamation.
      return !current || current.generation !== manifest.generation || current.run_id !== manifest.actor.run_id
        || current.pid !== pid || processAlive(pid);
    },
  });
}
export function withReviewProcessClaim(options, operation) {
  const attempt = readReviewProcess(options); const { paths } = attempt;
  const held = takeReviewClaim(attempt);
  if (!held.ok) throw new Error('review process is owned or unknown');
  try { return operation(); } finally { releaseClaim(paths.claim, held.marker); }
}
export function beginReviewProcess(options) {
  return withReviewProcessClaim(options, () => {
    const attempt = readReviewProcess(options);
    if (attempt.spawn_intent || attempt.terminal) throw new Error('review spawn already attempted');
    return fact(options, 'spawn_intent', { supervisor_pid: process.pid });
  });
}
export function recordReviewSpawn(options, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('review process PID is unknown');
  if (!readReviewProcess(options).spawn_intent) throw new Error('review spawn intent required');
  return fact(options, 'spawned', { pid, process_group: pid });
}
/** Trusted native supervisor facts, not a model report or a status=0 inference. */
export function recordReviewTerminal(options, result) {
  const attempt = readReviewProcess(options);
  if (!attempt.spawn_intent && !result.not_spawned) throw new Error('review spawn intent required');
  if (result.not_spawned && (attempt.spawn_intent || attempt.spawned)) throw new Error('review spawn outcome is unknown');
  return fact(options, 'terminal', { result });
}
export function reviewProcessStatus(options, { alive = processAlive, group = groupAlive } = {}) {
  const attempt = readReviewProcess(options); const held = readClaim(attempt.paths.claim);
  if (existsSync(attempt.paths.claim)) {
    if (!held || held.generation !== attempt.manifest.generation || held.run_id !== attempt.manifest.actor.run_id) return { kind: 'unknown', attempt };
    if (alive(held.pid)) return { kind: 'live', attempt };
  }
  if (attempt.spawned && (alive(attempt.spawned.pid) || group(attempt.spawned.process_group))) return { kind: 'live', attempt };
  const result = attempt.terminal?.result;
  if (result?.status === 0 && !attempt.spawned) return { kind: 'unknown', attempt };
  if (!result || result.process_closed !== true || result.group_dead !== true || result.tools_closed !== true) return { kind: 'unknown', attempt };
  return { kind: result.status === 0 && result.normal_exit === true && result.interrupted === false
    && result.transport_completed === true && result.signal === null && result.error === null && !result.not_spawned ? 'completed' : 'incomplete', attempt };
}

/** Dedicated review transport: its group is detached so descendants remain
 * observable after the provider exits. It does not use builder control/schema. */
export async function streamReviewSession({ bin, args, cwd, env, unsetEnv = [], prompt, spawn: spawnFn = spawn, reviewProcess }) {
  const { options, tool } = reviewProcess;
  const attempt = readReviewProcess(options);
  if (!attempt.spawn_intent || attempt.launch || attempt.spawned || attempt.terminal || cwd !== attempt.manifest.session.checkout) throw new Error('fresh bound review spawn intent required');
  const held = takeReviewClaim(attempt);
  if (!held.ok) throw new Error('review process is owned or unknown');
  try {
    const current = readReviewProcess(options);
    if (!current.spawn_intent || current.launch || current.spawned || current.terminal) throw new Error('review spawn already attempted');
    // Consume native launch permission before spawn, not after receiving a PID.
    // A dead supervisor in the spawn/record window must not launch twice.
    fact(options, 'launch', { supervisor_claim: held.marker });
    const observation = createSessionObservation(tool); const piped = observation.transport.prompt === 'stdin-jsonl';
    const childEnv = { ...(env || process.env) }; for (const name of unsetEnv) delete childEnv[name];
    return await new Promise((resolve, reject) => {
      let child; let timer; let settled = false; let closed = false; let status = null; let signal = null; let error = null;
      let stdout = ''; let stderr = ''; let partial = ''; let oversized = false;
      const decoder = new StringDecoder('utf8'); const cap = 1 << 20;
      const finish = () => {
        if (settled) return; settled = true; clearTimeout(timer);
        try {
          const dead = !child.pid || !groupAlive(child.pid);
          const gate = closed && dead ? reconcileSessionGate(sessionGitDir(cwd)) : { ok: false };
          const toolsClosed = gate.ok && !observation.telemetry.active_jobs.length && (!error || !child.pid);
          const normal = closed && dead && toolsClosed && status === 0 && !signal && observation.completed;
          const result = { status, signal, error, process_closed: closed, group_dead: dead, tools_closed: toolsClosed,
            transport_completed: observation.completed, active_jobs: observation.telemetry.active_jobs, gate,
            normal_exit: normal, interrupted: !normal };
          recordReviewTerminal(options, result);
          child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
          resolve({ ...result, stdout, stderr });
        } catch (failure) { reject(failure); }
      };
      try {
        child = spawnFn(bin, args, { cwd, env: childEnv, detached: true, stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        child.on('error', failure => { error = failure.message; });
        child.on('exit', (code, sig) => { status = code; signal = sig; timer = setTimeout(finish, 1000); });
        child.on('close', (code, sig) => { closed = true; status = code; signal = sig; finish(); });
        child.stdout.on('data', bytes => {
          stdout = (stdout + bytes).slice(-cap);
          const lines = (partial + decoder.write(bytes)).split('\n'); partial = lines.pop();
          try {
            for (const line of lines) {
              if (Buffer.byteLength(line) > cap) error = 'review transport line exceeds observation limit';
              if (!oversized && Buffer.byteLength(line) <= cap) {
                let event; try { event = JSON.parse(line); } catch { continue; }
                observation.event(event, Date.now());
              }
              oversized = false;
            }
            if (Buffer.byteLength(partial) > cap) { partial = ''; oversized = true; error = 'review transport line exceeds observation limit'; }
            if (piped && observation.completed) child.stdin.end();
          } catch (failure) { error = failure.message; }
        });
        child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-cap); });
        child.stdin?.on('error', () => {});
        if (child.pid) recordReviewSpawn(options, child.pid);
        if (piped) child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
      } catch (failure) {
        // A throwing launch/recorder is not proof that no process exists.
        // Keep observing any child we did get, but never invent closure.
        error = failure.message;
        if (!child) reject(failure);
      }
    });
  } finally { releaseClaim(attempt.paths.claim, held.marker); }
}
