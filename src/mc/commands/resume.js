/**
 * `mc resume <name> [--tool …|--codex|--claude] [--no-launch] [--json]
 *                  [--emit-shell-directives]`
 *
 * §2 + §2b: emit `cd <worktree>` on fd 3 *before* the tool launches, so
 * the launched tool's cwd is the worktree. In `--no-launch` mode (tests
 * + when the user just wants to cd), we emit the directive and exit.
 *
 * Grounding (Phase 2 — entry parity): resume re-execs into wrap mode the
 * same way `mc new` does, so it grounds through the SAME `groundSession`
 * seam in `runWrap` — no forked grounding logic here. The session's label
 * (if any) is threaded across the re-exec as the soft `focus` pointer via
 * `MC_GROUNDING_FOCUS`, matching `mc new`'s `<task>` plumbing.
 */
import { findEntry, readRegistry, upsertEntry } from '../registry.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { resolveToolInput } from '../../adapters/index.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { launchBrokerOwnedSession } from '../broker/launch-client.js';
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
    const active = await activeMatchForEntry(entry, { argv, deps });
    if (active) {
      stdout.write(renderActiveSelectionMessage(active));
      return 0;
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
    cwd: entry.worktree_path,
    sessionName: entry.name,
    label: entry.label || null,
    focus: entry.label || null,
    tool: launchTool?.id || entry.tool || DEFAULT_TOOL,
    argv: ['--resume'],
    apiArgv,
    env,
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
    stdout,
    stderr,
    launchResumeSession: launch,
    upsertEntry: upsert,
    resolvedTool: toolValidation.resolved,
  });
}

export async function resumeSelectedChoice(choice, {
  opts = {},
  emitDirectives = false,
  stdout = process.stdout,
  stderr = process.stderr,
  launchResumeSession: launch = launchResumeSession,
  upsertEntry: upsert = upsertEntry,
  resolvedTool = null,
} = {}) {
  if (!choice) return 2;
  if (choice.type === 'active') {
    stdout.write(renderActiveSelectionMessage(choice));
    return 0;
  }

  let entry = choice;
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
