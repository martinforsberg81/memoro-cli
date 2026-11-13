/** Claude owns the provider lifetime; mc owns discovery and the bounded gateway grant. */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveLaunch } from '../adapters/index.js';
import { registerForeground } from './foreground.js';
import { deskSessions, readRegister, recordMatchesDesk, registerSession } from './session-entrance.js';
import { terminalEnvironment } from './interactive-terminal.js';
import { normalizeSessionRole, SESSION_IDENTITY_ENV } from './session-role.js';
import { workRoot, mcHome } from './paths.js';
import { pidAlive } from './status-collect.js';
import { openGatewayGrant } from './billing-gateway-session.js';
import { readBillingApi } from './billing.js';
import { log } from './logger.js';

const WORKER = fileURLToPath(import.meta.url);
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

/** A live session may have no transcript yet; its matching registration is launch evidence. */
export function findBackgroundConversation(options, prefix, {
  resolveTool = resolveLaunch, agents = readAgents, records = readRegister, alive = pidAlive, io = fs, register = registerForeground,
} = {}) {
  try {
    const launch = resolveTool('claude-code');
    if (!launch.ok) return null;
    const desk = { ...options, launch };
    const rows = reconcilePendingLaunches(desk, agents(launch, { env: options.env }), { io, alive, register });
    const matches = deskSessions(desk, rows, records(options.env), alive)
      .filter(session => session.sessionId?.startsWith(prefix));
    if (matches.length > 1) return { error: `ambiguous conversation prefix ${prefix}; use a longer id` };
    if (!matches.length) return null;
    return { conversation: { id: matches[0].sessionId, tool: launch.id },
      identity: { role: normalizeSessionRole(options.roleName || options.verb),
        programme: options.programme || null, source: 'live-background-register' } };
  } catch (error) { return { error: error.message || 'could not read Claude background agents or foreground registration for the named conversation' }; }
}

/** Only provider mechanics cross this boundary; desk policy stays in session-entrance. */
export function claudeBackgroundDriver({ agents = readAgents, start = startDetachedBackground, run = spawnSync,
  io = fs, alive = pidAlive, register = registerForeground,
} = {}) {
  return {
    list: options => reconcilePendingLaunches(options, agents(options.launch, { env: options.env }), { io, alive, register }),
    start,
    join: (options, session) => run(options.launch.spec.bin, ['attach', session.id], {
      cwd: options.worktree.path, stdio: 'inherit', env: terminalEnvironment(options.env),
    }),
  };
}

/** A launch intent survives an expired holder, but never counts as a live session. */
export function reconcilePendingLaunches(options, rows, { io = fs, alive = pidAlive, register = registerForeground } = {}) {
  const root = join(workRoot(options.env), 'runner', 'claude-background');
  let names;
  try { names = io.readdirSync(root); }
  catch (error) { if (error.code === 'ENOENT') return rows; throw error; }
  for (const name of names.filter(name => name.endsWith('.pending.json'))) {
    const path = join(root, name);
    let pending;
    try { pending = JSON.parse(io.readFileSync(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!pending?.record || !Array.isArray(pending.before)) throw new Error('could not read Claude pending launch identity');
    if (pending.cwd !== resolve(options.worktree.path) || !recordMatchesDesk(options, pending.record)) continue;
    const matches = rows.filter(row => !pending.before.includes(row.id) && row.name === pending.name && row.cwd === pending.cwd
      && Number.isInteger(row.pid) && row.pid > 0);
    if (matches.length !== 1) throw new Error(`Claude launch ${pending.name} is pending discovery; agents listed ${matches.length} matching provider rows. No second provider was started`);
    const session = matches[0];
    if (alive(session.pid)) {
      if (pending.openEvent) log('work.open', { ...pending.openEvent,
        launched_id: pending.openEvent.launched_id ? session.sessionId : null });
      registerSession(pending.record, session, { env: options.env, register });
    }
    // Like an outbox: discard the intent only after its observed provider is
    // registered (or observed dead). It is never authority to start again.
    io.unlinkSync(path);
  }
  return rows;
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
  register = registerForeground, alive = pidAlive, now = Date.now, sleep = delay,
  openGrant = openGatewayGrant, readApi = () => readBillingApi(), report = () => {}, releaseLock = () => {},
  recordOpen = fields => log('work.open', fields),
} = {}) {
  let grant;
  let session;
  let cleaned = false;
  let accepted = false;
  const pendingPath = `${request.directory}.pending.json`;
  const removePending = () => {
    try { io.unlinkSync(pendingPath); }
    catch (error) {
      if (error.code !== 'ENOENT') log('work.background-pending-retained', { path: pendingPath, error: error.code || 'unknown' });
    }
  };
  const cleanGrant = async () => {
    if (cleaned) return;
    cleaned = true;
    if (grant?.ok) await grant.close();
    io.rmSync(request.directory, { recursive: true, force: true });
  };
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
    // Persist only nonsecret launch identity, before the provider can exist.
    // Expiry must close the gateway, not erase the ability to recover its owner.
    io.writeFileSync(pendingPath, JSON.stringify({ name: request.name, cwd: request.cwd,
      before: [...before], record: { ...request.record, env: undefined }, openEvent: request.openEvent }), { mode: 0o600, flag: 'wx' });
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
    accepted = true;
    // --bg returns before agents necessarily publishes its row. Never invent a pid
    // from the short-lived launcher, and never start again after an uncertain read.
    for (let attempt = 0; !session; attempt += 1) {
      let observation = 'agents listed no new matching live session';
      try {
        session = agents(launch, { env, run }).find(row => !before.has(row.id)
          && row.name === request.name && row.cwd === request.cwd && Number.isInteger(row.pid) && row.pid > 0);
      } catch { observation = 'could not read Claude background agents'; }
      if (session) {
        if (!alive(session.pid)) return failure('Claude background provider exited before registration');
        break;
      }
      // A successful --bg may already own a conversation. Discovery failure is
      // not provider death: keep its grant and the inherited desk lock, then
      // reconcile in this holder even when the attaching client has left.
      if (attempt === 49) report(failure(`Claude launch returned, but ${observation}; the holder is still discovering it and keeps this desk locked. Retry the entrance after discovery recovers`));
      if (grant?.ok && now() >= Date.parse(grant.expiresAt)) return failure('Claude gateway grant expired before provider discovery; pending launch identity was retained for the next entrance');
      await sleep(attempt < 49 ? 100 : 1000);
    }
    // --bg assigns its own conversation id even when argv includes --session-id
    // (Claude 2.1.325). Historical provenance must name the observed transcript.
    if (request.openEvent) recordOpen({ ...request.openEvent,
      launched_id: request.openEvent.launched_id ? session.sessionId : null });
    registerSession(request.record, session, { env, register });
    removePending();
    releaseLock();
    report({ ok: true, session });
    while (alive(session.pid) && (!grant || now() < Date.parse(grant.expiresAt))) await sleep(1000);
    return { ok: true, session };
  } finally {
    // An unresolved accepted launch remains recoverable after the holder exits.
    if (!accepted || session) removePending();
    releaseLock();
    await cleanGrant();
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
