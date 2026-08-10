import { renameSessionHomeSync } from '../mc/session-home.js';
import { resolveLocalSessionSync } from '../mc/session-v1.js';
import { reservedRoleHint, reservedRoleName } from '../mc/roles.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.oldName || !opts.newName) {
    stderr.write(`mc: ${opts.error || 'usage — mc rename <old> <new>'}\n`);
    return 2;
  }
  // Renaming into a role name is `mc new pm` through a side door.
  if (reservedRoleName(opts.newName)) {
    stderr.write(`mc: ${reservedRoleHint(opts.newName)}\n`);
    return 1;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.oldName, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) {
    stderr.write(`mc: session "${opts.oldName}" was not found (${resolved.reason})\n`);
    return 1;
  }
  let renamed;
  try {
    renamed = (deps.renameSession || renameSessionHomeSync)({
      mcHomeDir: deps.mcHomeDir,
      mcSessionId: resolved.session.mc_session_id,
      expectedRevision: resolved.session.metadata.revision,
      name: opts.newName,
    });
  } catch (error) {
    stderr.write(`mc: could not rename session (${error?.reason || error?.message || 'unknown'})\n`);
    return 1;
  }
  const payload = {
    ok: true,
    source_kind: 'local',
    mc_session_id: renamed.mc_session_id,
    old_name: resolved.session.metadata.name,
    new_name: renamed.metadata.name,
  };
  if (opts.json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else stdout.write(`mc: renamed ${payload.old_name} → ${payload.new_name}\n`);
  return 0;
}

export function parseArgs(argv) {
  const opts = { oldName: null, newName: null, json: false };
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (!opts.oldName) opts.oldName = arg;
    else if (!opts.newName) opts.newName = arg;
    else return { ...opts, error: `unexpected arg: ${arg}` };
  }
  return opts;
}
