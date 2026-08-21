import { repairSessionMaintenanceSync, scanSessionMaintenanceSync } from '../session-maintenance-v1.js';
import { inspectV1DevServerRegistrySync } from '../dev-servers.js';

/**
 * The diagnosis itself, without a page around it.
 *
 * `mc watch pm` runs this every pass (designnote §3, step 2) and carries a
 * complaint into its knock. It calls the function rather than the command on
 * purpose: a round that shells out to `mc doctor` would be a second process
 * and a second parse of the same answer, and the two could drift the day one
 * of them learns something the other has not. The command below is this plus
 * rendering.
 */
export function diagnose({ repair = false, deps = {} } = {}) {
  const maintenance = repair
    ? (deps.repair || repairSessionMaintenanceSync)({ mcHomeDir: deps.mcHomeDir, apply: true })
    : (deps.scan || scanSessionMaintenanceSync)({ mcHomeDir: deps.mcHomeDir });
  const devServers = (deps.inspectDevServers || inspectV1DevServerRegistrySync)({
    mcHomeDir: deps.mcHomeDir,
    deps: deps.devServerDeps || {},
  });
  return {
    ...maintenance,
    ok: maintenance.ok && devServers.ok,
    summary: { ...maintenance.summary, dev_servers: devServers.summary },
    issues: [...maintenance.issues, ...devServers.issues],
    dev_servers: devServers,
  };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) { stderr.write(`mc: ${opts.error}\n`); return 2; }
  const result = diagnose({ repair: opts.repair, deps });
  if (opts.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    stdout.write(`mc doctor — ${result.ok ? 'ok' : 'issues found'}${opts.repair ? ' · applied safe repairs' : ''}\n`);
    stdout.write(`  sessions ${result.summary.sessions} · runtime active ${result.summary.runtime_active} · stale ${result.summary.runtime_stale}\n`);
    for (const issue of result.issues) stdout.write(`  ! ${issue.scope || 'session'}  ${issue.mc_session_id || issue.entry || ''}  ${issue.reason}\n`);
    if (!opts.repair && result.issues.length > 0) stdout.write('  Run mc doctor --repair to apply loss-free catalog and stale-runtime repairs.\n');
  }
  return result.ok ? 0 : 1;
}

export function parseArgs(argv) {
  const opts = { repair: false, json: false };
  for (const arg of argv) {
    if (arg === '--repair') { opts.repair = true; continue; }
    if (arg === '--dry-run') { opts.repair = false; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    return { ...opts, error: `unknown flag: ${arg}` };
  }
  return opts;
}
