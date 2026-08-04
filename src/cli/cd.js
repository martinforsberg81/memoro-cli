import { existsSync } from 'node:fs';

import { emitCd, parseDirectiveFlag } from '../mc/shell-directives.js';
import { projectLocalSessionSync, resolveLocalSessionSync } from '../mc/session-v1.js';

export async function run(rawArgv, deps = {}) {
  const { args: argv, enabled } = parseDirectiveFlag(rawArgv);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.name) {
    stderr.write(`mc: ${opts.error || 'usage — mc cd <name> [--workspace <id>]'}\n`);
    return 2;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.name, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) {
    stderr.write(`mc: session "${opts.name}" was not found (${resolved.reason})\n`);
    return 1;
  }
  const projection = (deps.projectLocalSession || projectLocalSessionSync)(resolved.session, {
    mcHomeDir: deps.mcHomeDir,
  });
  const workspace = opts.workspace
    ? projection.workspaces.find((item) => item.workspace_id === opts.workspace)
    : projection.workspaces.find((item) => item.workspace_id === projection.workspace_id);
  if (!workspace) {
    stderr.write(`mc: workspace ${opts.workspace || 'selection'} is not associated with "${projection.name}"\n`);
    return 1;
  }
  if (workspace.path_state === 'missing' || !existsSync(workspace.current_path)) {
    stderr.write(`mc: workspace is missing: ${workspace.current_path}\n`);
    return 1;
  }
  const emitted = (deps.emitCd || emitCd)(workspace.current_path, {
    enabled: enabled || deps.emitDirectives || undefined,
    tipIfDisabled: false,
  });
  if (!emitted) stdout.write(`${workspace.current_path}\n`);
  return 0;
}

export function parseArgs(argv) {
  const opts = { name: null, workspace: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) return { ...opts, error: '--workspace requires an id' };
      opts.workspace = value;
      continue;
    }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.name) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.name = arg;
  }
  return opts;
}
