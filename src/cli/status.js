import { DEFAULT_TOOL } from '../lib/config.js';
import { resolveLocalSessionSync, sessionStatusSync } from '../mc/session-v1.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.name) {
    stderr.write(`mc: ${opts.error || 'usage — mc status <name> [--json]'}\n`);
    return 2;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.name, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) {
    stderr.write(`mc: session "${opts.name}" was not found (${resolved.reason})\n`);
    return 1;
  }
  const status = (deps.sessionStatus || sessionStatusSync)(resolved.session, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (opts.json) {
    stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  stdout.write(`${status.name}  ${status.mc_session_id}\n`);
  stdout.write(`  source       local:${status.source_id}\n`);
  stdout.write(`  lifecycle    ${status.lifecycle}\n`);
  stdout.write(`  runtime      ${status.runtime_state}\n`);
  stdout.write(`  tool         ${status.tool || DEFAULT_TOOL}\n`);
  stdout.write(`  workspace    ${status.workspace_path || '—'}\n`);
  stdout.write(`  associations ${status.workspace_count}\n`);
  if (status.objective) stdout.write(`  objective    ${status.objective}\n`);
  if (status.issues.length > 0) stdout.write(`  issues       ${status.issues.length}\n`);
  return 0;
}

export function parseArgs(argv) {
  const opts = { name: null, json: false };
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.name) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.name = arg;
  }
  return opts;
}
