import { endLocalSession } from '../session-lifecycle-v1.js';
import { resolveLocalSessionSync } from '../session-v1.js';

export async function run(argv, deps = {}) {
  const io = streams(deps);
  const opts = parseArgs(argv);
  if (opts.error || !opts.name) return usage(io.stderr, opts.error || 'usage — mc end <session> [--json]');
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.name, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) return fail(io, opts, `session "${opts.name}" was not found`, resolved.reason);
  const result = await (deps.endSession || endLocalSession)({
    mcHomeDir: deps.mcHomeDir,
    session: resolved.session,
    deps: deps.lifecycleDeps || {},
  });
  if (!result.ok) return fail(io, opts, `could not end session "${opts.name}"`, result.reason, result);
  if (opts.json) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else io.stdout.write(`mc: ended ${result.name} (${result.mc_session_id}); workspaces and Git resources were kept\n`);
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

function fail(io, opts, message, reason, result = null) {
  if (opts.json) io.stdout.write(`${JSON.stringify(result || { ok: false, reason }, null, 2)}\n`);
  else io.stderr.write(`mc: ${message} (${reason || 'unknown'})\n`);
  return 1;
}

function usage(stderr, message) { stderr.write(`mc: ${message}\n`); return 2; }
function streams(deps) { return { stdout: deps.stdout || process.stdout, stderr: deps.stderr || process.stderr }; }
