import { resolveLocalSessionSync } from '../mc/session-v1.js';
import { attachLocalSessionTerminal } from '../runtime/session-host/terminal-client.js';

export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.identifier) {
    stderr.write(`mc: ${opts.error || 'usage — mc attach <local-session>'}\n`);
    return 2;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.identifier, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) {
    stderr.write(`mc: local session "${opts.identifier}" was not found (${resolved.reason})\n`);
    return 1;
  }
  const result = await (deps.attachTerminal || attachLocalSessionTerminal)({
    mcHomeDir: deps.mcHomeDir,
    mcSessionId: resolved.session.mc_session_id,
    stdin: deps.stdin || process.stdin,
    stdout: deps.stdout || process.stdout,
    stderr,
  });
  return result.code;
}

export function parseArgs(argv) {
  const opts = { identifier: null };
  for (const arg of argv) {
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.identifier) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.identifier = arg;
  }
  return opts;
}
