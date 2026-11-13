/** Linux SSH owns a tmux client; the persistent worker owns the provider. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workRoot } from './paths.js';
import { foregroundDir } from './foreground.js';
import { normalizeSessionRole } from './session-role.js';
import { scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';
import { pidAlive } from './status-collect.js';

const WORKER = fileURLToPath(new URL('./interactive-terminal-worker.js', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const quote = value => `'${String(value).replace(/'/gu, `'\\''`)}'`;
const ENTRANCES = new Set(['plan', 'manager', 'brief', 'helper', 'martin']);
const OPTION_KEYS = ['areaRoot', 'conversationRoots', 'worktree', 'tool', 'pick', 'resumeTool', 'model',
  'overlay', 'prompt', 'resumePrompt', 'defaultModel', 'defaultModelTool', 'verb', 'areaName',
  'roleName', 'programme', 'roleSource', 'cache'];

export function needsPersistentTerminal({ env = process.env, platform = process.platform, isInteractive, verb } = {}) {
  return platform === 'linux' && ENTRANCES.has(verb) && env.MC_HEADLESS !== '1'
    && Boolean(env.SSH_CONNECTION || env.SSH_TTY) && isInteractive(env);
}

/** A fresh launch must not depend on the environment of an older tmux server. */
export function terminalEnvironment(env) {
  const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TERM', 'COLORTERM',
    'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'MC_HOME', 'MC_WORK_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']);
  return Object.fromEntries(Object.entries(scrubRuntimeSecretsFromEnv(env))
    .filter(([key, value]) => typeof value === 'string' && (allowed.has(key) || /^LC_[A-Z_]+$/u.test(key))));
}

export function terminalAddress(options) {
  const root = resolve(workRoot(options.env));
  return {
    socket: `mc-interactive-${hash(root)}`,
    target: `mc-${hash([root, resolve(options.areaRoot), normalizeSessionRole(options.roleName || options.verb), options.programme || null])}`,
  };
}

/** Exact cwd only: a programme's goal workers are separate owners. No argv or transcripts. */
export function liveTerminalOwners(options, { procRoot = '/proc', alive = pidAlive } = {}) {
  const found = new Set();
  const directory = foregroundDir(options.env);
  try {
    for (const name of readdirSync(directory)) {
      if (!/^\d+\.json$/u.test(name)) continue;
      try {
        const item = JSON.parse(readFileSync(join(directory, name), 'utf8'));
        const role = normalizeSessionRole(item.role?.name || item.verb);
        if (role === normalizeSessionRole(options.roleName || options.verb)
          && (item.programme || null) === (options.programme || null)
          && (item.area || null) === (options.areaName || null) && alive(item.pid)) found.add(item.pid);
      } catch { /* a concurrent release is not an owner */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cwd = realpathSync(options.worktree.path);
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const comm = readFileSync(join(procRoot, name, 'comm'), 'utf8').trim();
      if (!['codex', 'claude'].includes(comm)) continue;
      if (readlinkSync(join(procRoot, name, 'cwd')) === cwd) found.add(Number(name));
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Return the launch result; never fall back to the SSH terminal after a failure. */
export function openPersistentTerminal(options, {
  run = (args, opts) => spawnSync('tmux', args, opts),
  owners = liveTerminalOwners,
} = {}) {
  const { env = process.env, stderr = process.stderr } = options;
  const { socket, target } = terminalAddress(options);
  // A separate server ignores personal tmux startup settings (including destructive
  // detach policies). Session options below never change another tmux session.
  const prefix = ['-L', socket, '-f', '/dev/null'];
  const tmux = (args, attached = false) => {
    const clientEnv = terminalEnvironment(env);
    return run([...prefix, ...args], { env: clientEnv, stdio: attached ? 'inherit' : 'pipe', encoding: 'utf8' });
  };
  const exists = () => tmux(['has-session', '-t', `=${target}`]);
  const conflicting = () => {
    if (options.pick != null || options.model) return true;
    if (!options.resumeTool) return false;
    const current = tmux(['show-option', '-qv', '-t', `=${target}`, '@mc-provider']);
    return current.status !== 0 || String(current.stdout || '').trim() !== options.resumeTool.replace('claude-code', 'claude');
  };
  const attach = () => {
    if (conflicting()) return { ok: false, reason: 'this session is already running; reopen without --new, --resume, --model or a different provider, or exit the existing session first' };
    return attachNow();
  };
  const attachNow = () => {
    stderr.write('mc: joining the persistent terminal; SSH disconnect leaves the session running (detach: Ctrl-B, D).\n');
    const result = tmux(['attach-session', '-t', `=${target}`], true);
    return result.error || result.status !== 0
      ? { ok: false, reason: 'could not attach to the persistent terminal; reopen to retry (the session may have exited)', code: result.status || 1 }
      : { ok: true, code: 0, terminal: target };
  };
  const existing = exists();
  if (existing.error) return { ok: false, reason: `tmux is required for Linux SSH sessions: ${existing.error.message}` };
  if (existing.status === 0) return attach();
  const running = owners(options);
  if (running.length) return { ok: false, reason: `this session is already running outside the persistent terminal (PID ${running.join(', ')}); return to that terminal and exit the session before reopening. No second provider was started` };

  const directory = join(workRoot(env), 'runner', 'interactive-requests');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const request = join(directory, `${randomUUID()}.json`);
  const launch = Object.fromEntries(OPTION_KEYS.filter(key => options[key] !== undefined).map(key => [key, options[key]]));
  // Only launch options: no environment, grant, credential or provider output.
  writeFileSync(request, JSON.stringify(launch), { mode: 0o600, flag: 'wx' });
  let createdHere = false;
  try {
    const clean = terminalEnvironment(env);
    delete clean.TERM;
    const command = ['exec', '/usr/bin/env', '-i', ...Object.entries(clean).map(([key, value]) => `${key}=${value}`)]
      .map(quote).join(' ') + ' TERM="$TERM" '
      + [process.execPath, WORKER, request, socket, target].map(quote).join(' ');
    const created = tmux(['new-session', '-d', '-s', target, '-c', options.worktree.path, command,
      ';', 'set-option', '-t', `=${target}`, 'mouse', 'on',
      ';', 'set-option', '-t', `=${target}`, 'status', 'off',
      ';', 'set-option', '-t', `=${target}`, 'history-limit', '50000']);
    if (created.error || created.status !== 0) {
      // Another client's atomic new-session may have won. Its request is its own.
      if (!created.error && exists().status === 0) return attach();
      return { ok: false, reason: 'tmux could not create the persistent terminal; no direct SSH launch was attempted' };
    }
    createdHere = true;
    return attachNow();
  } finally {
    // The worker consumes its request before opening; also clean failed/racing calls.
    if (!createdHere) rmSync(request, { force: true });
  }
}
