/** Custody stays in this mc process; only a verified child receives the values. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as Module from 'node:module';
import { openScriptKeyVault } from '../vault/engine/script-keys.js';
import { mcHome } from './paths.js';
import { rememberRuntimeSecretNames, scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';
import { KeysError, readKeysManifest, refuse, verifyScriptSource } from './keys-source.js';
import { keyOutputFilter } from './keys-filter.js';

const PRELOAD = fileURLToPath(new URL('./keys-child.mjs', import.meta.url));
function namesOf(manifest) { return [...new Set(Object.values(manifest.scripts).flatMap(entry => Object.keys(entry.keys)))].sort(); }
function output(destination) {
  return new Writable({ write(chunk, _encoding, callback) { destination.write(chunk, callback); } });
}
function childEnvironment(env, values) {
  const next = scrubRuntimeSecretsFromEnv(env);
  for (const name of Object.keys(next)) {
    if (/^(?:NODE_|DYLD_|LD_|NPM_|npm_|GIT_)/u.test(name) || ['ENV', 'BASH_ENV'].includes(name)) delete next[name];
  }
  return { ...next, ...values };
}

export async function listScriptKeys({ cwd = process.cwd(), env = process.env, stdout = process.stdout,
  stderr = process.stderr, vaultDeps = {} } = {}) {
  try {
    const { manifest } = readKeysManifest(cwd, env);
    rememberRuntimeSecretNames(namesOf(manifest), env);
    const vault = await openScriptKeyVault({ deps: vaultDeps });
    const labels = new Map();
    for (const entry of Object.values(manifest.scripts)) for (const [name, label] of Object.entries(entry.keys)) {
      const all = labels.get(name) || new Set(); all.add(label); labels.set(name, all);
    }
    for (const name of [...labels.keys()].sort()) {
      const held = vault.ok && [...labels.get(name)].every(label => vault.held(label));
      stdout.write(`${name}  ${vault.ok ? held ? 'held' : 'missing' : 'unknown (vault locked or unavailable)'}\n`);
    }
    if (!vault.ok) { stderr.write(`mc keys: ${vault.reason}\n`); return 1; }
    return 0;
  } catch (error) { stderr.write(`mc keys: ${error instanceof KeysError ? error.message : 'cannot read key names'}\n`); return 1; }
}

export async function runScriptWithKeys(script, args = [], { cwd = process.cwd(), env = process.env,
  stdout = process.stdout, stderr = process.stderr, vaultDeps = {} } = {}) {
  const record = { run: randomUUID(), script, content_hash: null, names: [], time: new Date().toISOString(), exit: null };
  let audit;
  let values = null;
  try {
    const directory = join(mcHome(env), 'keys');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    audit = openSync(join(directory, 'runs.jsonl'), 'a', 0o600);
    const loaded = readKeysManifest(cwd, env);
    rememberRuntimeSecretNames(namesOf(loaded.manifest), env);
    if (typeof Module.registerHooks !== 'function') refuse('Node 22.15 or later is required');
    const source = verifyScriptSource(script, { cwd, env, ...loaded });
    Object.assign(record, { script: source.script, content_hash: source.contentHash, names: source.names });
    const vault = await openScriptKeyVault({ deps: vaultDeps });
    if (!vault.ok) refuse(`${vault.reason}; needed: ${source.names.join(', ') || '(none)'}`);
    const released = await vault.release(source.keys);
    if (!released.ok) refuse(released.reason);
    values = released.values;
    // Vault I/O is asynchronous. Recheck before launch, not just before decrypt.
    if (verifyScriptSource(script, { cwd, env }).contentHash !== source.contentHash) refuse('script source closure changed before launch');
    // Write the start before launch so a failed audit cannot produce an unrecorded run.
    writeSync(audit, `${JSON.stringify({ ...record, event: 'start' })}\n`);
    const child = spawn(process.execPath, ['--import', PRELOAD, join(source.root, source.script), ...args], {
      cwd, env: childEnvironment(env, values), stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const completion = new Promise(resolve => {
      child.once('error', () => resolve(1));
      child.once('close', (code, signal) => resolve(code ?? (128 + (constants.signals[signal] || 1))));
    });
    child.stdio[3].on('error', () => {}); // A startup refusal may close FD 3 before consuming it.
    child.stdio[3].end(JSON.stringify({ root: source.root, expected: source.expected }));
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
    // Only our fixed diagnostics may escape custody; never print child/crypto errors.
    const message = error instanceof KeysError ? error.message : 'run refused (vault, source or runtime unavailable)';
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
