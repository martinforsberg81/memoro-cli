import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { guardBinDir } from './cloudflare-guard.js';
import {
  DEV_DEFINITION_INVALID,
  DEV_DEFINITION_NOT_FOUND,
  loadDevDefinition,
} from './dev-definition.js';
import { mcHome as defaultMcHome } from './paths.js';

export const DEV_COMMAND_GUARD_ENV = 'MC_DEV_COMMAND_GUARD';
export const DEV_ENSURE_LAUNCH_ENV = 'MC_DEV_ENSURE_LAUNCH';

export function prepareDevCommandGuardEnv({
  baseEnv = process.env,
  worktreePath,
  mcDir = defaultMcHome(),
  codingSessionId = 'session',
  deps = {},
} = {}) {
  const cleanEnv = { ...baseEnv };
  delete cleanEnv[DEV_ENSURE_LAUNCH_ENV];
  let loaded;
  try {
    loaded = (deps.loadDevDefinition || loadDevDefinition)({ worktreePath });
  } catch (error) {
    if (error?.code === DEV_DEFINITION_NOT_FOUND || error?.code === DEV_DEFINITION_INVALID) {
      return { installed: false, env: cleanEnv, dir: null, commands: [] };
    }
    throw error;
  }

  const prefixes = managedPrefixes(loaded.definition);
  const commands = [...new Set(prefixes.map((argv) => basename(argv[0])))].sort();
  if (!commands.length) {
    return { installed: false, env: cleanEnv, dir: null, commands: [] };
  }

  const dir = deps.guardBinDir || devCommandGuardBinDir({ mcDir, codingSessionId });
  const mkdir = deps.mkdirSync || mkdirSync;
  const writeFile = deps.writeFileSync || writeFileSync;
  const chmod = deps.chmodSync || chmodSync;
  const script = renderDevCommandGuardScript({ worktreePath, prefixes });
  mkdir(dir, { recursive: true, mode: 0o700 });
  for (const command of commands) {
    const target = join(dir, command);
    writeFile(target, script, { mode: 0o700 });
    try { chmod(target, 0o700); } catch { /* best effort on non-posix fs */ }
  }
  return {
    installed: true,
    dir,
    commands,
    env: {
      ...cleanEnv,
      PATH: prependPath(dir, cleanEnv.PATH),
      [DEV_COMMAND_GUARD_ENV]: loaded.fingerprint,
    },
  };
}

export function devCommandGuardBinDir({ mcDir = defaultMcHome(), codingSessionId = 'session' } = {}) {
  return join(guardBinDir({ mcDir, codingSessionId }), 'dev');
}

export function isManagedDevCommand(argv = [], prefixes = []) {
  const values = argv.map(String);
  return prefixes.some((prefix) => {
    const expected = prefix.map(String);
    if (!expected.length || basename(values[0] || '') !== basename(expected[0])) return false;
    if (expected.every((arg, index) => (
      index === 0 ? basename(values[index] || '') === basename(arg) : values[index] === arg
    ))) return true;

    // Declaring `npm run dev` also owns its conventional dev:* variants.
    return basename(expected[0]) === 'npm'
      && expected[1] === 'run'
      && expected[2] === 'dev'
      && basename(values[0] || '') === 'npm'
      && values[1] === 'run'
      && typeof values[2] === 'string'
      && values[2].startsWith('dev:');
  });
}

export function renderDevCommandGuardScript({ worktreePath, prefixes } = {}) {
  return `#!${process.execPath}\nimport { runDevCommandGuardShim } from ${JSON.stringify(import.meta.url)};\nprocess.exit(runDevCommandGuardShim({\n  invokedPath: process.argv[1],\n  argv: process.argv.slice(2),\n  worktreePath: ${JSON.stringify(worktreePath)},\n  prefixes: ${JSON.stringify(prefixes)},\n}));\n`;
}

export function runDevCommandGuardShim({
  invokedPath = process.argv[1],
  argv = process.argv.slice(2),
  worktreePath,
  env = process.env,
  cwd = process.cwd(),
  stderr = process.stderr,
  deps = {},
  prefixes = [],
} = {}) {
  const invoked = basename(invokedPath || '');
  const selfDir = resolve(dirname(invokedPath || '.'));
  const declaredCommands = new Set(prefixes.map((prefix) => basename(prefix[0] || '')));
  if (!declaredCommands.has(invoked)) {
    stderr.write('mc: dev command guard invoked under an unexpected command name.\n');
    return 127;
  }

  const childEnv = { ...env, PATH: pathWithoutSelfDir(env.PATH || '', selfDir) };
  if (isInsideWorktree(cwd, worktreePath)
    && env[DEV_ENSURE_LAUNCH_ENV] !== '1'
    && isManagedDevCommand([invoked, ...argv], prefixes)) {
    stderr.write('mc: blocked a direct repository dev-server command.\n');
    stderr.write('mc: use `mc dev ensure` so dependencies, identity, health, reuse, and resource limits are enforced.\n');
    stderr.write('mc: choose a profile with `--profile <name>`; use `--restart` only for explicit replacement.\n');
    return 75;
  }

  const real = findRealExecutable(invoked, selfDir, env.PATH || '', deps.existsSync || existsSync);
  if (!real) {
    stderr.write(`mc: could not find the real ${invoked} binary after the dev command guard.\n`);
    return 127;
  }
  const result = (deps.spawnSync || spawnSync)(real, argv, {
    cwd,
    env: childEnv,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    stderr.write(`mc: failed to execute real ${invoked}: ${result.error.message}\n`);
    return 127;
  }
  return result.signal ? 1 : (result.status ?? 0);
}

function managedPrefixes(definition) {
  return Object.values(definition?.services || {})
    .flatMap((service) => service.managed_argv_prefixes || []);
}

function isInsideWorktree(cwd, worktreePath) {
  if (!cwd || !worktreePath) return false;
  const rel = relative(canonicalPath(worktreePath), canonicalPath(cwd));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function findRealExecutable(command, skipDir, path, exists) {
  for (const dir of path.split(delimiter)) {
    if (!dir || resolve(dir) === skipDir) continue;
    const candidate = join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function pathWithoutSelfDir(path, selfDir) {
  return path.split(delimiter)
    .filter((dir) => dir && resolve(dir) !== selfDir)
    .join(delimiter);
}

function prependPath(dir, existingPath = '') {
  return existingPath ? `${dir}${delimiter}${existingPath}` : dir;
}
