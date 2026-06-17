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
import { findEntry, upsertEntry } from '../registry.js';
import { worktreePath } from '../paths.js';
import { git, isInsideRepo, primaryWorktree, branchExists } from '../git.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { checkAndPrintFreshInstall, ensureSentinel } from '../first-run.js';
import { resolveToolInput } from '../../adapters/index.js';
import { DEFAULT_TOOL, readConfig } from '../../lib/config.js';
import { launchBrokerOwnedSession } from '../broker/launch-client.js';
import { readRepoLocalConfig, readRepoPolicyConfig, resolveEffectiveConfig } from '../config-model.js';
import { buildNewSessionLaunchIntent } from '../session-intent.js';

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

  if (findEntry(opts.name)) {
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

  const wt = worktreePath(primary, opts.name);
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
    branch,
    worktree_path: wt,
    repo_slug: wt.split('/worktrees/')[1]?.split('/')[0] || null,
    primary_worktree: primary,
    kind: 'work',
    tool: toolResolution.tool,
    model_chain: [],
    session_state: 'no-session-yet',
    safety_verdict: 'SAFE_TO_END',
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
  });
}

export async function launchNewSession({
  entry,
  worktreePath,
  focus = null,
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
      worktreePath: worktreePath || undefined,
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
    ...buildNewSessionLaunchIntent({
      entry,
      worktreePath,
      focus,
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

function parseArgs(argv) {
  const opts = { name: null, task: null, from: null, tool: null, noLaunch: false, json: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
    if (a.startsWith('--')) { return { error: `unknown flag: ${a}` }; }
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
  console.error('Usage: mc new <name> [<task>] [--from <ref>] [--tool claude|codex|gemini | --claude | --codex] [--no-launch] [--json]');
}
