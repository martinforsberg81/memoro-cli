import { resolveLocalSessionSync } from '../mc/session-v1.js';
import { sendLocalSessionInput } from '../runtime/session-host/terminal-client.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || opts.identifiers.length === 0 || !opts.message) {
    stderr.write(`mc: ${opts.error || 'usage — mc dispatch <session> <message>'}\n`);
    return 2;
  }
  const results = [];
  for (const identifier of opts.identifiers) {
    if (identifier.startsWith('cloud:')) {
      results.push({ identifier, ok: false, reason: 'cloud-v1-terminal-transport-unavailable' });
      continue;
    }
    const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(identifier, {
      mcHomeDir: deps.mcHomeDir,
    });
    if (!resolved.ok) {
      results.push({ identifier, ok: false, reason: resolved.reason });
      continue;
    }
    const sent = await (deps.sendInput || sendLocalSessionInput)({
      mcHomeDir: deps.mcHomeDir,
      mcSessionId: resolved.session.mc_session_id,
      message: opts.message,
      tool: resolved.session.projection.tool,
    });
    results.push({
      identifier,
      name: resolved.session.metadata.name,
      mc_session_id: resolved.session.mc_session_id,
      ...sent,
    });
  }
  const ok = results.every((result) => result.ok);
  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok, message: opts.message, results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      if (result.ok) stdout.write(`✓ dispatched to ${result.name} (${result.mc_session_id})\n`);
      else stderr.write(`mc: dispatch to ${result.identifier} failed (${result.reason})\n`);
    }
  }
  return ok ? 0 : 1;
}

export function parseArgs(argv) {
  const opts = { identifiers: [], message: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--message') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) return { ...opts, error: '--message requires text' };
      opts.message = value;
      continue;
    }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    opts.identifiers.push(arg);
  }
  if (!opts.message && opts.identifiers.length >= 2) {
    opts.message = opts.identifiers.pop();
  }
  return opts;
}
