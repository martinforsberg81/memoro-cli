import { resolveLocalSessionSync } from '../mc/session-v1.js';
import { readLocalSessionScreen } from '../runtime/session-host/terminal-client.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.identifier) {
    stderr.write(`mc: ${opts.error || 'usage — mc read <local-session> [--last N] [--json]'}\n`);
    return 2;
  }
  if (opts.identifier.startsWith('cloud:')) {
    stderr.write('mc: cloud terminal read is unavailable on the V1 control-plane transport\n');
    return 1;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.identifier, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) {
    stderr.write(`mc: local session "${opts.identifier}" was not found (${resolved.reason})\n`);
    return 1;
  }
  const result = await (deps.readScreen || readLocalSessionScreen)({
    mcHomeDir: deps.mcHomeDir,
    mcSessionId: resolved.session.mc_session_id,
    last: opts.last,
  });
  if (!result.ok) {
    stderr.write(`mc: could not read "${resolved.session.metadata.name}" (${result.reason})\n`);
    return 1;
  }
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      ok: true,
      source_kind: 'local',
      name: resolved.session.metadata.name,
      mc_session_id: result.mc_session_id,
      generation_id: result.generation_id,
      text: result.text,
    }, null, 2)}\n`);
  } else {
    stdout.write(result.text);
    if (result.text && !result.text.endsWith('\n')) stdout.write('\n');
  }
  return 0;
}

export function parseArgs(argv) {
  const opts = { identifier: null, last: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--last') {
      const value = argv[++index];
      if (!/^[1-9]\d*$/u.test(value || '')) return { ...opts, error: '--last requires a positive integer' };
      opts.last = Number(value);
      continue;
    }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.identifier) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.identifier = arg;
  }
  return opts;
}
