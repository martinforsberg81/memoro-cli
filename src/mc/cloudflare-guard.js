import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { mcHome as defaultMcHome } from './paths.js';

export const GUARDED_TOOL_ID = 'codex';
export const GUARD_ENV = 'MC_CLOUDFLARE_GUARD';
export const GUARDED_COMMANDS = Object.freeze(['wrangler', 'npx']);

const D1_DENIED = new Set(['execute', 'export', 'backup', 'time-travel']);
const KV_KEY_DENIED = new Set(['get', 'list', 'put', 'delete']);
const R2_OBJECT_DENIED = new Set(['get', 'put', 'delete', 'list']);
const SECRET_DENIED = new Set(['list', 'get', 'put', 'delete']);
const NODE_VALUE_OPTIONS = new Set([
  '--conditions',
  '--env-file',
  '--experimental-loader',
  '--import',
  '--loader',
  '--require',
  '-C',
  '-r',
]);

/**
 * Install a tiny PATH guard for Codex sessions. Codex does not expose a
 * PreToolUse hook equivalent, so mc launches it with a guarded PATH where
 * data-bearing Cloudflare Wrangler commands are denied before they reach
 * the real binary.
 */
export function prepareCloudflareGuardEnv({
  baseEnv = process.env,
  mcDir = defaultMcHome(),
  codingSessionId = 'session',
  approvedScripts = null,
  effectiveConfig = null,
  deps = {},
} = {}) {
  const dir = deps.guardBinDir || guardBinDir({ mcDir, codingSessionId });
  const mkdir = deps.mkdirSync || mkdirSync;
  const writeFile = deps.writeFileSync || writeFileSync;
  const chmod = deps.chmodSync || chmodSync;
  const script = renderCloudflareGuardScript({
    approvedScripts: resolveApprovedScripts({ approvedScripts, effectiveConfig }),
  });

  mkdir(dir, { recursive: true, mode: 0o700 });
  for (const command of GUARDED_COMMANDS) {
    const target = join(dir, command);
    writeFile(target, script, { mode: 0o700 });
    try { chmod(target, 0o700); } catch { /* best effort on non-posix fs */ }
  }

  return {
    dir,
    env: {
      ...baseEnv,
      PATH: prependPath(dir, baseEnv.PATH),
      [GUARD_ENV]: 'codex',
    },
  };
}

export function guardBinDir({ mcDir = defaultMcHome(), codingSessionId = 'session' } = {}) {
  return join(mcDir, 'guard-bin', safeSegment(codingSessionId));
}

export function prependPath(dir, existingPath = '') {
  return existingPath ? `${dir}${delimiter}${existingPath}` : dir;
}

export function isDeniedWranglerCommand(args = []) {
  const allArgs = args.map(String);
  const command = stripWranglerGlobalArgs(allArgs);
  const [area, subcommand, detail] = command;

  if (area === 'd1') {
    if (D1_DENIED.has(subcommand)) return true;
    if (subcommand === 'migrations' && detail === 'apply') {
      return hasRemoteOrProductionFlag(allArgs);
    }
    return false;
  }

  if (area === 'kv') {
    if (subcommand === 'bulk') return true;
    if (subcommand === 'key' && KV_KEY_DENIED.has(detail)) return true;
    return false;
  }

  if (area === 'r2') {
    if (subcommand === 'object' && R2_OBJECT_DENIED.has(detail)) return true;
    return false;
  }

  if (area === 'tail') return true;
  if (area === 'dev') return hasFlag(allArgs, '--remote');
  if (area === 'secret') return SECRET_DENIED.has(subcommand);
  if (area === 'queues') return subcommand === 'consumer';
  if (area === 'vectorize') return subcommand === 'query';

  return false;
}

export function extractNpxWranglerArgs(args = []) {
  const values = args.map(String);
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === '--') continue;
    if (arg === '-p' || arg === '--package' || arg === '--call' || arg === '-c') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--package=') || arg.startsWith('--call=')) continue;
    if (arg === '-y' || arg === '--yes' || arg === '--no-install' || arg === '--quiet') continue;
    if (arg.startsWith('-')) continue;
    if (arg === 'wrangler' || arg.startsWith('wrangler@')) return values.slice(i + 1);
    return null;
  }
  return null;
}

export function approvedScriptsFromEffectiveConfig(effectiveConfig = {}) {
  const field = effectiveConfig?.dataAccess?.cloudflare?.approvedScripts;
  if (Array.isArray(field)) return normaliseApprovedScriptSpecs(field);
  return normaliseApprovedScriptSpecs(field?.value);
}

export function normaliseApprovedScriptSpecs(input = []) {
  if (!Array.isArray(input)) return [];
  return input
    .map(normaliseApprovedScriptSpec)
    .filter(Boolean);
}

export function isAllowedAdminCommandLine(commandLine = '', { approvedScripts = [] } = {}) {
  const specs = normaliseApprovedScriptSpecs(approvedScripts);
  if (!specs.length) return false;

  const tokens = tokenizeCommandLine(commandLine).map(normalisePathToken);
  if (!tokens.length) return false;
  const command = normaliseCommandName(tokens[0]);
  if (!command) return false;
  if (tokens.some((token) => token === '-e' || token === '--eval' || token.startsWith('--eval='))) {
    return false;
  }

  const scriptIndex = findNodeScriptArg(tokens.slice(1));
  if (scriptIndex < 0) return false;
  const scriptArg = tokens.slice(1)[scriptIndex];
  return specs.some((spec) => (
    command === spec.command && matchesScriptPattern(scriptArg, spec.script)
  ));
}

export function renderCloudflareGuardScript({ approvedScripts = [] } = {}) {
  const approved = normaliseApprovedScriptSpecs(approvedScripts);
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

const guardedCommands = new Set(${JSON.stringify(GUARDED_COMMANDS)});
const d1Denied = new Set(${JSON.stringify([...D1_DENIED])});
const kvKeyDenied = new Set(${JSON.stringify([...KV_KEY_DENIED])});
const r2ObjectDenied = new Set(${JSON.stringify([...R2_OBJECT_DENIED])});
const secretDenied = new Set(${JSON.stringify([...SECRET_DENIED])});
const approvedScripts = ${JSON.stringify(approved)};
const nodeValueOptions = new Set(${JSON.stringify([...NODE_VALUE_OPTIONS])});

const invoked = basename(process.argv[1] || '');
const originalArgs = process.argv.slice(2);
const selfDir = resolve(dirname(process.argv[1] || '.'));

if (!guardedCommands.has(invoked)) {
  process.stderr.write('mc Cloudflare guard invoked under an unexpected command name.\\n');
  process.exit(127);
}

const wranglerArgs = invoked === 'wrangler'
  ? originalArgs
  : extractNpxWranglerArgs(originalArgs);

if (wranglerArgs && isDeniedWranglerCommand(wranglerArgs) && !isAllowedAdminAncestor()) {
  process.stderr.write([
    'mc: blocked direct Cloudflare data access in this Codex session.',
    'Use a repo-approved admin script declared in .mc/policy.json,',
    'or run the admin Wrangler command yourself outside the LLM session.',
    '',
  ].join('\\n'));
  process.exit(126);
}

const real = findRealExecutable(invoked, selfDir);
if (!real) {
  process.stderr.write('mc: could not find the real ' + invoked + ' binary after Cloudflare guard.\\n');
  process.exit(127);
}

const childEnv = { ...process.env, PATH: pathWithoutSelfDir(process.env.PATH || '', selfDir) };
const result = spawnSync(real, originalArgs, { stdio: 'inherit', env: childEnv });
if (result.error) {
  process.stderr.write('mc: failed to execute real ' + invoked + ': ' + result.error.message + '\\n');
  process.exit(127);
}
if (result.signal) process.exit(1);
process.exit(result.status ?? 0);

function findRealExecutable(command, skipDir) {
  const path = process.env.PATH || '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    if (sameDir(dir, skipDir)) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function pathWithoutSelfDir(path, skipDir) {
  return path
    .split(delimiter)
    .filter((dir) => dir && !sameDir(dir, skipDir))
    .join(delimiter);
}

function sameDir(a, b) {
  try { return resolve(a) === resolve(b); } catch { return a === b; }
}

function isDeniedWranglerCommand(args = []) {
  const allArgs = args.map(String);
  const command = stripWranglerGlobalArgs(allArgs);
  const [area, subcommand, detail] = command;

  if (area === 'd1') {
    if (d1Denied.has(subcommand)) return true;
    if (subcommand === 'migrations' && detail === 'apply') {
      return hasRemoteOrProductionFlag(allArgs);
    }
    return false;
  }

  if (area === 'kv') {
    if (subcommand === 'bulk') return true;
    if (subcommand === 'key' && kvKeyDenied.has(detail)) return true;
    return false;
  }

  if (area === 'r2') {
    if (subcommand === 'object' && r2ObjectDenied.has(detail)) return true;
    return false;
  }

  if (area === 'tail') return true;
  if (area === 'dev') return hasFlag(allArgs, '--remote');
  if (area === 'secret') return secretDenied.has(subcommand);
  if (area === 'queues') return subcommand === 'consumer';
  if (area === 'vectorize') return subcommand === 'query';

  return false;
}

function extractNpxWranglerArgs(args = []) {
  const values = args.map(String);
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === '--') continue;
    if (arg === '-p' || arg === '--package' || arg === '--call' || arg === '-c') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--package=') || arg.startsWith('--call=')) continue;
    if (arg === '-y' || arg === '--yes' || arg === '--no-install' || arg === '--quiet') continue;
    if (arg.startsWith('-')) continue;
    if (arg === 'wrangler' || arg.startsWith('wrangler@')) return values.slice(i + 1);
    return null;
  }
  return null;
}

function stripWranglerGlobalArgs(args) {
  const valueFlags = new Set(['--config', '--cwd', '--env', '-e']);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') return args.slice(i + 1);
    if (!arg.startsWith('-')) return args.slice(i);
    if (valueFlags.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith('--config=') || arg.startsWith('--cwd=') || arg.startsWith('--env=')) {
      i += 1;
      continue;
    }
    i += 1;
  }
  return [];
}

function hasRemoteOrProductionFlag(args) {
  return hasFlag(args, '--remote') || hasFlagValue(args, '--env', 'production') || hasFlagValue(args, '-e', 'production');
}

function hasFlag(args, flag) {
  return args.some((arg) => arg === flag || arg.startsWith(flag + '='));
}

function hasFlagValue(args, flag, value) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag && args[i + 1] === value) return true;
    if (arg === flag + '=' + value) return true;
  }
  return false;
}

function isAllowedAdminAncestor() {
  let pid = process.ppid;
  for (let depth = 0; pid && depth < 8; depth += 1) {
    const command = ps(pid, 'command=');
    if (command && isAllowedAdminCommandLine(command)) return true;
    const parent = ps(pid, 'ppid=').trim();
    const next = Number(parent);
    if (!Number.isFinite(next) || next <= 1 || next === pid) return false;
    pid = next;
  }
  return false;
}

function ps(pid, field) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', field], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function isAllowedAdminCommandLine(commandLine = '') {
  if (!approvedScripts.length) return false;
  const tokens = tokenizeCommandLine(commandLine).map(normalisePathToken);
  if (!tokens.length) return false;
  const command = normaliseCommandName(tokens[0]);
  if (!command) return false;
  if (tokens.some((token) => token === '-e' || token === '--eval' || token.startsWith('--eval='))) {
    return false;
  }
  const args = tokens.slice(1);
  const scriptIndex = findNodeScriptArg(args);
  if (scriptIndex < 0) return false;
  const scriptArg = args[scriptIndex];
  return approvedScripts.some((spec) => (
    command === spec.command && matchesScriptPattern(scriptArg, spec.script)
  ));
}

function tokenizeCommandLine(commandLine = '') {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of String(commandLine)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function normalisePathToken(token) {
  return String(token || '').replace(/\\\\/g, '/');
}

function normaliseCommandName(token) {
  const command = normalisePathToken(token).split('/').pop();
  return command === 'node' || command === 'nodejs' ? command : null;
}

function findNodeScriptArg(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') return i + 1 < args.length ? i + 1 : -1;
    if (arg === '-e' || arg === '--eval' || arg.startsWith('--eval=')) return -1;
    if (nodeValueOptions.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (arg.startsWith('-')) continue;
    return i;
  }
  return -1;
}

function matchesScriptPattern(scriptArg, pattern) {
  const script = stripDotSlash(normalisePathToken(scriptArg));
  const expected = stripDotSlash(normalisePathToken(pattern));
  if (!script || !expected) return false;
  const source = globSource(expected);
  const regex = expected.startsWith('/')
    ? new RegExp('^' + source + '$')
    : new RegExp('^(?:.*\\/)?' + source + '$');
  return regex.test(script);
}

function stripDotSlash(value) {
  let s = String(value || '');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function globSource(pattern) {
  let out = '';
  for (const char of String(pattern)) {
    if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += escapeRegExp(char);
  }
  return out;
}

function escapeRegExp(char) {
  return /[|\\\\{}()[\\]^$+*?.]/.test(char) ? '\\\\' + char : char;
}
`;
}

function resolveApprovedScripts({ approvedScripts = null, effectiveConfig = null } = {}) {
  if (approvedScripts != null) return normaliseApprovedScriptSpecs(approvedScripts);
  return approvedScriptsFromEffectiveConfig(effectiveConfig);
}

function normaliseApprovedScriptSpec(spec) {
  if (typeof spec === 'string') {
    const tokens = tokenizeCommandLine(spec).map(normalisePathToken);
    return normaliseApprovedScriptTokens(tokens);
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  if (typeof spec.script === 'string') {
    const command = normaliseCommandName(spec.command);
    const script = normaliseScriptPattern(spec.script);
    return command && script ? { command, script } : null;
  }
  const command = normaliseCommandName(spec.command);
  const args = Array.isArray(spec.args) ? spec.args.map(normalisePathToken) : [];
  return normaliseApprovedScriptTokens([command, ...args]);
}

function normaliseApprovedScriptTokens(tokens) {
  if (!tokens.length) return null;
  const command = normaliseCommandName(tokens[0]);
  if (!command) return null;
  if (tokens.some((token) => token === '-e' || token === '--eval' || token.startsWith('--eval='))) {
    return null;
  }
  const args = tokens.slice(1);
  const scriptIndex = findNodeScriptArg(args);
  if (scriptIndex < 0) return null;
  const script = normaliseScriptPattern(args[scriptIndex]);
  return script ? { command, script } : null;
}

function normaliseScriptPattern(value) {
  const script = stripDotSlash(normalisePathToken(value)).trim();
  if (!script || script.startsWith('-') || /\s/.test(script)) return null;
  return script;
}

function tokenizeCommandLine(commandLine = '') {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of String(commandLine)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function normalisePathToken(token) {
  return String(token || '').replace(/\\/g, '/');
}

function normaliseCommandName(token) {
  const command = normalisePathToken(token).split('/').pop();
  return command === 'node' || command === 'nodejs' ? command : null;
}

function findNodeScriptArg(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') return i + 1 < args.length ? i + 1 : -1;
    if (arg === '-e' || arg === '--eval' || arg.startsWith('--eval=')) return -1;
    if (NODE_VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (arg.startsWith('-')) continue;
    return i;
  }
  return -1;
}

function matchesScriptPattern(scriptArg, pattern) {
  const script = stripDotSlash(normalisePathToken(scriptArg));
  const expected = stripDotSlash(normalisePathToken(pattern));
  if (!script || !expected) return false;
  const source = globSource(expected);
  const regex = expected.startsWith('/')
    ? new RegExp(`^${source}$`)
    : new RegExp(`^(?:.*/)?${source}$`);
  return regex.test(script);
}

function stripDotSlash(value) {
  let s = String(value || '');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function globSource(pattern) {
  let out = '';
  for (const char of String(pattern)) {
    if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += escapeRegExp(char);
  }
  return out;
}

function escapeRegExp(char) {
  return /[|\\{}()[\]^$+*?.]/.test(char) ? `\\${char}` : char;
}

function stripWranglerGlobalArgs(args) {
  const valueFlags = new Set(['--config', '--cwd', '--env', '-e']);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') return args.slice(i + 1);
    if (!arg.startsWith('-')) return args.slice(i);
    if (valueFlags.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith('--config=') || arg.startsWith('--cwd=') || arg.startsWith('--env=')) {
      i += 1;
      continue;
    }
    i += 1;
  }
  return [];
}

function hasRemoteOrProductionFlag(args) {
  return hasFlag(args, '--remote')
    || hasFlagValue(args, '--env', 'production')
    || hasFlagValue(args, '-e', 'production');
}

function hasFlag(args, flag) {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function hasFlagValue(args, flag, value) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag && args[i + 1] === value) return true;
    if (arg === `${flag}=${value}`) return true;
  }
  return false;
}

function safeSegment(value) {
  const s = String(value || 'session').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
  return s || 'session';
}

// Exported for parity tests if a future guard needs to inspect real process
// trees in-process. The runtime shim carries its own copy to stay standalone.
export function isAllowedAdminAncestor({
  pid = process.ppid,
  depthLimit = 8,
  ps = defaultPs,
  approvedScripts = [],
} = {}) {
  let current = pid;
  for (let depth = 0; current && depth < depthLimit; depth += 1) {
    const command = ps(current, 'command=');
    if (command && isAllowedAdminCommandLine(command, { approvedScripts })) return true;
    const parent = String(ps(current, 'ppid=') || '').trim();
    const next = Number(parent);
    if (!Number.isFinite(next) || next <= 1 || next === current) return false;
    current = next;
  }
  return false;
}

function defaultPs(pid, field) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', field], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
