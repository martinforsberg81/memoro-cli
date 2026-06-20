/**
 * `mc resume <name> [--tool …|--codex|--claude] [--no-launch] [--json]
 *                  [--emit-shell-directives]`
 *
 * §2 + §2b: emit `cd <worktree>` on fd 3 *before* the tool launches, so
 * the launched tool's cwd is the worktree. In `--no-launch` mode (tests
 * + when the user just wants to cd), we emit the directive and exit.
 *
 * Resume is not `mc new` with another label. If the broker still owns a live
 * PTY for this registry entry, resume attaches to it and sends no new prompt.
 * If the old PTY is gone, resume refuses to silently create a new tool session
 * in the same worktree. A replacement/cold relaunch must be explicit.
 */
import { findEntry, readRegistry, upsertEntry } from '../registry.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { resolveToolInput } from '../../adapters/index.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { launchBrokerOwnedSession } from '../broker/launch-client.js';
import { attachBrokerSession } from '../broker/attach-client.js';
import { requestBroker } from '../broker/client.js';
import { buildResumeSessionLaunchIntent } from '../session-intent.js';
import {
  buildSessionListView,
  fetchActiveCodingSessions,
  findActiveForLocalEntry,
  listChoices,
  parseNumberedChoice,
  renderActiveSelectionMessage,
  renderSessionListHuman,
} from '../session-list.js';

export const TOOL_SUGAR = {
  '--claude': 'claude',
  '--codex': 'codex',
  '--gemini': 'gemini',
};

export async function run(rawArgv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const stdin = deps.stdin || process.stdin;
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }
  if (!opts.name) {
    return runResumePicker({
      opts,
      argv,
      stdin,
      stdout,
      stderr,
      emitDirectives,
      deps,
    });
  }
  const lookupEntry = deps.findEntry || findEntry;
  let entry = lookupEntry(opts.name);
  if (!entry) {
    stderr.write(`mc: no such session "${opts.name}"\n`);
    return 1;
  }

  const toolValidation = validateToolFlag(opts.tool);
  if (toolValidation.error) {
    stderr.write(`mc: ${toolValidation.error}\n`);
    return 2;
  }

  if (!opts.json && !opts.noLaunch && process.env.MC_TEST_MODE !== '1') {
    const attached = await attachLiveBrokerSession(entry, {
      stdin,
      stdout,
      stderr,
      request: deps.requestBroker || requestBroker,
      attach: deps.attachBrokerSession || attachBrokerSession,
    });
    if (attached?.attached) return attached.code ?? 0;

    const active = await activeMatchForEntry(entry, { argv, deps });
    if (active) {
      stdout.write(renderActiveSelectionMessage(active));
      return 0;
    }
    if (hasStoredToolSession(entry)) {
      stderr.write(renderMissingLiveSessionMessage(entry));
      return 1;
    }
  }

  if (opts.tool) {
    const res = applyToolOverride(entry, opts.tool, {
      upsert: deps.upsertEntry || upsertEntry,
      resolved: toolValidation.resolved,
    });
    if (res.error) {
      stderr.write(`mc: ${res.error}\n`);
      return 2;
    }
    entry = res.entry;
  }

  if (entry.worktree_path) {
    emitCd(entry.worktree_path, { enabled: emitDirectives || undefined });
  }

  if (opts.json) {
    stdout.write(JSON.stringify({
      name: entry.name,
      tool: entry.tool || DEFAULT_TOOL,
      worktree_path: entry.worktree_path || null,
      coding_session_id: entry.coding_session_id || null,
    }, null, 2) + '\n');
    return 0;
  }

  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') {
    return 0;
  }

  // Broker-owned process model: resume starts through the broker and the
  // local terminal attaches as a client. Closing this terminal detaches
  // without killing the LLM session.
  const launch = deps.launchResumeSession || launchResumeSession;
  return launch({ entry, apiArgv: argv, stderr, env: process.env });
}

export async function launchResumeSession({
  entry,
  apiArgv = [],
  env = process.env,
  stderr = process.stderr,
  deps = {},
} = {}) {
  const launchTool = entry?.tool ? resolveToolInput(entry.tool) : null;
  const materialise = deps.materialiseVaultBeforeLaunch
    || (await import('../vault/startup.js')).materialiseVaultBeforeLaunch;

  try {
    const res = await materialise({
      sessionId: entry.name,
      worktreePath: entry.worktree_path || undefined,
      adapters: launchTool?.adapter ? [launchTool.adapter] : undefined,
    });
    if (!res.ok && res.hint) {
      stderr.write(`mc: ${res.hint}\n`);
    }
  } catch (err) {
    stderr.write(`mc: vault materialise failed (${err.message}); continuing without tokens\n`);
  }

  const launch = deps.launchBrokerOwnedSession || launchBrokerOwnedSession;
  const result = await launch({
    ...buildResumeSessionLaunchIntent({
      entry,
      launchTool,
      apiArgv,
      env,
    }),
    stderr,
    onLaunched: ({ codingSessionId }) => {
      const upsert = deps.upsertEntry || upsertEntry;
      upsert({
        name: entry.name,
        coding_session_id: codingSessionId,
        session_state: 'live',
      });
    },
    deps: deps.launchDeps || {},
  });
  if (typeof result === 'number') return result;
  return result?.code ?? 0;
}

export function parseArgs(argv) {
  const opts = { name: null, tool: null, noLaunch: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-launch') { opts.noLaunch = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--tool') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { error: '--tool requires a value' };
      opts.tool = next;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TOOL_SUGAR, a)) {
      if (opts.tool && opts.tool !== TOOL_SUGAR[a]) {
        return { error: `conflicting tool flags: --tool ${opts.tool} and ${a}` };
      }
      opts.tool = TOOL_SUGAR[a];
      continue;
    }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    if (opts.name) return { error: `unexpected arg: ${a}` };
    opts.name = a;
  }
  return opts;
}

export function resumableEntries(reg = readRegistry()) {
  const entries = Array.isArray(reg?.entries) ? reg.entries : [];
  return entries
    .filter((e) => e && typeof e.name === 'string' && e.name)
    .map((e) => ({
      name: e.name,
      branch: e.branch || '',
      tool: e.tool || DEFAULT_TOOL,
      session_state: e.session_state || 'no-session-yet',
      worktree_path: e.worktree_path || null,
      kind: e.kind || 'work',
      label: e.label || null,
      coding_session_id: e.coding_session_id || null,
      repo_slug: e.repo_slug || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function runResumePicker({
  opts,
  argv = [],
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  emitDirectives = false,
  deps = {},
} = {}) {
  const loadRegistry = deps.readRegistry || readRegistry;
  const fetchActive = deps.fetchActiveSessions || ((args) => fetchActiveCodingSessions({ argv: args }));
  const launch = deps.launchResumeSession || launchResumeSession;
  const attachLive = deps.attachLiveBrokerSession || attachLiveBrokerSession;
  const upsert = deps.upsertEntry || upsertEntry;
  const entries = resumableEntries(loadRegistry());
  const toolValidation = validateToolFlag(opts.tool);
  if (toolValidation.error) {
    stderr.write(`mc: ${toolValidation.error}\n`);
    return 2;
  }

  if (opts.json) {
    stdout.write(JSON.stringify({
      entries,
      hint: 'Run `mc resume <name>` to re-enter a session, or `mc resume <name> --codex/--claude` to relaunch it under another tool.',
    }, null, 2) + '\n');
    return 0;
  }

  const activeRes = await fetchActive(argv);
  if (activeRes?.warning) stderr.write(`mc: ${activeRes.warning}\n`);
  const view = buildSessionListView({
    activeSessions: activeRes?.sessions || [],
    localEntries: entries,
  });
  stdout.write(renderSessionListHuman({
    view,
    title: 'mc sessions available to resume:',
    emptyLocalHint: 'Create one with `mc new <name> [focus] --codex`.',
  }));

  const choices = listChoices(view);
  if (choices.length === 0) return 0;

  const isInteractive = deps.isTTY ?? (stdin?.isTTY && stdout?.isTTY);
  if (!isInteractive) {
    const toolHint = opts.tool
      ? `mc resume <name> --${opts.tool === 'claude' ? 'claude' : opts.tool}`
      : 'mc resume <name>';
    stdout.write(`Run \`${toolHint}\` to re-enter a local session.\n`);
    return 0;
  }

  const answer = await promptForChoice({ stdin, stdout, deps });
  const parsed = parseNumberedChoice(answer, choices);
  if (parsed.error) {
    stderr.write(`mc: ${parsed.error}\n`);
    return 2;
  }
  return resumeSelectedChoice(parsed.choice, {
    opts,
    emitDirectives,
    stdin,
    stdout,
    stderr,
    launchResumeSession: launch,
    attachLiveBrokerSession: attachLive,
    upsertEntry: upsert,
    resolvedTool: toolValidation.resolved,
  });
}

export async function resumeSelectedChoice(choice, {
  opts = {},
  emitDirectives = false,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  launchResumeSession: launch = launchResumeSession,
  attachLiveBrokerSession: attachLive = attachLiveBrokerSession,
  upsertEntry: upsert = upsertEntry,
  resolvedTool = null,
} = {}) {
  if (!choice) return 2;
  if (choice.type === 'active') {
    const attached = await attachLive({
      name: choice.label || choice.name || null,
      coding_session_id: choice.coding_session_id || choice.id || null,
    }, { stdin, stdout, stderr });
    if (attached?.attached) return attached.code ?? 0;
    stdout.write(renderActiveSelectionMessage(choice));
    return 0;
  }

  let entry = choice;
  if (!opts.noLaunch && process.env.MC_TEST_MODE !== '1') {
    const attached = await attachLive(entry, { stdin, stdout, stderr });
    if (attached?.attached) return attached.code ?? 0;
    if (hasStoredToolSession(entry)) {
      stderr.write(renderMissingLiveSessionMessage(entry));
      return 1;
    }
  }

  if (opts.tool) {
    const res = applyToolOverride(entry, opts.tool, { upsert, resolved: resolvedTool });
    if (res.error) {
      stderr.write(`mc: ${res.error}\n`);
      return 2;
    }
    entry = res.entry;
  }

  if (entry.worktree_path) {
    emitCd(entry.worktree_path, { enabled: emitDirectives || undefined });
  }
  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') return 0;
  return launch({ entry });
}

export async function attachLiveBrokerSession(entry, {
  request = requestBroker,
  attach = attachBrokerSession,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const listed = await request({ type: 'sessions' }).catch(() => null);
  const target = selectLiveBrokerSessionForEntry(entry, listed?.sessions || []);
  const id = brokerSessionId(target);
  if (!id) return { attached: false };
  const code = await attach({ id, stdin, stdout, stderr });
  return { attached: true, code, id };
}

export function selectLiveBrokerSessionForEntry(entry, sessions = []) {
  if (!entry || !Array.isArray(sessions)) return null;
  const live = sessions.filter(isLiveBrokerSession);

  const entryId = nonEmpty(entry.coding_session_id);
  if (entryId) {
    const direct = live.find((session) => brokerSessionId(session) === entryId);
    if (direct) return direct;
  }

  const worktreePath = nonEmpty(entry.worktree_path);
  if (worktreePath) {
    const normalizedWorktreePath = normalizePathForMatch(worktreePath);
    const byCwd = live.find(
      (session) => normalizePathForMatch(session.cwd) === normalizedWorktreePath,
    );
    if (byCwd) return byCwd;
  }

  const name = nonEmpty(entry.name);
  if (name) {
    return live.find((session) => (
      nonEmpty(session.name) === name
      || nonEmpty(session.worktree_name) === name
    )) || null;
  }

  return null;
}

function isLiveBrokerSession(session) {
  return !!brokerSessionId(session)
    && session?.attachable !== false
    && session?.session_state !== 'dead'
    && !session?.exit;
}

function brokerSessionId(session) {
  return nonEmpty(session?.id) || nonEmpty(session?.coding_session_id);
}

function hasStoredToolSession(entry) {
  return !!nonEmpty(entry?.coding_session_id);
}

function normalizePathForMatch(value) {
  const text = nonEmpty(value);
  if (!text) return null;
  let out = text.replace(/[/\\]+$/, '');
  if (process.platform === 'darwin' && out.startsWith('/private/')) {
    out = out.slice('/private'.length);
  }
  return out;
}

function renderMissingLiveSessionMessage(entry = {}) {
  const name = nonEmpty(entry.name) || '<unknown>';
  const id = nonEmpty(entry.coding_session_id) || '<unknown>';
  const worktree = nonEmpty(entry.worktree_path) || '<unknown>';
  return [
    `mc: session "${name}" has no attachable live broker session.`,
    `mc: expected coding session ${id} in ${worktree}.`,
    'mc: refusing to create a new Codex/Claude session in the same worktree.',
    'mc: stop/end the stale session or use an explicit replacement path when available.',
    '',
  ].join('\n');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function activeMatchForEntry(entry, { argv = [], deps = {} } = {}) {
  const fetchActive = deps.fetchActiveSessions || ((args) => fetchActiveCodingSessions({ argv: args }));
  const activeRes = await fetchActive(argv);
  if (!activeRes?.ok) return null;
  return findActiveForLocalEntry(entry, activeRes.sessions || []);
}

function validateToolFlag(tool) {
  if (!tool) return { resolved: null };
  const resolved = resolveToolInput(tool);
  if (!resolved) {
    return { error: `unknown tool: ${tool}. Try: claude | codex | gemini` };
  }
  return { resolved };
}

function applyToolOverride(entry, tool, { upsert = upsertEntry, resolved = null } = {}) {
  const resolvedTool = resolved || validateToolFlag(tool).resolved;
  if (!resolvedTool) {
    return { error: `unknown tool: ${tool}. Try: claude | codex | gemini` };
  }
  return { entry: upsert({ name: entry.name, tool: resolvedTool.shortName }) };
}

async function promptForChoice({ stdin, stdout, deps = {} } = {}) {
  const prompt = 'Select a session number: ';
  if (typeof deps.readLine === 'function') {
    stdout.write(prompt);
    return deps.readLine({ stdin, stdout, prompt });
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
