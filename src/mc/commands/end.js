import { applySessionOwnedResourceCleanupSync } from '../owned-resource-cleanup.js';
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
  // Ending a session now releases what mc made for it: the worktree it
  // created, the branch it created, nothing else. The rule that made this
  // safe is unchanged — only a resource with a creation receipt proving mc
  // made it is touched, and each target is revalidated at the moment of
  // removal. A repository you brought, a branch you made, a directory you
  // chose: still yours, still there.
  const cleanup = (deps.cleanupResources || applySessionOwnedResourceCleanupSync)({
    mcHomeDir: deps.mcHomeDir,
    mcSessionId: resolved.session.mc_session_id,
    deps: deps.cleanupDeps || {},
  });
  const removed = (cleanup.results || []).filter((item) => item.ok && item.action !== 'unchanged');
  const blocked = (cleanup.results || []).filter((item) => !item.ok);
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
  } else {
    io.stdout.write(`mc: ended ${result.name} (${result.mc_session_id})\n`);
    if (removed.length) {
      io.stdout.write(`mc: removed ${removed.length} resource${removed.length === 1 ? '' : 's'} mc created for it\n`);
    }
    for (const item of blocked) {
      io.stderr.write(`mc: kept ${item.resource_id || 'a resource'} (${item.reason || 'unsafe to remove'})\n`);
    }
  }
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
