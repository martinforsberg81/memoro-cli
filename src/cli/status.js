import { DEFAULT_TOOL } from '../lib/config.js';
import { resolveLocalSessionSync, sessionStatusSync } from '../mc/session-v1.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  // No name is not a mistake to correct — it is the more useful question.
  // `mc status` shows every piece of work and what each is doing; naming one
  // asks about a single pre-V1 session, which is what this command used to be
  // and all it could do.
  //
  // A number belongs to the flag before it, so it is not a name. Without this,
  // `mc status --watch 2` read the 2 as a session called "2" and answered with
  // the old command's usage line — and `--wait` and `--timeout` would each
  // have needed the same fix again.
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      if (/^\d+$/u.test(argv[index + 1] || '')) index += 1;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    const board = await import('../mc/commands/status-board.js');
    return board.run(argv, deps);
  }
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
