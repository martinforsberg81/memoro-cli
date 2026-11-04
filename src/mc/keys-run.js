import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
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

function output(destination) {
  return new Writable({ write(chunk, _encoding, callback) { destination.write(chunk, callback); } });
}

function childEnvironment(env, values) {
  const next = scrubRuntimeSecretsFromEnv(env);
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
  stdout = process.stdout, stderr = process.stderr, home = process.env.HOME } = {}, nodeScript) {
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
    const child = spawn(nodeScript ? process.execPath : entry, nodeScript ? [entry, ...args] : args, {
      cwd, env: childEnvironment(env, values), stdio: ['ignore', 'pipe', 'pipe'],
    });
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
