/**
 * Every git a test process starts is the repository model.
 *
 * Martin, 2026-11-01: tests make no git call. `useGitRunner` covers the code
 * under test; a fixture spawns git itself, in forty files and four spellings,
 * so the same model stands in at `node:child_process`: a spawn whose program is
 * git (argv, or a shell line that is one git command) is answered by the model
 * and starts nothing. A file named in `REAL_GIT_FILES` keeps real git.
 */
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { FakeGit } from './mc/_helpers/fake-git.js';

// Copied now: a named import is a live binding, and would answer with the patch.
const { spawnSync: realSpawnSync, execSync: realExecSync, execFileSync: realExecFileSync, spawn: realSpawn, execFile: realExecFile, exec: realExec } = { ...childProcess };

/** The argv of a shell line that is exactly one git command, or null. */
export function gitLine(line) {
  if (typeof line !== 'string' || !/^\s*git(\s|$)/u.test(line)) return null;
  const words = [];
  let word = null;
  let quote = null;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null; else word += char;
    } else if (char === '"' || char === "'") { quote = char; word ??= ''; }
    else if (/\s/u.test(char)) { if (word !== null) words.push(word); word = null; }
    else if (/[|&;<>()$`\\*?]/u.test(char)) return null;
    else word = (word ?? '') + char;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words.slice(1);
}

function failure(result, args) {
  const error = new Error(`Command failed: git ${args.join(' ')}\n${result.stderr || ''}`);
  Object.assign(error, { status: result.status, stdout: result.stdout, stderr: result.stderr });
  return error;
}

export function installFakeGitDefault(model = new FakeGit()) {
  const answer = (args, options = {}) => {
    const result = model.runner(options.cwd || process.cwd(), args, { env: options.env, input: options.input, encoding: 'utf8' });
    return { pid: 0, output: [null, result.stdout, result.stderr], ...result };
  };
  // A child's git is this model: snapshot before it starts, read back when it ends.
  let serial = 0;
  const dir = join(process.env.TMPDIR || tmpdir(), 'fake-git-state');
  const shared = (options) => {
    mkdirSync(dir, { recursive: true });
    const file = model.snapshot(join(dir, `${process.pid}-${serial++}.json`));
    return { file, options: { ...options, env: FakeGit.childEnv(options?.env || process.env, file) } };
  };
  const back = (file) => { try { model.reload(file); } catch { /* the child never wrote */ } };
  const isGit = (file) => file === 'git' || /\/git$/u.test(String(file));
  const text = (value, options) => (options?.encoding && options.encoding !== 'buffer' ? value : Buffer.from(value ?? ''));
  childProcess.spawnSync = (file, args, options) => {
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    if (!isGit(file)) {
      const child = shared(opts);
      try { return realSpawnSync(file, argv, child.options); } finally { back(child.file); }
    }
    const result = answer(argv, opts);
    return { ...result, stdout: text(result.stdout, opts), stderr: text(result.stderr, opts) };
  };
  childProcess.execFileSync = (file, args, options) => {
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    if (!isGit(file)) {
      const child = shared(opts);
      try { return realExecFileSync(file, argv, child.options); } finally { back(child.file); }
    }
    const result = answer(argv, opts);
    if (result.status !== 0) throw failure(result, argv);
    return text(result.stdout, opts);
  };
  childProcess.execSync = (line, options) => {
    const argv = gitLine(line);
    if (!argv) {
      const child = shared(options);
      try { return realExecSync(line, child.options); } finally { back(child.file); }
    }
    const result = answer(argv, options);
    if (result.status !== 0) throw failure(result, argv);
    return text(result.stdout, options);
  };
  childProcess.execFile = (file, ...rest) => {
    const callback = rest.pop();
    const argv = Array.isArray(rest[0]) ? rest[0] : [];
    const opts = Array.isArray(rest[0]) ? rest[1] : rest[0];
    if (!isGit(file)) {
      const child = shared(opts);
      return realExecFile(file, argv, child.options, (...result) => { back(child.file); callback(...result); });
    }
    const result = answer(argv, opts);
    setImmediate(() => callback(result.status === 0 ? null : failure(result, argv), result.stdout, result.stderr));
    return new EventEmitter();
  };
  childProcess.exec = (line, ...rest) => {
    const argv = gitLine(line);
    const callback = rest.pop();
    const opts = typeof rest[0] === 'object' ? rest[0] : {};
    if (!argv) {
      const child = shared(opts);
      return realExec(line, child.options, (...result) => { back(child.file); callback(...result); });
    }
    const result = answer(argv, opts);
    setImmediate(() => callback(result.status === 0 ? null : failure(result, argv), result.stdout, result.stderr));
    return new EventEmitter();
  };
  childProcess.spawn = (file, args, options) => {
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    if (!isGit(file)) {
      const shared2 = shared(opts);
      const child = realSpawn(file, argv, shared2.options);
      child.once('exit', () => back(shared2.file));
      return child;
    }
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      const result = answer(argv, opts);
      child.stdout.end(result.stdout || '');
      child.stderr.end(result.stderr || '');
      child.emit('exit', result.status, null);
      child.emit('close', result.status, null);
    });
    return child;
  };
  syncBuiltinESMExports();
  return model.install();
}
