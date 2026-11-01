/** Fixed source closure, like C1: hash every allowed file before custody opens.
 * Node's child-side hooks enforce this closed set for both import and require.
 * No project module is evaluated by the parent while discovering the closure.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { verifyC1SourceClosureFixture as verifySourceClosure } from '../runtime/broker/c1-source-closure.js';
import { scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';

export const KEYS_MANIFEST = '.mc-keys.json';
const PATH = /^[a-zA-Z0-9_./-]+$/u;
const RESERVED = /^(?:NODE_|DYLD_|LD_|MC_|GIT_|NPM_|npm_)/u;
const CONTROL = new Set(['PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'TMPDIR', 'PWD', 'USER', 'LOGNAME']);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export class KeysError extends Error {}
export const refuse = message => { throw new KeysError(message); };
export const keyName = name => /^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)
  && !RESERVED.test(name) && !CONTROL.has(name);
const sourcePath = path => typeof path === 'string' && PATH.test(path)
  && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..')
  && !path.split('/').includes('.git');

/** GIT_DIR and its kin must not redirect the comparison with origin/main. */
const withoutGit = env => Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));

function git(cwd, args, env) {
  const result = spawnSync('git', args, { cwd, env: scrubRuntimeSecretsFromEnv(withoutGit(env)),
    encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) refuse('repository or origin/main unavailable');
  return result.stdout;
}

export function readKeysManifest(cwd = process.cwd(), env = process.env) {
  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel'], env).trim());
  git(root, ['remote', 'get-url', 'origin'], env);
  const main = git(root, ['rev-parse', '--verify', 'origin/main^{commit}'], env).trim();
  const bytes = git(root, ['show', `${main}:${KEYS_MANIFEST}`], env);
  const expected = { [KEYS_MANIFEST]: sha256(bytes) };
  if (!verifySourceClosure({ packageRoot: root, expected }).ok) refuse('manifest differs from origin/main');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { refuse('invalid committed keys manifest'); }
  if (!manifest || manifest.version !== 1 || !manifest.scripts
    || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)
    || Object.keys(manifest).some(name => !['version', 'scripts'].includes(name))) refuse('invalid committed keys manifest');
  for (const [script, entry] of Object.entries(manifest.scripts)) {
    if (!sourcePath(script) || !['.js', '.mjs', '.cjs'].includes(extname(script))
      || !entry || Object.keys(entry).sort().join(',') !== 'keys,sources'
      || !entry.keys || typeof entry.keys !== 'object' || Array.isArray(entry.keys)
      || !Array.isArray(entry.sources) || !entry.sources.includes(script)
      || entry.sources.length > 2048 || new Set(entry.sources).size !== entry.sources.length
      || !entry.sources.every(path => sourcePath(path) && ['.js', '.mjs', '.cjs', '.json'].includes(extname(path)))) refuse('invalid committed script closure');
    for (const [name, label] of Object.entries(entry.keys)) {
      if (!keyName(name) || typeof label !== 'string' || !label || label.length > 512 || /[\x00-\x1f]/u.test(label)) refuse('invalid declared key name or label');
    }
  }
  return { root, main, manifest, expected };
}

export function verifyScriptSource(input, { cwd = process.cwd(), env = process.env, ...loaded } = {}) {
  const state = loaded.manifest ? loaded : readKeysManifest(cwd, env);
  const { root, main, manifest } = state;
  const script = relative(root, resolve(cwd, input)).split('\\').join('/');
  const entry = Object.hasOwn(manifest.scripts, script) ? manifest.scripts[script] : null;
  if (!entry) refuse('script is undeclared in .mc-keys.json');
  const expected = { ...state.expected };
  // Node consults package.json during resolution, even without an explicit import.
  const sources = new Set([...entry.sources, 'package.json']);
  for (const file of entry.sources) {
    let directory = dirname(file);
    for (;;) {
      const pkg = directory === '.' ? 'package.json' : `${directory}/package.json`;
      const onMain = spawnSync('git', ['cat-file', '-e', `${main}:${pkg}`], {
        cwd: root, env: scrubRuntimeSecretsFromEnv(env), stdio: 'ignore', timeout: 15_000,
      });
      if (onMain.error) refuse('cannot inspect package metadata');
      if (onMain.status === 0 || existsSync(join(root, pkg))) sources.add(pkg);
      if (directory === '.') break;
      directory = dirname(directory);
    }
  }
  for (const file of sources) expected[file] = sha256(git(root, ['show', `${main}:${file}`], env));
  if (!verifySourceClosure({ packageRoot: root, expected }).ok) refuse('script source closure differs from origin/main');
  const contentHash = sha256(JSON.stringify(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))));
  return { root, script, names: Object.keys(entry.keys).sort(), keys: entry.keys, expected, contentHash };
}
