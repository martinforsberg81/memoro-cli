import { resolveToolInput } from '../adapters/index.js';
import { DEFAULT_TOOL, readConfig } from '../lib/config.js';
import { checkAndPrintFreshInstall, ensureSentinel } from '../mc/first-run.js';
import { emitCd, parseDirectiveFlag } from '../mc/shell-directives.js';
import {
  createLocalSessionSync,
  ensureV1SessionStorageSync,
} from '../mc/session-v1.js';

const BUILTIN_DEFAULT_TOOL = 'codex';
export const TOOL_SUGAR = Object.freeze({
  '--codex': 'codex',
  '--claude': 'claude',
});
const TOOL_FLAGS = TOOL_SUGAR;

export async function run(rawArgv, deps = {}) {
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const opts = parseArgs(argv);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    printUsage(stderr);
    return 2;
  }
  if (!opts.name) {
    printUsage(stderr);
    return 2;
  }
  if (opts.json && !opts.noLaunch) {
    stderr.write('mc: --json requires --no-launch for mc new\n');
    return 2;
  }
  return launchNewSession(opts, {
    ...deps,
    stdout,
    stderr,
    emitDirectives,
  });
}

export async function launchNewSession(opts, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const cwd = deps.cwd || process.cwd();
  if (!opts.noLaunch && await (deps.checkAndPrintFreshInstall || checkAndPrintFreshInstall)()) {
    return 1;
  }

  const tool = await resolveToolForNew({
    flagValue: opts.tool,
    configLoader: deps.readConfig || readConfig,
  });
  if (tool.error) {
    stderr.write(`mc: ${tool.error}\n`);
    return 2;
  }

  let created;
  try {
    const source = (deps.ensureV1SessionStorage || ensureV1SessionStorageSync)({
      mcHomeDir: deps.mcHomeDir,
    });
    created = (deps.createLocalSession || createLocalSessionSync)({
      mcHomeDir: deps.mcHomeDir,
      sourceId: source.source_id,
      name: opts.name,
      objective: opts.task || null,
      cwd,
    });
  } catch (error) {
    stderr.write(`mc: could not create session "${opts.name}" (${error?.reason || error?.message || 'unknown'})\n`);
    return 1;
  }

  (deps.ensureSentinel || ensureSentinel)();
  emitCd(created.workspace.current_path, {
    enabled: deps.emitDirectives || undefined,
    tipIfDisabled: false,
  });
  const payload = {
    ok: true,
    source_kind: 'local',
    source_id: created.session.identity.owner.source_id,
    mc_session_id: created.session.mc_session_id,
    name: created.session.metadata.name,
    objective: created.session.metadata.objective,
    workspace_id: created.workspace.workspace_id,
    workspace_path: created.workspace.current_path,
    tool: tool.tool,
    tool_source: tool.source,
    launched: !opts.noLaunch,
  };

  if (opts.noLaunch || deps.testMode || process.env.MC_TEST_MODE === '1') {
    if (opts.json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else stdout.write(`mc: created local session ${payload.name} in ${payload.workspace_path}\n`);
    return 0;
  }

  if (!opts.json) stdout.write(`mc: created local session ${payload.name}\n`);
  const open = deps.openSession || (await import('./open.js')).run;
  return open([
    created.session.mc_session_id,
    '--tool', tool.tool,
    ...(opts.json ? ['--json'] : []),
  ], deps);
}

export async function resolveToolForNew({ flagValue, configLoader = readConfig } = {}) {
  if (flagValue) {
    const resolved = resolveToolInput(flagValue);
    if (!resolved || !['codex', 'claude'].includes(resolved.shortName)) {
      return { error: `unknown or uncertified tool: ${flagValue}. Try: codex | claude` };
    }
    return { tool: resolved.shortName, source: 'flag' };
  }
  let config = null;
  try { config = await configLoader(); } catch {
    return { error: 'could not read the default tool configuration' };
  }
  const stored = defaultToolFromConfig(config);
  if (stored.value) {
    const resolved = resolveToolInput(stored.value);
    if (resolved && ['codex', 'claude'].includes(resolved.shortName)) {
      return { tool: resolved.shortName, source: stored.source };
    }
    return {
      error: `configured tool is not certified: ${stored.value}. Set defaultTool to codex or claude`,
    };
  }
  const builtin = resolveToolInput(DEFAULT_TOOL)?.shortName || BUILTIN_DEFAULT_TOOL;
  if (!['codex', 'claude'].includes(builtin)) {
    return { error: 'built-in default tool is not certified' };
  }
  return { tool: builtin, source: 'built-in-default' };
}

export function defaultToolFromConfig(config) {
  const value = config?.defaultTool;
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) {
    return { value: value.value ?? null, source: value.source || 'config' };
  }
  return { value: value ?? null, source: 'config' };
}

export async function readEffectiveConfigForNew() {
  return readConfig();
}

export function parseArgs(argv) {
  const opts = { name: null, task: null, tool: null, noLaunch: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-launch') { opts.noLaunch = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
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
    if (!opts.name) { opts.name = arg; continue; }
    if (!opts.task) { opts.task = arg; continue; }
    return { ...opts, error: `unexpected arg: ${arg}` };
  }
  return opts;
}

function printUsage(stream) {
  stream.write(`mc new — create a machine-local session in the current directory

USAGE
  mc new <name> [objective] [--tool codex|claude] [--no-launch] [--json]

This command creates no branch or worktree.
`);
}
