import { deleteLocalSession } from '../session-lifecycle-v1.js';
import { resolveLocalSessionSync } from '../session-v1.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.name || !opts.force) {
    stderr.write(`mc: ${opts.error || 'usage — mc delete <session> --force [--json]'}\n`);
    return 2;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.name, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) return emitFailure({ stdout, stderr, opts, reason: resolved.reason });
  const result = (deps.deleteSession || deleteLocalSession)({
    mcHomeDir: deps.mcHomeDir,
    session: resolved.session,
    deps: deps.lifecycleDeps || {},
  });
  if (!result.ok) return emitFailure({ stdout, stderr, opts, reason: result.reason, result });
  if (opts.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`mc: deleted session ${result.name} (${result.mc_session_id})\n`);
  return 0;
}

export function parseArgs(argv) {
  const opts = { name: null, force: false, json: false };
  for (const arg of argv) {
    if (arg === '--force') { opts.force = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.name) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.name = arg;
  }
  return opts;
}

function emitFailure({ stdout, stderr, opts, reason, result = null }) {
  if (opts.json) stdout.write(`${JSON.stringify(result || { ok: false, reason }, null, 2)}\n`);
  else stderr.write(`mc: session was not deleted (${reason || 'unknown'})\n`);
  return 1;
}
