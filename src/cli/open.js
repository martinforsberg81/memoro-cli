import { existsSync, realpathSync } from 'node:fs';

import { resolveToolInput } from '../adapters/index.js';
import { emitCd, parseDirectiveFlag } from '../mc/shell-directives.js';
import {
  associateLocalWorkspaceSync,
  projectLocalSessionSync,
  resolveLocalSessionSync,
} from '../mc/session-v1.js';
import { openLocalSessionRuntime } from '../mc/session-runtime-v1.js';
import { workspaceContainsMcInstallSync } from '../vault/credential-domain/local-codex.js';

const TOOL_FLAGS = Object.freeze({ '--codex': 'codex', '--claude': 'claude' });

export async function run(rawArgv, deps = {}) {
  const { args: argv, enabled } = parseDirectiveFlag(rawArgv);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.identifier) {
    stderr.write(`mc: ${opts.error || 'usage — mc open <local-session> [--cwd <path>]'}\n`);
    return 2;
  }
  if (opts.identifier.startsWith('cloud:')) {
    stderr.write('mc: cloud sessions are source-owned and cannot be opened by the local runtime\n');
    return 1;
  }
  if (opts.json && !opts.noLaunch) {
    stderr.write('mc: --json requires --no-launch for mc open\n');
    return 2;
  }
  const tool = resolveRequestedTool(opts.tool);
  if (tool.error) {
    stderr.write(`mc: ${tool.error}\n`);
    return 2;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.identifier, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) {
    stderr.write(`mc: local session "${opts.identifier}" was not found (${resolved.reason})\n`);
    return 1;
  }
  let session = resolved.session;
  let projection = (deps.projectLocalSession || projectLocalSessionSync)(session, {
    mcHomeDir: deps.mcHomeDir,
  });
  let workspace = projection.workspaces.find((item) => item.workspace_id === projection.workspace_id);
  if (opts.cwd) {
    if (!existsSync(opts.cwd)) {
      stderr.write(`mc: workspace is missing: ${opts.cwd}\n`);
      return 1;
    }
    try {
      workspace = (deps.associateWorkspace || associateLocalWorkspaceSync)({
        mcHomeDir: deps.mcHomeDir,
        session,
        cwd: realpathSync(opts.cwd),
        preferredLaunch: true,
      });
    } catch (error) {
      stderr.write(`mc: could not associate workspace (${error?.reason || error?.message || 'unknown'})\n`);
      return 1;
    }
  }
  if (!workspace || workspace.path_state === 'missing' || !existsSync(workspace.current_path)) {
    stderr.write(`mc: session "${session.metadata.name}" has no present launch workspace; use --cwd <path>\n`);
    return 1;
  }
  // A session is not bound to one workspace, and its preferred one may be a
  // directory no session can run in — mc's own installation, where a
  // credential boundary cannot exclude the mc binary from the sandbox. When
  // the user is standing somewhere that does work, use that: associating it
  // is exactly what a session's several workspaces are for, and the old one
  // is kept. Telling the user to "run this from another directory" was worse
  // than useless, because `mc open` had already moved them to the broken one.
  if (!opts.cwd
    && (deps.workspaceBlocksBoundary || workspaceContainsMcInstallSync)(workspace.current_path)) {
    const here = deps.cwd || process.cwd();
    if (here !== workspace.current_path
      && !(deps.workspaceBlocksBoundary || workspaceContainsMcInstallSync)(here)) {
      try {
        workspace = (deps.associateWorkspace || associateLocalWorkspaceSync)({
          mcHomeDir: deps.mcHomeDir,
          session,
          cwd: realpathSync(here),
          preferredLaunch: true,
        });
        stderr.write(`mc: this session's workspace is mc's own installation, where a credential\n`);
        stderr.write(`    boundary cannot be built; using ${workspace.current_path} instead\n`);
      } catch { /* fall through to the launch, which reports the real reason */ }
    }
  }
  emitCd(workspace.current_path, {
    enabled: enabled || deps.emitDirectives || undefined,
    tipIfDisabled: false,
  });
  const result = await (deps.openRuntime || openLocalSessionRuntime)({
    mcHomeDir: deps.mcHomeDir,
    session,
    workspace,
    tool: tool.tool,
    replace: opts.replace,
    noLaunch: opts.noLaunch,
    stdin: deps.stdin || process.stdin,
    stdout,
    stderr,
    deps: deps.runtimeDeps || deps,
  });
  if (!result.ok) {
    stderr.write(`mc: could not open "${session.metadata.name}" (${result.reason}${result.diagnostic_code ? `: ${result.diagnostic_code}` : ''})\n`);
    if (result.reason === 'managed-portable-workspace-contains-mc') {
      stderr.write('mc: every workspace this session has is inside mc\'s own installation,\n');
      stderr.write('    where a credential boundary cannot exclude the mc binary. Open it\n');
      stderr.write('    with --cwd <path> to give the session a directory it can run in.\n');
    }
    if (result.reason === 'explicit-replacement-required') {
      stderr.write(`mc: retry with --replace only if you want a new tool conversation\n`);
    }
    return result.code;
  }
  // Not an instruction — a statement of what mc already did, so a session that
  // suddenly starts fresh is explained rather than mysterious.
  if (result.replaced_unresumable_conversation && !opts.json) {
    stderr.write('mc: the recorded conversation had no transcript to resume; started a new one\n');
  }
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      ok: true,
      source_kind: 'local',
      mc_session_id: session.mc_session_id,
      name: session.metadata.name,
      workspace_id: workspace.workspace_id,
      workspace_path: workspace.current_path,
      ...result,
    }, null, 2)}\n`);
  }
  return result.code;
}

export function parseArgs(argv) {
  const opts = {
    identifier: null,
    cwd: null,
    tool: null,
    replace: false,
    noLaunch: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--no-launch') { opts.noLaunch = true; continue; }
    if (arg === '--replace') { opts.replace = true; continue; }
    if (arg === '--cwd') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) return { ...opts, error: '--cwd requires a path' };
      opts.cwd = value;
      continue;
    }
    if (Object.hasOwn(TOOL_FLAGS, arg)) {
      if (opts.tool && opts.tool !== TOOL_FLAGS[arg]) return { ...opts, error: 'conflicting tool flags' };
      opts.tool = TOOL_FLAGS[arg];
      continue;
    }
    if (arg === '--tool') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) return { ...opts, error: '--tool requires a value' };
      if (opts.tool && opts.tool !== value) return { ...opts, error: 'conflicting tool flags' };
      opts.tool = value;
      continue;
    }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.identifier) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.identifier = arg;
  }
  return opts;
}

function resolveRequestedTool(value) {
  if (!value) return { tool: null };
  const resolved = resolveToolInput(value);
  return resolved && ['codex', 'claude'].includes(resolved.shortName)
    ? { tool: resolved.shortName }
    : { error: `unknown or uncertified tool: ${value}. Try: codex | claude` };
}
