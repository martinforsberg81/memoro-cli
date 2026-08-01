/** `mc dev` — machine-local dev-service inventory and verified controls. */
import {
  controlDevServer,
  listDevServers,
  readDevServerLog,
  registerDevServerManifest,
  resolveDevServer,
  summarizeDevServers,
  unregisterDevServerManifest,
} from '../mc/dev-servers.js';
import { resolveDevPlan } from '../mc/dev-definition.js';
import { ensureDevServer } from '../mc/dev-ensure.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }

  try {
    if (opts.verb === 'plan' || opts.verb === 'ensure') {
      const resolvePlan = deps.resolveDevPlan || resolveDevPlan;
      const plan = await resolvePlan({
        cwd: deps.cwd || process.cwd(),
        serviceName: opts.selector,
        profileName: opts.profile,
      });
      if (opts.verb === 'plan') {
        emitResult(plan, { json: opts.json, stdout }, () => printPlan(plan, stdout));
        return 0;
      }
      const ensure = deps.ensureDevServer || ensureDevServer;
      const result = await ensure(plan, {
        restart: opts.restart,
        ...(deps.ensureOptions || {}),
        deps: {
          ...(deps.ensureOptions?.deps || {}),
          onDependencyOutput: (_stream, chunk) => stderr.write(chunk),
        },
      });
      if (!result.ok) {
        if (opts.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else printEnsureFailure(result, stderr);
        return 1;
      }
      emitResult(result, { json: opts.json, stdout }, () => printEnsure(result, stdout));
      return 0;
    }
    if (opts.verb === 'register') {
      const register = deps.registerManifest || registerDevServerManifest;
      const registered = register(opts.selector);
      emitResult(registered, { json: opts.json, stdout }, () => {
        stdout.write(`registered ${registered.service} for ${registered.session_name} (${registered.instance_id})\n`);
      });
      return 0;
    }
    if (opts.verb === 'unregister') {
      const unregister = deps.unregisterManifest || unregisterDevServerManifest;
      const removed = unregister(opts.selector);
      const result = { removed, source_manifest_path: opts.selector };
      emitResult(result, { json: opts.json, stdout }, () => {
        stdout.write(removed ? 'unregistered dev server\n' : 'dev server was not registered\n');
      });
      return 0;
    }

    const list = deps.listDevServers || listDevServers;
    const servers = await list();
    if (opts.verb === 'list') {
      const result = { summary: summarizeDevServers(servers), servers };
      emitResult(result, { json: opts.json, stdout }, () => printList(result, stdout));
      return 0;
    }

    const resolved = resolveDevServer(servers, opts.selector);
    if (!resolved.server) {
      stderr.write(`mc: ${resolved.error}\n`);
      if (resolved.matches?.length) {
        for (const match of resolved.matches) {
          stderr.write(`  ${match.instance_id}  ${match.service}  ${match.url}\n`);
        }
      }
      return 1;
    }
    const server = resolved.server;

    if (opts.verb === 'status') {
      emitResult(server, { json: opts.json, stdout }, () => printStatus(server, stdout));
      return 0;
    }
    if (opts.verb === 'logs') {
      const readLog = deps.readLog || readDevServerLog;
      stdout.write(readLog(server, { lines: opts.lines }));
      return 0;
    }
    if (opts.verb === 'stop' || opts.verb === 'restart') {
      const control = deps.controlDevServer || controlDevServer;
      const result = await control(server, opts.verb);
      if (!result.ok) {
        stderr.write(`mc: ${result.error}\n`);
        if (result.stderr) stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
        return 1;
      }
      emitResult({ ...result, instance_id: server.instance_id }, { json: opts.json, stdout }, () => {
        stdout.write(`${opts.verb === 'stop' ? 'stopped' : 'restarted'} ${server.service} for ${server.session_name}\n`);
      });
      return 0;
    }
  } catch (error) {
    stderr.write(`mc: ${error?.message || String(error)}\n`);
    return 1;
  }

  stderr.write('mc: usage — `mc dev plan|ensure|list|status|logs|stop|restart ...`\n');
  return 2;
}

function parseArgs(argv) {
  const opts = {
    verb: null,
    selector: null,
    json: false,
    lines: 100,
    profile: null,
    restart: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--restart') { opts.restart = true; continue; }
    if (arg === '--lines') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 1_000) {
        return { error: '--lines must be an integer from 1 to 1000' };
      }
      opts.lines = value;
      continue;
    }
    if (arg === '--profile') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: '--profile requires a name' };
      opts.profile = value;
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown flag: ${arg}` };
    if (!opts.verb) { opts.verb = arg; continue; }
    if (!opts.selector) { opts.selector = arg; continue; }
    return { error: `unexpected arg: ${arg}` };
  }

  const valid = new Set(['plan', 'ensure', 'list', 'status', 'logs', 'stop', 'restart', 'register', 'unregister']);
  if (!valid.has(opts.verb)) return { error: `unknown or missing dev verb: ${opts.verb || '<missing>'}` };
  if (opts.verb === 'list' && opts.selector) return { error: 'mc dev list does not take a selector' };
  if (!['list', 'plan', 'ensure'].includes(opts.verb) && !opts.selector) return { error: `mc dev ${opts.verb} requires a selector` };
  if (opts.verb !== 'logs' && opts.lines !== 100) return { error: '--lines is only valid with mc dev logs' };
  if (!['plan', 'ensure'].includes(opts.verb) && opts.profile) return { error: '--profile is only valid with mc dev plan or ensure' };
  if (opts.verb !== 'ensure' && opts.restart) return { error: '--restart is only valid with mc dev ensure' };
  return opts;
}

function printEnsure(result, stdout) {
  stdout.write(`mc dev ensure — ${result.action} ${result.server.service}/${result.server.profile || 'legacy'}\n`);
  stdout.write(`  url           ${result.server.url}\n`);
  stdout.write(`  worktree      ${result.server.worktree_path}\n`);
  stdout.write(`  instance      ${result.server.instance_id}\n`);
  stdout.write(`  dependencies  ${result.dependencies?.action || 'unchanged'}\n`);
  if (result.resource_gate) {
    stdout.write(`  resources     ${result.resource_gate.resource_class}/${result.resource_gate.profile}\n`);
  }
}

function printEnsureFailure(result, stderr) {
  stderr.write(`mc: dev ensure refused (${result.reason || 'unknown'}): ${result.error || 'unknown error'}\n`);
  if (result.reason === 'server-plan-mismatch' || result.reason === 'server-not-ready') {
    stderr.write('mc: re-run with --restart only if replacing this verified worktree server is intended.\n');
  }
  if (result.dependencies?.hint) stderr.write(`mc: ${result.dependencies.hint}\n`);
  if (result.launch?.log_path) stderr.write(`mc: startup log: ${result.launch.log_path}\n`);
}

function printPlan(plan, stdout) {
  stdout.write(`mc dev plan — ${plan.service.name}/${plan.profile.name} (source=${plan.profile.source})\n`);
  stdout.write(`  start         ${renderArgv(plan.start.argv)}\n`);
  stdout.write(`  readiness     ${plan.readiness.kind} ${plan.readiness.path} (${plan.readiness.timeout_ms}ms)\n`);
  stdout.write(`  resource      ${plan.resource_class}\n`);
  stdout.write(`  dependencies  ${plan.dependencies.manager}: ${renderArgv(plan.dependencies.install.argv)}\n`);
  if (plan.dependency_mode) {
    stdout.write(`  deps mode     ${plan.dependency_mode.name} (source=${plan.dependency_mode.source})\n`);
  }
  stdout.write(`  definition    ${plan.definition_path} (${plan.definition_fingerprint})\n`);
  for (const warning of plan.warnings || []) {
    stdout.write(`  warning       ${warning.code}${warning.path ? ` (${warning.path})` : ''}\n`);
  }
}

function renderArgv(argv) {
  return argv.map((arg) => (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", "'\\''")}'`)).join(' ');
}

function printList({ summary, servers }, stdout) {
  stdout.write(`mc dev — ${summary.total} server${summary.total === 1 ? '' : 's'}\n`);
  if (!servers.length) {
    stdout.write('  no registered dev servers\n');
    return;
  }
  for (const server of servers) {
    const profile = server.profile ? `/${server.profile}` : '';
    stdout.write(`  ${server.state.padEnd(9)} ${server.session_name}/${server.service}${profile}  ${server.url}  pid=${server.pid}  age=${formatAge(server.age_seconds)}  health=${server.health?.status || 'unknown'}\n`);
    stdout.write(`             worktree=${server.worktree_path}  log=${server.log_path}\n`);
  }
}

function printStatus(server, stdout) {
  stdout.write(`${server.session_name}/${server.service}${server.profile ? `/${server.profile}` : ''}  ${server.state}\n`);
  stdout.write(`  instance    ${server.instance_id}\n`);
  stdout.write(`  url         ${server.url}\n`);
  stdout.write(`  pid / pgid  ${server.pid} / ${server.process_group_id}\n`);
  stdout.write(`  identity    ${server.identity?.status || 'unknown'}${server.identity?.reason ? ` (${server.identity.reason})` : ''}\n`);
  stdout.write(`  health      ${server.health?.status || 'unknown'}${server.health?.error ? ` (${server.health.error})` : ''}\n`);
  if (server.definition_fingerprint) stdout.write(`  definition  ${server.definition_fingerprint}\n`);
  if (server.start_argv) stdout.write(`  start argv  ${renderArgv(server.start_argv)}\n`);
  stdout.write(`  age         ${formatAge(server.age_seconds)}\n`);
  stdout.write(`  worktree    ${server.worktree_path}\n`);
  stdout.write(`  log         ${server.log_path}\n`);
}

function emitResult(value, { json, stdout }, printHuman) {
  if (json) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else printHuman();
}

function formatAge(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m`;
  return `${Math.floor(n / 3600)}h`;
}
