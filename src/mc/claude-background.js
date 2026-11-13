/** Claude owns the provider lifetime; mc owns discovery and the bounded gateway grant. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveLaunch, isSameTool } from '../adapters/index.js';
import { foregroundDir, registerForeground } from './foreground.js';
import { liveTerminalOwners, terminalEnvironment } from './interactive-terminal.js';
import { normalizeSessionRole, SESSION_IDENTITY_ENV } from './session-role.js';
import { workRoot, mcHome } from './paths.js';
import { pidAlive } from './status-collect.js';
import { select } from './prompt.js';
import { openGatewayGrant } from './billing-gateway-session.js';
import { readBillingApi } from './billing.js';
import { log } from './logger.js';

const WORKER = fileURLToPath(import.meta.url);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const failure = reason => ({ ok: false, reason });

export function readAgents(launch, { run = spawnSync, env = process.env } = {}) {
  const result = run(launch.spec.bin, ['agents', '--json'], { env: terminalEnvironment(env), encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('could not read Claude background agents');
  try {
    const rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows)) throw new Error();
    return rows;
  } catch { throw new Error('could not read Claude background agents: expected a JSON array'); }
}

export function readRegister(env, io = fs) {
  const dir = foregroundDir(env);
  let names;
  try { names = io.readdirSync(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => /^\d+\.json$/u.test(name)).flatMap(name => {
    try { return [JSON.parse(io.readFileSync(join(dir, name), 'utf8'))]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}

/** Both sources must agree: neither a stale record nor an unrelated daemon session is this desk. */
export function deskSessions(options, agents, records, alive = pidAlive) {
  const role = normalizeSessionRole(options.roleName || options.verb);
  return agents.flatMap(agent => {
    const record = records.find(item => item.pid === agent.pid && item.tool === 'claude'
      && normalizeSessionRole(item.role?.name || item.verb) === role
      && (item.programme || null) === (options.programme || null)
      && (item.area || null) === (options.areaName || null));
    return record && typeof agent.id === 'string' && agent.id && agent.cwd === resolve(options.worktree.path) && alive(agent.pid)
      ? [{ ...agent, started: record.started }] : [];
  });
}

/** A live session may have no transcript yet; its matching registration is launch evidence. */
export function findBackgroundConversation(options, prefix, {
  resolveTool = resolveLaunch, agents = readAgents, records = readRegister, alive = pidAlive,
} = {}) {
  try {
    const launch = resolveTool('claude-code');
    if (!launch.ok) return null;
    const matches = deskSessions(options, agents(launch, { env: options.env }), records(options.env), alive)
      .filter(session => session.sessionId?.startsWith(prefix));
    if (matches.length > 1) return { error: `ambiguous conversation prefix ${prefix}; use a longer id` };
    if (!matches.length) return null;
    return { conversation: { id: matches[0].sessionId, tool: launch.id },
      identity: { role: normalizeSessionRole(options.roleName || options.verb),
        programme: options.programme || null, source: 'live-background-register' } };
  } catch { return { error: 'could not read Claude background agents or foreground registration for the named conversation' }; }
}

export function backgroundName(options, sessions) {
  const base = `mc ${normalizeSessionRole(options.roleName || options.verb)}${options.programme ? ` ${options.programme}` : ''}`;
  const names = new Set(sessions.map(item => item.name));
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

/** Serialise selection through registration, not attachment: two entrances must not resume one transcript. */
export async function lockDesk(options, { io = fs, spawnProcess = spawn } = {}) {
  const root = join(workRoot(options.env), 'runner', 'claude-background');
  io.mkdirSync(root, { recursive: true, mode: 0o700 });
  const desk = [resolve(workRoot(options.env)), resolve(options.areaRoot),
    normalizeSessionRole(options.roleName || options.verb), options.programme || null];
  const lock = join(root, `${createHash('sha256').update(JSON.stringify(desk)).digest('hex')}.lock`);
  // The Linux runner uses the same pipe-owned flock pattern. An interrupted
  // selector closes its pipe, releasing the kernel lock without stale-pid reaping.
  const child = spawnProcess('/usr/bin/flock', ['--exclusive', '--nonblock', '--close', lock, '/bin/cat'], {
    env: terminalEnvironment(options.env), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let closed = false;
  const ended = new Promise(resolveEnd => child.once('close', () => { closed = true; resolveEnd(); }));
  return await new Promise((resolveLock, reject) => {
    let ready = false;
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (ready || !output.includes('mc-background-ready\n')) return;
      ready = true;
      let released = false;
      const release = async () => {
        if (!released) { released = true; child.stdin.end(); }
        await ended;
      };
      release.pipe = child.stdin;
      resolveLock(release);
    });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new Error('could not start the Claude background desk lock')));
    child.once('close', code => {
      if (!ready) reject(new Error(code === 1
        ? 'another entrance is selecting a Claude background session for this desk; retry the entrance'
        : `Claude background desk lock exited before acquisition (status ${code ?? 'unknown'})`));
    });
    if (!closed) child.stdin.write('mc-background-ready\n');
  });
}

export function attachClaudeBackground(options, session, { run = spawnSync, agents = readAgents,
  alive = pidAlive, stdout = options.stdout || process.stdout } = {}) {
  const result = run(options.launch.spec.bin, ['attach', session.id], {
    cwd: options.worktree.path, stdio: 'inherit', env: terminalEnvironment(options.env),
  });
  let running;
  try { running = agents(options.launch, { env: options.env }).some(row => row.id === session.id && row.pid === session.pid && alive(row.pid)); }
  catch {
    stdout.write(`mc: could not read Claude background agents after attach; rejoin with mc ${options.verb}${options.programme ? ` ${options.programme}` : ''}.\n`);
    return failure('could not read Claude background agents after attach');
  }
  stdout.write(`mc: ${session.name} ${running ? 'is still running' : 'has ended'}; ${running ? 'rejoin' : 'open again'} with mc ${options.verb}${options.programme ? ` ${options.programme}` : ''}.\n`);
  log('work.closed', { area: options.areaRoot, tool: options.launch.id, exit_code: result.status ?? 0,
    resumed: options.chosen?.id || (options.joining ? session.sessionId : null),
    started: options.starting && !options.chosen ? session.sessionId : null,
    kept_nothing: false, background_id: session.id, running });
  return result.error ? failure(`could not attach to ${session.name}: ${result.error.message}`)
    : { ok: true, code: result.status ?? 0, background: session.id, conversation: session.sessionId, running,
      resumed: Boolean(options.joining || options.chosen),
      started: options.starting && !options.chosen ? session.sessionId : null, kept_nothing: false };
}

/** Selection stays in the caller's terminal; the detached holder starts and registers the provider. */
export async function prepareClaudeBackground(options, {
  agents = readAgents, records = readRegister, alive = pidAlive, owners = liveTerminalOwners,
  lock = lockDesk, choose = options.choose || select, start = startDetachedBackground,
  attach = attachClaudeBackground,
} = {}) {
  let release;
  try {
    release = await lock(options);
    const rows = agents(options.launch, { env: options.env });
    const sessions = deskSessions(options, rows, records(options.env), alive);
    const old = owners(options).filter(pid => !sessions.some(session => session.pid === pid));
    if (old.length) return { result: failure(`this desk has a live process outside Claude background registration (PID ${old.join(', ')}); return to its terminal. No second provider was started`), release };
    const held = new Set(rows.filter(row => row.cwd === resolve(options.worktree.path) && alive(row.pid)).map(row => row.sessionId).filter(Boolean));
    let selected = options.chosen && sessions.find(session => session.sessionId === options.chosen.id);
    if (!options.chosen && options.pick !== 'new' && sessions.length) {
      const id = choose('join a Claude background session, or start a new one?', [
        ...sessions.map((session, index) => ({ key: index + 1, value: session.id, name: session.name,
          label: `${session.name}  started ${session.started}` })),
        { key: sessions.length + 1, value: 'new', name: 'start a new one', label: 'start a new one' },
      ], { stdout: options.stdout || process.stdout });
      if (!id) return { result: { ok: true, code: 0, cancelled: true }, release };
      selected = sessions.find(session => session.id === id);
      if (id !== 'new' && !selected) return { result: failure('the selected Claude background session was not listed'), release };
    }
    if (selected) {
      if (options.model || (options.resumeTool && !isSameTool(options.resumeTool, options.launch.id))) {
        return { result: failure('joining an existing Claude background session cannot apply --model or a different --tool; start a new one to apply them'), release };
      }
      await release();
      return { result: attach({ ...options, joining: true }, selected), release };
    }
    if (options.chosen && held.has(options.chosen.id)) return { result: failure('this conversation is held by a Claude background process without matching desk registration; no second provider was started'), release };
    return { held, release, start: async plan => {
      const launched = await start({ ...options, lockPipe: release.pipe }, plan, backgroundName(options, sessions));
      await release();
      if (!launched.ok) {
        log('work.open-failed', { area: options.areaRoot, error: launched.reason });
        return launched;
      }
      return attach({ ...options, chosen: plan.chosen, starting: true }, launched.session);
    } };
  } catch (error) {
    await release?.();
    return { result: failure(error.message) };
  }
}

/** Collapse adapter settings and identity into the only settings document handed to the daemon. */
export function backgroundSettings(args, identity, env) {
  const rest = [];
  const settings = { env: {} };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--settings') { rest.push(args[i]); continue; }
    if (!rest.includes('--settings')) rest.push('--settings', '');
    const document = JSON.parse(args[++i]);
    Object.assign(settings, { ...document, env: { ...settings.env, ...document.env } });
  }
  Object.assign(settings.env, Object.fromEntries(SESSION_IDENTITY_ENV.map(key => [key, identity[key] || ''])),
    { MC_HOME: mcHome(env), MC_WORK_ROOT: workRoot(env) });
  return { args: rest, settings };
}

export async function startDetachedBackground(options, plan, name, { io = fs, fork = spawn, readApi = () => readBillingApi() } = {}) {
  if (plan.billing.billing === 'unavailable') return failure(`Claude billing unavailable: ${plan.billing.why}`);
  if (plan.billing.billing === 'credits' && readApi()?.claude === false) return failure('Claude API is off; no holder or session was started');
  const root = join(workRoot(options.env), 'runner', 'claude-background');
  io.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = io.mkdtempSync(join(root, 'session-'));
  io.chmodSync(directory, 0o700);
  const request = join(directory, 'request.json');
  const document = backgroundSettings(plan.args, plan.identity, options.env);
  io.writeFileSync(request, JSON.stringify({ name, cwd: options.worktree.path,
    billing: plan.billing, openEvent: plan.openEvent, record: { ...plan.record, env: undefined }, ...document }), { mode: 0o600, flag: 'wx' });
  const child = fork(process.execPath, [WORKER, request, ...(options.lockPipe ? ['--desk-lock-pipe'] : [])], {
    cwd: options.worktree.path, env: terminalEnvironment(options.env), detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', ...(options.lockPipe ? [options.lockPipe] : [])],
  });
  return await new Promise(resolveResult => {
    let answered = false;
    const finish = result => {
      if (answered) return;
      answered = true;
      if (child.connected) child.disconnect();
      child.unref();
      resolveResult(result);
    };
    child.once('message', finish);
    child.once('error', () => { io.rmSync(directory, { recursive: true, force: true }); finish(failure('could not start the Claude background holder')); });
    child.once('exit', () => finish(failure('Claude background holder exited before reporting a session')));
  });
}

/** Runs in the trusted detached process, never in the attaching client. */
export async function holdClaudeBackground(request, {
  env = process.env, io = fs, resolveTool = resolveLaunch, run = spawnSync, agents = readAgents,
  register = registerForeground, alive = pidAlive, now = Date.now, sleep = delay, pause = wait,
  openGrant = openGatewayGrant, readApi = () => readBillingApi(), report = () => {}, releaseLock = () => {},
  recordOpen = fields => log('work.open', fields),
} = {}) {
  let grant;
  let session;
  try {
    const launch = resolveTool('claude-code');
    if (!launch.ok) return failure(`could not resolve Claude background executable: ${launch.reason}`);
    if (request.billing.billing === 'unavailable') return failure(`Claude billing unavailable: ${request.billing.why}`);
    if (request.billing.billing === 'credits') {
      grant = await openGrant({ provider: 'claude', model: '*', readApi, now });
      if (!grant.ok) return failure('Claude API reserve could not open a gateway grant (API off or key unreadable)');
      Object.assign(request.settings.env, { ANTHROPIC_BASE_URL: `${grant.base}/claude`, ANTHROPIC_AUTH_TOKEN: grant.grant });
    }
    const settingsPath = join(request.directory, 'settings.json');
    io.writeFileSync(settingsPath, JSON.stringify(request.settings), { mode: 0o600, flag: 'wx' });
    const before = new Set(agents(launch, { env, run }).map(row => row.id));
    const args = [...request.args];
    const settingsIndex = args.indexOf('--settings');
    if (settingsIndex < 0) args.unshift('--settings', settingsPath);
    else args[settingsIndex + 1] = settingsPath;
    const launched = run(launch.spec.bin, ['--bg', '--name', request.name, ...args], {
      cwd: request.cwd, env: terminalEnvironment(env), encoding: 'utf8',
    });
    if (launched.error || launched.status !== 0) {
      if (String(launched.stderr || '').includes('Workspace not trusted')) {
        return failure('Claude refused background launch because this workspace is not trusted; open this directory in Claude Code once, accept its trust prompt, then retry the entrance');
      }
      return failure(`Claude background launch did not exit successfully (status ${launched.status ?? 'unknown'}); no session was registered`);
    }
    // --bg returns before agents necessarily publishes its row. Never invent a pid
    // from the short-lived launcher, and never start again after an uncertain read.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      session = agents(launch, { env, run }).find(row => !before.has(row.id)
        && row.name === request.name && row.cwd === request.cwd && alive(row.pid));
      if (session) break;
      pause(100);
    }
    if (!session) return failure('Claude launch returned, but agents listed no new matching session; retry discovery before starting another');
    // --bg assigns its own conversation id even when argv includes --session-id
    // (Claude 2.1.325). Historical provenance must name the observed transcript.
    if (request.openEvent) recordOpen({ ...request.openEvent,
      launched_id: request.openEvent.launched_id ? session.sessionId : null });
    register({ ...request.record, pid: session.pid, env, onExit: () => {} });
    releaseLock();
    report({ ok: true, session });
    while (alive(session.pid) && (!grant || now() < Date.parse(grant.expiresAt))) await sleep(1000);
    return { ok: true, session };
  } finally {
    releaseLock();
    if (grant?.ok) await grant.close();
    io.rmSync(request.directory, { recursive: true, force: true });
  }
}

/** A vanished attaching client cannot take the trusted holder down with an IPC error. */
export function notifyBackgroundClient(result, {
  connected = () => process.connected, send = (message, callback) => process.send(message, callback),
} = {}) {
  if (!connected()) return;
  try { send(result, () => {}); }
  catch (error) { if (error.code !== 'ERR_IPC_CHANNEL_CLOSED') throw error; }
}

if (process.argv[1] === WORKER) {
  const path = process.argv[2];
  let reported = false;
  let ownsLockPipe = process.argv[3] === '--desk-lock-pipe';
  const releaseLock = () => {
    if (ownsLockPipe) { ownsLockPipe = false; fs.closeSync(4); }
  };
  const report = result => { reported = true; notifyBackgroundClient(result); };
  try {
    const request = JSON.parse(fs.readFileSync(path, 'utf8'));
    fs.unlinkSync(path);
    const result = await holdClaudeBackground({ ...request, directory: dirname(path) }, { report, releaseLock });
    if (!reported) report(result);
  } catch { if (!reported) report(failure('Claude background holder failed before reporting a session')); }
  finally { releaseLock(); }
}
