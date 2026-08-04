import { repairSessionMaintenanceSync } from '../session-maintenance-v1.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) { stderr.write(`mc: ${opts.error}\n`); return 2; }
  const result = (deps.maintain || repairSessionMaintenanceSync)({
    mcHomeDir: deps.mcHomeDir,
    apply: opts.apply,
    ...(deps.processIsAlive ? { processIsAlive: deps.processIsAlive } : {}),
  });
  if (opts.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else renderHuman(result, stdout);
  return result.ok ? 0 : 1;
}

export function parseArgs(argv) {
  const opts = { apply: false, json: false };
  for (const arg of argv) {
    if (arg === '--apply') { opts.apply = true; continue; }
    if (arg === '--dry-run') { opts.apply = false; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    return { ...opts, error: `unknown flag: ${arg}` };
  }
  return opts;
}

function renderHuman(result, stdout) {
  stdout.write(`mc gc — ${result.applied ? 'applied' : 'dry run'}\n`);
  stdout.write(`  sessions ${result.summary.sessions} · stale runtime homes ${result.summary.runtime_stale}\n`);
  for (const action of result.actions || []) {
    stdout.write(`  ${action.safe ? 'safe' : 'blocked'}  ${action.action}  ${action.mc_session_id || action.normalized_name || ''}\n`);
  }
  if (!result.applied) stdout.write('  No Git branch, worktree, or workspace is removed by mc gc.\n');
}
