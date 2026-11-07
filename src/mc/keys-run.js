import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mcHome } from './paths.js';
import { rememberRuntimeSecretNames, scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';
import { KeysDotenvError, readKeysDotenv } from './keys-dotenv.js';
import { keyOutputFilter } from './keys-filter.js';

const EXECUTOR_PREFIX = /^(?:NODE_|DYLD_|LD_|NPM_|npm_|GIT_)/u;
const EXECUTOR_CONTROLS = new Set(['ENV', 'BASH_ENV']);

/**
 * Where a caller that keeps a wrapper alive learns about the child it started: `MC_KEYS_CHILD_FILE` names
 * a file, and the run writes the child's pid as it starts and its exit code or signal when it leaves. Only
 * those — never the environment or a value — and nothing at all when the variable is unset. Written at
 * `exit`, not `close`: a grandchild that keeps stdio open holds `close` back, and the caller must still
 * know the child is gone. The exit is written only into a file still there: a caller that has decided
 * removes it, and nothing is written back. Resolution on `close` is unchanged.
 */
export const KEYS_CHILD_FILE = 'MC_KEYS_CHILD_FILE';

function recordChild(file, record, stderr) {
  try {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    stderr.write('mc keys: cannot record the child pid\n');
  }
}

/**
 * The exit, into the file only while the caller still holds it. The file is opened as it is — no rename, no
 * create — and written over the pid record, which the exit record is longer than, so it covers that whole.
 */
function recordExit(file, record, stderr) {
  let fd;
  try {
    fd = openSync(file, 'r+');
  } catch (error) {
    if (error.code !== 'ENOENT') stderr.write('mc keys: cannot record the child exit\n');
    return;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
  } catch {
    stderr.write('mc keys: cannot record the child exit\n');
  } finally {
    closeSync(fd);
  }
}

/**
 * What a caller reads from that file: `{ pid, exited, exit, signal }`, or null when there is no readable
 * record. Once `exited`, `exit` is the code and `signal` the signal that ended the child, one of them null.
 */
export function readKeysChild(file) {
  let record = null;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(record?.pid)) return null;
  const exited = 'exit' in record;
  return { pid: record.pid, exited, exit: exited ? record.exit : null, signal: exited ? (record.signal ?? null) : null };
}

function output(destination) {
  return new Writable({ write(chunk, _encoding, callback) { destination.write(chunk, callback); } });
}

function childEnvironment(env, values) {
  const next = scrubRuntimeSecretsFromEnv(env);
  delete next[KEYS_CHILD_FILE];
  for (const name of Object.keys(next)) {
    if (EXECUTOR_PREFIX.test(name) || EXECUTOR_CONTROLS.has(name)) delete next[name];
  }
  return { ...next, ...values, MC_KEYS_NAMES: JSON.stringify(Object.keys(values).sort()) };
}

export async function listScriptKeys({ cwd = process.cwd(), env = process.env, stdout = process.stdout,
  stderr = process.stderr, home = process.env.HOME } = {}) {
  try {
    const { values } = readKeysDotenv({ cwd, env, home });
    const names = Object.keys(values).sort();
    rememberRuntimeSecretNames(names, env);
    for (const name of names) stdout.write(`${name}\n`);
    return 0;
  } catch (error) {
    stderr.write(`mc keys: ${error instanceof KeysDotenvError ? error.message : 'cannot read shared dotenv source'}\n`);
    return 1;
  }
}

export function runScriptWithKeys(script, args = [], options = {}) {
  return runWithKeys(script, args, options, true);
}

/** Long-lived servers use the same source, isolation, audit and output filters. */
export function serveWithKeys(command, args = [], options = {}) {
  return runWithKeys(command, args, options, false);
}

async function runWithKeys(script, args = [], { cwd = process.cwd(), env = process.env,
  stdout = process.stdout, stderr = process.stderr, home = process.env.HOME, spawn: spawnChild = spawn } = {}, nodeScript) {
  const record = { run: randomUUID(), script, content_hash: null, names: [], time: new Date().toISOString(), exit: null };
  let audit;
  let values = null;
  try {
    const directory = join(mcHome(env), 'keys');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    audit = openSync(join(directory, 'runs.jsonl'), 'a', 0o600);
    const loaded = readKeysDotenv({ cwd, env, home });
    values = loaded.values;
    record.names = Object.keys(values).sort();
    rememberRuntimeSecretNames(record.names, env);
    const entry = nodeScript ? resolve(cwd, script) : script;
    if (nodeScript && !['.js', '.mjs', '.cjs'].includes(extname(entry))) throw new KeysDotenvError('only Node .js, .mjs and .cjs scripts are supported');
    writeSync(audit, `${JSON.stringify({ ...record, event: 'start' })}\n`);
    const child = spawnChild(nodeScript ? process.execPath : entry, nodeScript ? [entry, ...args] : args, {
      cwd, env: childEnvironment(env, values), stdio: ['ignore', 'pipe', 'pipe'],
    });
    // A caller that keeps the wrapper alive needs the child's pid while it starts, and its exit when it leaves.
    const childFile = env[KEYS_CHILD_FILE] || null;
    if (childFile && child.pid !== undefined) {
      const pid = child.pid;
      recordChild(childFile, { pid }, stderr);
      child.once('exit', (code, signal) => recordExit(childFile, { pid, exit: code, signal: signal ?? null }, stderr));
    }
    const completion = new Promise(resolveCompletion => {
      child.once('error', () => resolveCompletion(1));
      child.once('close', (code, signal) => resolveCompletion(code ?? (128 + (constants.signals[signal] || 1))));
    });
    const forward = signal => { if (child.pid && child.exitCode === null && child.signalCode === null) child.kill(signal); };
    const onInt = () => forward('SIGINT'); const onTerm = () => forward('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    try {
      const streams = await Promise.allSettled([
        pipeline(child.stdout, keyOutputFilter(values), output(stdout)),
        pipeline(child.stderr, keyOutputFilter(values), output(stderr)),
      ]);
      record.exit = await completion;
      if (streams.some(result => result.status === 'rejected')) record.exit = 1;
    } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
  } catch (error) {
    const message = error instanceof KeysDotenvError ? error.message : 'run refused (source or runtime unavailable)';
    stderr.write(`mc keys: ${message}\n`);
    record.exit = 1;
  } finally {
    values = null;
    if (audit !== undefined) {
      try { writeSync(audit, `${JSON.stringify({ ...record, event: 'exit', ended_at: new Date().toISOString() })}\n`); }
      catch { stderr.write('mc keys: cannot record run exit\n'); record.exit = 1; }
      finally { closeSync(audit); }
    }
  }
  return record.exit ?? 1;
}
