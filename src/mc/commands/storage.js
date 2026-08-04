import {
  inspectSessionRuntimeArtifactsSync,
  repairSessionMaintenanceSync,
  scanSessionMaintenanceSync,
} from '../session-maintenance-v1.js';
import { planSessionOwnedResourceCleanupSync } from '../owned-resource-cleanup.js';
import { resolveLocalSessionSync } from '../session-v1.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) { stderr.write(`mc: ${opts.error}\n`); return 2; }
  let result;
  if (opts.command === 'status') {
    result = (deps.scan || scanSessionMaintenanceSync)({ mcHomeDir: deps.mcHomeDir });
  } else if (opts.command === 'repair') {
    result = (deps.repair || repairSessionMaintenanceSync)({
      mcHomeDir: deps.mcHomeDir,
      apply: opts.apply,
    });
  } else {
    const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.name, {
      mcHomeDir: deps.mcHomeDir,
    });
    if (!resolved.ok) { stderr.write(`mc: session was not found (${resolved.reason})\n`); return 1; }
    const runtimeArtifacts = (deps.inspectRuntimeArtifacts || inspectSessionRuntimeArtifactsSync)({
      mcHomeDir: deps.mcHomeDir,
      mcSessionId: resolved.session.mc_session_id,
    });
    const ownedResources = (deps.planCleanup || planSessionOwnedResourceCleanupSync)({
      mcHomeDir: deps.mcHomeDir,
      mcSessionId: resolved.session.mc_session_id,
    });
    result = {
      ok: runtimeArtifacts.state !== 'unsafe' && ownedResources.ok,
      mc_session_id: resolved.session.mc_session_id,
      name: resolved.session.metadata.name,
      lifecycle: resolved.session.projection.lifecycle,
      runtime_artifacts: runtimeArtifacts,
      owned_resources: ownedResources,
    };
  }
  if (opts.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else renderHuman(opts, result, stdout);
  return result.ok ? 0 : 1;
}

export function parseArgs(argv) {
  const opts = { command: 'status', name: null, apply: false, json: false };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('--')) opts.command = args.shift();
  if (!['status', 'explain', 'repair'].includes(opts.command)) return { ...opts, error: `unknown storage command: ${opts.command}` };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--apply' && opts.command === 'repair') { opts.apply = true; continue; }
    if (arg === '--dry-run' && opts.command === 'repair') { opts.apply = false; continue; }
    if (!arg.startsWith('--') && opts.command === 'explain' && !opts.name) { opts.name = arg; continue; }
    return { ...opts, error: `unexpected arg: ${arg}` };
  }
  if (opts.command === 'explain' && !opts.name) return { ...opts, error: 'usage — mc storage explain <session> [--json]' };
  return opts;
}

function renderHuman(opts, result, stdout) {
  if (opts.command === 'explain') {
    stdout.write(`${result.name}  ${result.mc_session_id}\n`);
    stdout.write(`  lifecycle         ${result.lifecycle}\n`);
    stdout.write(`  runtime artifacts ${result.runtime_artifacts.state}\n`);
    stdout.write(`  owned resources   ${result.owned_resources.plans.length}\n`);
    return;
  }
  stdout.write(`mc storage ${opts.command} — ${result.ok ? 'ok' : 'issues found'}${result.applied ? ' · applied' : ''}\n`);
  stdout.write(`  sessions ${result.summary.sessions} · archived ${result.summary.archived}\n`);
  stdout.write(`  active runtime homes ${result.summary.runtime_active} · stale ${result.summary.runtime_stale}\n`);
}
