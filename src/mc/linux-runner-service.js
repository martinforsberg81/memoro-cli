/** Linux user-systemd adapter for mc's per-work-root runner. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const SYSTEMD_CONTEXT = 'MC_RUN_SYSTEMD_CONTEXT';

export function readLinuxIdentity(pid, { read = readFileSync } = {}) {
  try {
    const bootId = String(read('/proc/sys/kernel/random/boot_id')).trim();
    const stat = String(read(`/proc/${Number(pid)}/stat`));
    const close = stat.lastIndexOf(')');
    if (!bootId || close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const starttime = fields[19]; // proc_pid_stat field 22, after the command name
    if (!/^\d+$/u.test(starttime || '')) return null;
    return { bootId, starttime };
  } catch { return null; }
}

export function linuxIdentityStatus(record, observed, alive) {
  if (!alive) return 'dead';
  if (!record?.bootId || !record?.starttime || !observed?.bootId || !observed?.starttime) return 'unknown';
  return record.bootId === observed.bootId && String(record.starttime) === String(observed.starttime) ? 'same' : 'stale';
}

/** Acquire the stable per-root flock inode, then run only a local sync transition. */
export async function withLifecycleLock(root, transition, { spawnProcess = spawn } = {}) {
  const lock = join(root, 'runner', 'lifecycle.lock');
  mkdirSync(dirname(lock), { recursive: true });
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess('/usr/bin/flock', ['--exclusive', '--timeout', '5', '--close', lock, '/bin/cat'], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let stdout = '';
    let stderr = '';
    let acquired = false;
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!acquired && stdout.includes('mc-lifecycle-ready\n')) {
        acquired = true;
        try {
          const value = transition();
          if (value && typeof value.then === 'function') throw new Error('Linux lifecycle transition must be synchronous');
          child.stdin.end();
          child.once('close', () => { if (!settled) { settled = true; resolve(value); } });
        } catch (error) {
          child.stdin.end();
          child.once('close', () => { if (!settled) { settled = true; reject(error); } });
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(`lifecycle lock acquisition failed${stderr.trim() ? `: ${stderr.trim()}` : ` (flock exit ${code ?? signal})`}`));
    });
    child.stdin.write('mc-lifecycle-ready\n');
  });
}

export function canonicalRoot(root) {
  try { return realpathSync(root); } catch { return resolve(root); }
}

export function rootIdentity(root) {
  const canonical = canonicalRoot(root);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  return { canonical, hash, unit: `mc-runner-boot-${hash}.service` };
}

// systemd's quoted-string syntax; percent specifiers and ExecStart variable
// expansion are escaped before any argument reaches the manager.
export function systemdQuote(value) {
  let out = '"';
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (char === '$') out += '$$';
    else if (char === '%') out += '%%';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

export function bootUnit({ root, execPath, entry, env = {} }) {
  const id = rootIdentity(root);
  const values = {
    HOME: env.HOME || homedir(),
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    MC_HOME: env.MC_HOME || join(env.HOME || homedir(), '.memoro', 'mc'),
    MC_WORK_ROOT: id.canonical,
    MC_REPOS_HOME: env.MC_REPOS_HOME || join(id.canonical, 'repos'),
  };
  const environment = Object.entries(values)
    .map(([key, value]) => `Environment=${key}=${systemdQuote(key === 'PATH' ? String(value).split(':').map((part) => resolve(part || '.')).join(':') : resolve(value))}`);
  const args = [resolve(execPath), resolve(entry), 'run', 'start', '--if-was-running'];
  return {
    ...id,
    text: [
      '[Unit]', 'Description=mc runner boot recovery', '',
      '[Service]', 'Type=oneshot', 'RemainAfterExit=yes', 'Restart=no', 'KillMode=control-group',
      `ExecStart=${args.map(systemdQuote).join(' ')}`,
      ...environment,
      '', '[Install]', 'WantedBy=default.target', '',
    ].join('\n'),
  };
}

export function realLinuxServiceDeps(env = process.env) {
  return {
    platform: process.platform,
    env,
    home: env.HOME || homedir(),
    canonicalRoot,
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    write: (path, text) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); },
    manager: (args) => {
      if (args[0] === 'show-user') return spawnSync('loginctl', args, { encoding: 'utf8', timeout: 5000 });
      return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 5000 });
    },
    username: env.USER || env.LOGNAME || '',
    uuid: randomUUID,
  };
}

export function installBootAdapter({ root, execPath, entry, deps = realLinuxServiceDeps() }) {
  const generated = bootUnit({ root: deps.canonicalRoot(root), execPath, entry, env: deps.env });
  const unitDir = join(deps.home, '.config', 'systemd', 'user');
  const unitPath = join(unitDir, generated.unit);
  const previous = deps.read(unitPath);
  const changed = previous !== generated.text;
  try {
    if (changed) deps.write(unitPath, generated.text);
    if (changed) {
      const reload = deps.manager(['daemon-reload']);
      if (!reload || reload.status !== 0) throw new Error(`systemctl --user daemon-reload failed${reload?.stderr ? `: ${reload.stderr.trim()}` : ''}`);
    }
    const enabled = deps.manager(['enable', generated.unit]);
    if (!enabled || enabled.status !== 0) throw new Error(`systemctl --user enable ${generated.unit} failed${enabled?.stderr ? `: ${enabled.stderr.trim()}` : ''}`);
    const linger = deps.manager(['show-user', deps.username, '--property=Linger', '--value']);
    if (!linger || linger.status !== 0) throw new Error(`could not determine login lingering${linger?.stderr ? `: ${linger.stderr.trim()}` : ''}`);
    const lines = [`boot adapter ${generated.unit} ${changed ? 'installed' : 'unchanged'} and enabled`];
    if (String(linger.stdout).trim() !== 'yes') lines.push('boot recovery is not ready: Linger=no; run interactively: loginctl enable-linger');
    else lines.push('boot recovery prerequisites hold (Linger=yes)');
    return { ok: true, changed, ready: String(linger.stdout).trim() === 'yes', unit: generated.unit, path: unitPath, lines };
  } catch (error) {
    return { ok: false, changed, ready: false, unit: generated.unit, path: unitPath, lines: [`could not install Linux boot adapter: ${error.message}`] };
  }
}

export function scopeCommand({ root, execPath, entry, argv, deps = realLinuxServiceDeps() }) {
  const id = rootIdentity(deps.canonicalRoot(root));
  const name = `mc-runner-start-${id.hash}-${deps.uuid().replaceAll('-', '').slice(0, 12)}.scope`;
  return ['--user', '--scope', `--unit=${name}`, '--expand-environment=no', `--setenv=${SYSTEMD_CONTEXT}=scope`, '--', resolve(execPath), resolve(entry), 'run', 'start', ...argv];
}
