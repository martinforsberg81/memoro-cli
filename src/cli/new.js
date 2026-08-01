/**
 * `mc new <name> [<task>] [--from <ref>] [--tool …] [--no-launch] [--json]
 *               [--emit-shell-directives]`
 *
 * §2: create worktree at ${MC_HOME}/worktrees/<repo-slug>/<name> with
 * branch `sess/<name>`, register it, launch the chosen tool (unless
 * --no-launch). §2b: emit `cd <worktree>` on fd 3 when the wrapper is
 * attached.
 *
 * Grounding (Phase 2): an optional `<task>` positional is the soft
 * `focus` pointer — standing context only, NOT an opening prompt (the
 * session stays free to switch tracks). The re-exec into wrap mode drops
 * argv, so focus is threaded across the process boundary via the
 * `MC_GROUNDING_FOCUS` env var, which `runWrap` reads at its pre-launch
 * grounding slot — the SAME `groundSession` seam bare `mc` uses.
 *
 * The label-tagging Claude wrap that used to live under `mc new <label>`
 * moved to `mc wrap` — see commands/wrap.js.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  formatEntryResolutionError,
  readRegistry,
  resolveEntry,
  upsertEntry,
} from '../mc/registry.js';
import { repoSlug, worktreePath } from '../mc/paths.js';
import { git, isInsideRepo, primaryWorktree, branchExists } from '../mc/git.js';
import {
  repositoryIdentityProjection,
  resolveRepositoryIdentity,
} from '../mc/repository-identity.js';
import { emitCd, parseDirectiveFlag } from '../mc/shell-directives.js';
import { checkAndPrintFreshInstall, ensureSentinel } from '../mc/first-run.js';
import { resolveToolInput } from '../adapters/index.js';
import { DEFAULT_TOOL, readConfig } from '../lib/config.js';
import { launchBrokerOwnedSession } from '../runtime/broker/launch-client.js';
import { readRepoLocalConfig, readRepoPolicyConfig, resolveEffectiveConfig } from '../mc/config-model.js';
import { buildNewSessionLaunchIntent } from '../mc/session-intent.js';
import { mintToolSessionForLaunch } from '../mc/tool-session.js';
import {
  LOCAL_AUTH_MODES,
  requireLocalAuthMode,
  resolveLocalAuthMode,
} from '../mc/local-auth-mode.js';

const FALLBACK_TOOL_SHORT = 'codex';

/**
 * Decide which tool the new session runs under. Precedence:
 *   1. explicit `--tool` flag (resolved through `resolveToolInput` so
 *      short names AND adapter IDs are accepted)
 *   2. `config.defaultTool` from `mc tool-switch` (always an adapter ID)
 *   3. the hardcoded fallback short name (`codex`)
 * The return value is always the short-name form (`claude`, `codex`,
 * `gemini`) — that's what the registry has stored historically and what
 * `mc list` expects to render. Adapter IDs are translated here so the
 * outer surface stays uniform.
 *
 * Exported for unit testing. `configLoader` is injectable so tests
 * don't touch real disk.
 */
export async function resolveToolForNew({ flagValue, configLoader = readConfig } = {}) {
  if (flagValue) {
    const resolved = resolveToolInput(flagValue);
    if (!resolved) {
      return { error: `unknown tool: ${flagValue}. Try: claude | codex | gemini` };
    }
    return { tool: resolved.shortName, source: 'flag' };
  }
  let cfg = null;
  try { cfg = await configLoader(); } catch { /* no config yet — soft fallback */ }
  const storedField = defaultToolFromConfig(cfg);
  const stored = storedField.value;
  if (stored) {
    const resolved = resolveToolInput(stored);
    if (resolved) return { tool: resolved.shortName, source: storedField.source };
    // Config has a value we can't resolve — surface in the registry
    // entry's tool field via the fallback rather than failing the verb,
    // so a misconfigured config doesn't lock the user out of `mc new`.
  }
  return { tool: FALLBACK_TOOL_SHORT, source: 'fallback' };
}

export function defaultToolFromConfig(cfg) {
  const raw = cfg?.defaultTool;
  if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'value')) {
    return {
      value: raw.value ?? null,
      source: raw.source || 'config',
    };
  }
  return {
    value: raw ?? null,
    source: 'config',
  };
}

export async function readEffectiveConfigForNew({ primary }) {
  const globalConfig = await readConfig();
  const repoPolicy = readRepoPolicyConfig({ worktreePath: primary });
  const repoLocal = readRepoLocalConfig({ worktreePath: primary });
  return resolveEffectiveConfig({
    globalConfig,
    repoPolicy: repoPolicy.config,
    localConfig: repoLocal.config,
    warnings: [
      ...(repoPolicy.warnings || []),
      ...(repoLocal.warnings || []),
    ],
  });
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export async function run(rawArgv) {
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);

  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    printUsage();
    return 2;
  }
  if (!opts.name) {
    console.error('mc: usage — `mc new <name> [--from <ref>] [--tool <tool>]`');
    return 2;
  }

  if (!NAME_RE.test(opts.name)) {
    console.error(`mc: invalid name "${opts.name}" — must match ${NAME_RE}`);
    return 2;
  }

  const localAuthMode = resolveLocalAuthMode({ managedPortable: opts.managedPortable });
  const authMode = requireLocalAuthMode(localAuthMode);
  if (!authMode.ok) {
    console.error(`mc: ${authMode.error}`);
    return 1;
  }
  // Announced, never silent: the weaker container is only ever reached by an
  // explicit --native, so the user always knows which boundary they got.
  if (localAuthMode === LOCAL_AUTH_MODES.NATIVE && !opts.json) {
    console.error('mc: --native — the tool uses its own sign-in; mc vault custody and the certified credential boundary are not in effect.');
  }

  // §11d: friendly first-run hint when both sentinel AND keychain
  // token miss. Runs after arg validation so `mc new --json` and
  // `--help` semantics aren't changed for fresh installs in a
  // way that would surprise scripts.
  if (await checkAndPrintFreshInstall()) {
    return 1;
  }

  const cwd = process.cwd();
  if (!isInsideRepo(cwd)) {
    console.error('mc: not inside a git repository. `mc new` requires a repo.');
    return 1;
  }

  const primary = primaryWorktree(cwd);
  if (!primary) {
    console.error('mc: could not resolve primary worktree path');
    return 1;
  }

  const repository = resolveRepositoryIdentity(primary, { createLocal: true });
  if (!repository.ok) {
    console.error(`mc: could not establish repository identity (${repository.reason})`);
    return 1;
  }
  const existing = resolveEntry(opts.name, {
    cwd: primary,
    repositoryId: repository.id,
  });
  if (!existing.ok && ['ambiguous-session-name', 'ambiguous-legacy-session'].includes(existing.reason)) {
    console.error(`mc: ${formatEntryResolutionError(opts.name, existing)}`);
    return 1;
  }
  const existingEntry = existing.ok ? existing.entry : null;
  if (existingEntry && !existingEntry.repository_id) {
    console.error(`mc: session "${opts.name}" has unresolved legacy repository identity; registry state was preserved`);
    return 1;
  }
  if (existingEntry && existingEntry.worktree_missing !== true) {
    console.error(`mc: a worktree named "${opts.name}" already exists`);
    return 1;
  }

  const branch = `sess/${opts.name}`;
  if (branchExists(primary, branch)) {
    console.error(`mc: branch "${branch}" already exists`);
    return 1;
  }

  // Create the branch off --from (or HEAD).
  const fromRef = opts.from || 'HEAD';
  try {
    git(primary, ['branch', branch, fromRef]);
  } catch (err) {
    console.error(`mc: failed to create branch ${branch}: ${err.message}`);
    return 1;
  }

  const registry = readRegistry();
  const baseSlug = repoSlug(primary);
  const collide = registry.entries.some((entry) => (
    entry?.repo_slug === baseSlug
      && entry?.repository_id
      && entry.repository_id !== repository.id
  ));
  const slug = repoSlug(primary, { collide, repositoryId: repository.id });
  const wt = worktreePath(primary, opts.name, { collide, repositoryId: repository.id });
  mkdirSync(dirname(wt), { recursive: true });
  try {
    git(primary, ['worktree', 'add', wt, branch]);
  } catch (err) {
    // Best-effort branch rollback so we don't leave dead refs.
    try { git(primary, ['branch', '-D', branch]); } catch {}
    console.error(`mc: failed to add worktree: ${err.message}`);
    return 1;
  }

  const toolResolution = await resolveToolForNew({
    flagValue: opts.tool,
    configLoader: () => readEffectiveConfigForNew({ primary }),
  });
  if (toolResolution.error) {
    console.error(`mc: ${toolResolution.error}`);
    try { git(primary, ['worktree', 'remove', wt, '--force']); } catch {}
    try { git(primary, ['branch', '-D', branch]); } catch {}
    return 2;
  }

  const entry = upsertEntry({
    name: opts.name,
    ...(existingEntry?.session_id ? { session_id: existingEntry.session_id } : {}),
    repository_id: repository.id,
    repository_identity: repositoryIdentityProjection(repository),
    branch,
    worktree_path: wt,
    repo_slug: slug,
    primary_worktree: primary,
    kind: 'work',
    tool: toolResolution.tool,
    model_chain: [],
    session_state: 'no-session-yet',
    dirty_files: 0,
    ahead: 0,
    behind: 0,
    open_question: false,
    safety_verdict: 'SAFE_TO_END',
    coding_session_id: null,
    tool_session_id: null,
    tool_session_source: null,
    tool_transcript_path: null,
    tool_session_provider_adapter: null,
    tool_session_provider_generation: null,
    provider_sessions: null,
    session_objective: opts.task ? { text: opts.task, authority: 'explicit' } : null,
    focus: opts.task || null,
    provider_session_id: null,
    llm_session_id: null,
    broker_socket_path: null,
    host_kind: null,
    worktree_missing: false,
    last_storage_repair_at: null,
    last_storage_repair_reason: null,
    last_opened_at: new Date().toISOString(),
  });

  emitCd(wt, { enabled: emitDirectives || undefined });

  // §11d: on a successful `mc new`, ensure the sentinel exists. For
  // migrants (token in keychain from `memoro-cli login` before mc
  // setup existed) this is the silent upgrade path — next call to
  // any first-run-aware command skips the hint without ever having
  // shown one.
  ensureSentinel();

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      name: opts.name,
      session_id: entry.session_id,
      repository_id: entry.repository_id,
      branch,
      worktree_path: wt,
      tool: entry.tool,
      tool_source: toolResolution.source,
      from: opts.from || null,
      focus: opts.task || null,
    }, null, 2));
    return 0;
  }

  console.log(`mc: created worktree ${opts.name} at ${wt} (tool: ${entry.tool}, source: ${toolResolution.source})`);

  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') {
    return 0;
  }

  // Broker-owned process model: the local terminal becomes an attach
  // client, while the broker owns the PTY and sidecars. Closing the local
  // terminal detaches without killing the LLM session.
  return launchNewSession({
    entry,
    worktreePath: wt,
    focus: opts.task,
    apiArgv: argv,
    localAuthMode,
  });
}

export async function launchNewSession({
  entry,
  worktreePath,
  focus = null,
  apiArgv = [],
  env = process.env,
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  stderr = process.stderr,
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    stderr.write(`mc: ${authMode?.error || 'local auth mode unavailable'}\n`);
    return 1;
  }

  const launchTool = entry?.tool ? resolveToolInput(entry.tool) : null;
  if (localAuthMode === LOCAL_AUTH_MODES.NATIVE) {
    const materialise = deps.materialiseVaultBeforeLaunch
      || (await import('../vault/engine/startup.js')).materialiseVaultBeforeLaunch;

    try {
      const res = await materialise({
        sessionId: entry.legacy_session_key || entry.session_id || entry.name,
        worktreePath: worktreePath || undefined,
        adapters: launchTool?.adapter ? [launchTool.adapter] : undefined,
      });
      if (!res.ok && res.hint) {
        stderr.write(`mc: ${res.hint}\n`);
      }
    } catch (err) {
      stderr.write(`mc: vault materialise failed (${err.message}); continuing without tokens\n`);
    }
  }

  // Mint the native tool session id up front when the adapter supports
  // it (claude). The id travels to the tool as launch argv and into the
  // registry on the launch commit, so open/end never depend on post-hoc
  // transcript discovery for these sessions.
  const minted = (deps.mintToolSessionForLaunch || mintToolSessionForLaunch)({
    launchTool,
    localAuthMode,
  });

  const launch = deps.launchBrokerOwnedSession || launchBrokerOwnedSession;
  const result = await launch({
    ...buildNewSessionLaunchIntent({
      entry,
      worktreePath,
      focus,
      launchTool,
      apiArgv,
      env,
      localAuthMode,
      argv: minted?.argv || [],
    }),
    mintedToolSessionId: minted?.sessionId || null,
    stderr,
    onLaunched: ({ codingSessionId, brokerSocketPath = null, hostKind = null }) => {
      const upsert = deps.upsertEntry || upsertEntry;
      const patch = {
        name: entry.name,
        ...(entry.session_id ? { session_id: entry.session_id } : {}),
        ...(entry.repository_id ? { repository_id: entry.repository_id } : {}),
        coding_session_id: codingSessionId,
        session_state: 'live',
        ...(minted
          ? {
              tool_session_id: minted.sessionId,
              tool_session_source: minted.source,
            }
          : {}),
      };
      if (brokerSocketPath) patch.broker_socket_path = brokerSocketPath;
      if (hostKind) patch.host_kind = hostKind;
      upsert(patch);
    },
    deps: deps.launchDeps || {},
  });
  if (typeof result === 'number') return result;
  return result?.code ?? 0;
}

/**
 * Sugar flags that select a tool without `--tool <x>`. `--tool` is the
 * canonical form; these map 1:1 to short names. Exported so the launcher
 * arg-parsing stays testable in-process (Pattern 4).
 */
export const TOOL_SUGAR = {
  '--claude': 'claude',
  '--codex': 'codex',
  '--gemini': 'gemini',
};

export function parseArgs(argv) {
  const opts = {
    name: null,
    task: null,
    from: null,
    tool: null,
    noLaunch: false,
    json: false,
    // Named lifecycle launches use managed custody by default. Keep accepting
    // --managed-portable as a no-op compatibility spelling for older scripts.
    // `--native` is the explicit opt-out below: the user chooses the weaker
    // container deliberately; no failed gate may ever select it for them.
    managedPortable: true,
  };
  const positionals = [];
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!positionalOnly && a === '--') {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly) {
      positionals.push(a);
      continue;
    }
    if (a === '--from') { opts.from = argv[++i]; continue; }
    if (a === '--tool') { opts.tool = argv[++i]; continue; }
    if (Object.prototype.hasOwnProperty.call(TOOL_SUGAR, a)) {
      // `--codex` / `--claude` are sugar over `--tool <x>`. Reject a
      // conflicting explicit `--tool` rather than silently picking one.
      if (opts.tool && opts.tool !== TOOL_SUGAR[a]) {
        return { error: `conflicting tool flags: --tool ${opts.tool} and ${a}` };
      }
      opts.tool = TOOL_SUGAR[a];
      continue;
    }
    if (a === '--no-launch') { opts.noLaunch = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--managed-portable') { opts.managedPortable = true; continue; }
    if (a === '--native') { opts.managedPortable = false; continue; }
    if (a.startsWith('-')) { return { error: `unknown flag: ${a}` }; }
    positionals.push(a);
  }
  // <name> is the first positional. Any remaining words form the optional
  // <task> — the soft grounding focus. We join them so `mc new fix-x grab
  // the flaky test` works without quotes, matching the free-form intent of
  // a focus pointer (it's never parsed as a flag or a name).
  opts.name = positionals[0] ?? null;
  if (positionals.length > 1) opts.task = positionals.slice(1).join(' ');
  return opts;
}

function printUsage() {
  console.error('Usage: mc new <name> [<task>] [--from <ref>] [--tool claude|codex|gemini | --claude | --codex] [--native] [--no-launch] [--json]');
}
