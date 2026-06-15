import { resolveToolInput } from '../../adapters/index.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { launchBrokerOwnedSession } from '../broker/launch-client.js';
import { resolveEffectivePolicy } from '../policy.js';

const DEFAULT_POLICY = 'workspace-write';
const DEFAULT_SOURCE_NAME = 'Memoro Cloud';
const CLOUD_SESSION_ID_RE = /^cld_[a-zA-Z0-9_-]{6,}$/;
const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const POLICIES = new Set(['read-only', 'workspace-write']);
const FREE_COMMAND_FLAGS = new Set([
  '--cmd',
  '--command',
  '--shell',
  '--cwd',
  '--env',
  '--args',
  '--argv',
  '--executable',
  '--entrypoint',
]);
const TOOL_SUGAR = {
  '--claude': 'claude',
  '--codex': 'codex',
  '--gemini': 'gemini',
};

export async function run(argv) {
  const opts = parseArgs(argv);
  return runCloudSessionWith(opts, {
    launchBrokerOwnedSession,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: () => process.cwd(),
  });
}

export async function runCloudSessionWith(opts, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    printUsage(stderr);
    return 2;
  }
  if (opts.help || !opts.verb) {
    printUsage(stdout);
    return opts.help ? 0 : 2;
  }
  if (opts.verb !== 'start') {
    stderr.write(`mc: unknown cloud-session verb: ${opts.verb}\n`);
    printUsage(stderr);
    return 2;
  }

  const validation = validateCloudSessionOptions(opts);
  if (!validation.ok) {
    stderr.write(`mc: ${validation.error}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error: validation.error });
    return 2;
  }
  const cloud = validation.cloud;
  const sourceName = cloud.sourceName || DEFAULT_SOURCE_NAME;
  const sourceId = cloud.sourceId || `cloud:${cloud.cloudSessionId}`;
  const baseEnv = deps.env || process.env;
  const launchEnv = {
    ...baseEnv,
    MC_SOURCE_ID: sourceId,
    MC_SOURCE_KIND: 'cloud',
    MC_SOURCE_NAME: sourceName,
    MC_CLOUD_SESSION_ID: cloud.cloudSessionId,
    MC_CLOUD_SESSION_POLICY: cloud.policy,
  };
  const launchStdout = opts.json
    ? quietLaunchStdout(stdout)
    : stdout;
  const launch = deps.launchBrokerOwnedSession || launchBrokerOwnedSession;
  const result = await launch({
    cwd: (deps.cwd || (() => process.cwd()))(),
    sessionName: cloud.name,
    label: null,
    focus: cloud.task,
    tool: cloud.launchTool,
    argv: [],
    apiArgv: [],
    sendStartupMessage: true,
    attachAfterLaunch: false,
    cloudBroker: {
      sourceId,
      sourceKind: 'cloud',
      sourceName,
      cloudSessionId: cloud.cloudSessionId,
    },
    stdout: launchStdout,
    stderr,
    env: launchEnv,
    deps: {
      ...(deps.launchDeps || {}),
      resolvePolicyForWrap: ({ tool }) => cloudPolicyForLaunch(cloud.policy, tool || cloud.tool),
    },
  });

  const code = Number.isInteger(result?.code) ? result.code : 0;
  if (code !== 0) {
    if (opts.json) writeJson(stdout, { ok: false, error: 'cloud session launch failed', code });
    return code;
  }

  const payload = {
    ok: true,
    cloud_session_id: cloud.cloudSessionId,
    coding_session_id: result?.codingSessionId || null,
    source_id: sourceId,
    source_kind: 'cloud',
    source_name: sourceName,
    name: cloud.name,
    task: cloud.task,
    tool: cloud.tool,
    policy: cloud.policy,
    repo_ref: cloud.repoRef,
    workspace_ref: cloud.workspaceRef,
    attached: result?.attached === true,
    broker: result?.broker || null,
  };
  if (opts.json) {
    writeJson(stdout, payload);
  } else {
    stdout.write(`mc cloud-session: started ${payload.name} (${payload.coding_session_id || 'pending id'})\n`);
  }
  return 0;
}

export function parseArgs(argv) {
  const opts = {
    verb: null,
    json: false,
    help: false,
    name: null,
    task: null,
    tool: null,
    policy: DEFAULT_POLICY,
    repoRef: null,
    workspaceRef: null,
    sourceId: null,
    sourceName: null,
    cloudSessionId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (FREE_COMMAND_FLAGS.has(a)) {
      return { ...opts, error: `free command field is not allowed: ${a}` };
    }
    if (Object.prototype.hasOwnProperty.call(TOOL_SUGAR, a)) {
      if (opts.tool && opts.tool !== TOOL_SUGAR[a]) {
        return { ...opts, error: `conflicting tool flags: --tool ${opts.tool} and ${a}` };
      }
      opts.tool = TOOL_SUGAR[a];
      continue;
    }
    if (a === '--name') { opts.name = valueAfter(argv, ++i, a); if (isMissing(opts.name)) return missingValue(opts, a); continue; }
    if (a === '--task') { opts.task = valueAfter(argv, ++i, a); if (isMissing(opts.task)) return missingValue(opts, a); continue; }
    if (a === '--tool') { opts.tool = valueAfter(argv, ++i, a); if (isMissing(opts.tool)) return missingValue(opts, a); continue; }
    if (a === '--policy') { opts.policy = valueAfter(argv, ++i, a); if (isMissing(opts.policy)) return missingValue(opts, a); continue; }
    if (a === '--repo-ref') { opts.repoRef = valueAfter(argv, ++i, a); if (isMissing(opts.repoRef)) return missingValue(opts, a); continue; }
    if (a === '--workspace-ref') { opts.workspaceRef = valueAfter(argv, ++i, a); if (isMissing(opts.workspaceRef)) return missingValue(opts, a); continue; }
    if (a === '--source-id') { opts.sourceId = valueAfter(argv, ++i, a); if (isMissing(opts.sourceId)) return missingValue(opts, a); continue; }
    if (a === '--source-name') { opts.sourceName = valueAfter(argv, ++i, a); if (isMissing(opts.sourceName)) return missingValue(opts, a); continue; }
    if (a === '--cloud-session-id') { opts.cloudSessionId = valueAfter(argv, ++i, a); if (isMissing(opts.cloudSessionId)) return missingValue(opts, a); continue; }
    if (a.startsWith('--')) return { ...opts, error: `unknown flag: ${a}` };
    if (opts.verb) return { ...opts, error: `unexpected arg: ${a}` };
    opts.verb = a;
  }
  return opts;
}

export function validateCloudSessionOptions(opts) {
  if (!opts?.cloudSessionId || !CLOUD_SESSION_ID_RE.test(opts.cloudSessionId)) {
    return { ok: false, error: 'cloud session id is required and must match /^cld_[a-zA-Z0-9_-]{6,}$/' };
  }
  if (opts.sourceId && !SOURCE_ID_RE.test(opts.sourceId)) {
    return { ok: false, error: 'source id must be 1-128 chars and contain only letters, numbers, dot, underscore, colon, or dash' };
  }
  if (opts.policy && !POLICIES.has(opts.policy)) {
    return { ok: false, error: 'policy must be read-only or workspace-write' };
  }
  const resolvedTool = resolveToolInput(opts.tool || DEFAULT_TOOL);
  if (!resolvedTool) {
    return { ok: false, error: `unknown tool: ${opts.tool}. Try: claude | codex | gemini` };
  }
  const name = opts.name || defaultName(opts.task, opts.cloudSessionId);
  if (!NAME_RE.test(name)) {
    return { ok: false, error: `name must match ${NAME_RE}` };
  }
  return {
    ok: true,
    cloud: {
      cloudSessionId: opts.cloudSessionId,
      sourceId: opts.sourceId || null,
      sourceName: opts.sourceName || DEFAULT_SOURCE_NAME,
      name,
      task: stringOrNull(opts.task),
      tool: resolvedTool.shortName,
      launchTool: resolvedTool.id,
      policy: opts.policy || DEFAULT_POLICY,
      repoRef: stringOrNull(opts.repoRef),
      workspaceRef: stringOrNull(opts.workspaceRef),
    },
  };
}

export function cloudPolicyForLaunch(policy, tool) {
  const workspace = policy === 'read-only' ? 'read-only' : 'worktree';
  return resolveEffectivePolicy({
    tool,
    entry: {
      policy: {
        permissions: { workspace },
      },
    },
  });
}

function valueAfter(argv, index) {
  return argv[index];
}

function isMissing(value) {
  return !value || value.startsWith('--');
}

function missingValue(opts, flag) {
  return { ...opts, error: `${flag} requires a value` };
}

function defaultName(task, cloudSessionId) {
  const base = stringOrNull(task)?.split(/\s+/).slice(0, 4).join('-')
    || cloudSessionId.replace(/^cld_/, 'cloud-');
  return base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 64) || 'cloud-session';
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function quietLaunchStdout(stdout) {
  return {
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
    write() {},
  };
}

function writeJson(stdout, payload) {
  stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function printUsage(stream = process.stdout) {
  stream.write(`mc cloud-session — internal typed cloud mc runtime

USAGE
  mc cloud-session start --cloud-session-id <cld_id> [--name <name>]
                   [--task <focus>] [--tool claude|codex|gemini]
                   [--policy read-only|workspace-write] [--json]

This command accepts structured mc launch fields only. It does not accept
cmd, shell, cwd, env, args, argv, executable, or entrypoint fields.
`);
}
