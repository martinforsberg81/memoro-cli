#!/usr/bin/env node
/**
 * mc — Memoro for developers.
 *
 * The terminal coordinator. Two modes:
 *
 *   mc                          # wrap the default coding tool in a PTY this
 *                                 process owns,
 *                                 pipe it to your terminal, register the
 *                                 session with Memoro for cross-session
 *                                 dispatch.
 *   mc sessions list            # show your active coding sessions across
 *                                 machines.
 *   mc sessions send <id> <msg> # dispatch a message into another session
 *                                 (lands as if the user typed it there).
 *   mc sessions read <id>       # fetch the recent transcript of another
 *                                 session.
 *   mc sessions stop <id>       # stop a broker-owned LLM process.
 *   mc sessions remove <id>     # remove a broker session from inventory.
 *
 * The wrapper holds:
 *   - a node-pty child running the selected coding tool, piped transparently
 *     to/from this process's TTY (so your terminal's native scrollback works)
 *   - a Unix-domain dispatch socket for local senders
 *   - a WebSocket to Memoro's UserSession DO for remote `dispatch_message`
 *     and `fetch_transcript` commands
 *
 * Dispatches land by writing to the PTY's input stream, which delivers the
 * bytes to the selected tool's stdin as if the user had typed them.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync, chmodSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostname } from 'node:os';

import { getSecret } from './lib/keychain.js';
import { ACCOUNTS } from './commands/auth.js';
import { readConfig, getApiUrl } from './lib/config.js';
import { memoroFetch } from './lib/api.js';
import { needsDeviceAuth, runDeviceFlow } from './lib/device-flow.js';
import { getRepoContext, deriveRepoName } from './lib/git-context.js';
import { lookupOrMint } from './lib/coding-session.js';
import { CliWsClient } from './commands/ws-client.js';
import { ensureCoordinatorSlashCommand } from './mc/coordinator-command.js';
import { installUpdateCommand } from './adapters/claude-code.js';
import { extractExcerpt } from './mc/session-excerpt.js';
import { primaryWorktree } from './mc/git.js';
import { findEntry, upsertEntry } from './mc/registry.js';
import {
  materialiseVaultForWrap,
  resolvePolicyForWrap,
  resolveRequestedToolForWrap,
  resolveWrapFocus,
  startupMessageFromGroundingParts,
} from './mc/wrap-start.js';
import { createStartupMessageController } from './mc/wrap-startup-message.js';
import {
  buildHeartbeatBase,
  buildHeartbeatPayload,
  buildSessionMeta,
  buildWrapExitRegistryPatch,
  buildWrapStartRegistryPatch,
  resolveCodingSessionIdForWrap,
  wrapRuntimePaths,
} from './mc/wrap-runtime.js';
import { createDispatchSocketServer } from './mc/wrap-dispatch.js';
import { createWrapWsHandlers } from './mc/wrap-ws.js';
import { scheduleSessionUpload } from './mc/session-upload.js';
import { writeToPty } from './mc/pty-write.js';
import { requestBroker } from './mc/broker/client.js';
import {
  listLocalBrokerAndHostSessions,
  requestForSession,
} from './mc/broker/session-hosts.js';
import { normalizeInteractivePtyEnv } from './mc/interactive-env.js';
import { renderIntro as renderSessionIntro } from './mc/session-intro.js';
import { SessionProjectionTracker } from './mc/session-projector.js';
import {
  buildSessionListView,
  fetchActiveCodingSessionsWithLocalBroker,
  renderSessionListHuman,
} from './mc/session-list.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MC_DIR = join(homedir(), '.memoro', 'mc');

const TICK_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;
const SUBMIT_ENTER_DELAY_MS = 150;

// Raw PTY bytes kept for excerpt extraction. ANSI escapes typically
// strip down to ~30–50%, so 4 KiB raw yields plenty of clean text to
// slice the trailing 500 chars from (server's EXCERPT_MAX).
const OUTPUT_BUFFER_BYTES = 4096;
const EXCERPT_MAX_CHARS = 500;
const STARTUP_MESSAGE_IDLE_MS = 1500;

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

// Lifecycle subcommands → src/mc/commands/<name>.js (lazy-loaded so the
// hot path of `mc` wrap-mode boot doesn't pay for them).
const LIFECYCLE = {
  new:           () => import('./mc/commands/new.js'),
  spawn:         () => import('./mc/commands/spawn.js'),
  list:          () => import('./mc/commands/list.js'),
  end:           () => import('./mc/commands/end.js'),
  rename:        () => import('./mc/commands/rename.js'),
  cd:            () => import('./mc/commands/cd.js'),
  open:          () => import('./mc/commands/open.js'),
  resume:        () => import('./mc/commands/resume.js'),
  gc:            () => import('./mc/commands/gc.js'),
  status:        () => import('./mc/commands/status.js'),
  dev:           () => import('./mc/commands/dev.js'),
  deps:          () => import('./mc/commands/deps.js'),
  dispatch:      () => import('./mc/commands/dispatch.js'),
  read:          () => import('./mc/commands/read.js'),
  'install-shell': () => import('./mc/commands/install-shell.js'),
  auth:          () => import('./mc/commands/auth.js'),
  github:        () => import('./mc/commands/github.js'),
  setup:         () => import('./mc/commands/setup.js'),
  reconcile:     () => import('./mc/commands/reconcile.js'),
  doctor:        () => import('./mc/commands/doctor.js'),
  storage:       () => import('./mc/commands/storage.js'),
  vault:         () => import('./mc/commands/vault.js'),
  'tool-auth':   () => import('./mc/commands/tool-auth.js'),
  adapter:       () => import('./mc/commands/adapter.js'),
  'tool-switch': () => import('./mc/commands/tool-switch.js'),
  'coding-profile': () => import('./mc/commands/coding-profile.js'),
  broker:        () => import('./mc/commands/broker.js'),
  attach:        () => import('./mc/commands/attach.js'),
  'cloud-session': () => import('./mc/commands/cloud-session.js'),
  'cloud-runtime': () => import('./mc/commands/cloud-runtime.js'),
  supervisor:    () => import('./mc/commands/supervisor.js'),
  fanout:        () => import('./mc/commands/fanout.js'),
  gather:        () => import('./mc/commands/gather.js'),
};

async function main() {
  // The shell wrapper installed by `mc install-shell` appends
  // --emit-shell-directives to every invocation. Strip it once at
  // the dispatcher so individual commands don't need to know about
  // it; expose the enabled state via MC_EMIT_SHELL_DIRECTIVES env so
  // shell-directives.emitCd can pick it up by default.
  const rawArgv = process.argv.slice(2);
  const stripped = [];
  let directivesEnabled = false;
  for (const a of rawArgv) {
    if (a === '--emit-shell-directives') { directivesEnabled = true; continue; }
    stripped.push(a);
  }
  if (directivesEnabled) process.env.MC_EMIT_SHELL_DIRECTIVES = '1';
  const argv = stripped;

  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printHelp();
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(await packageVersion());
    return 0;
  }

  // §14 — fresh-install path: when no Memoro token is stored AND the user
  // is on a real TTY (not CI / not a test), kick off the OAuth Device
  // Flow before dispatching the original command. After a successful
  // flow we exit 0 and ask the user to re-run their command — the
  // device-code is opaque to the rest of mc and re-dispatching is fancy.
  // Bypass list (help/version, `mc auth memoro`, `mc auth devices`) lives
  // inside shouldTriggerDeviceFlow.
  if (await needsDeviceAuth({ argv })) {
    const apiUrl = getApiUrl(argv) || (await readConfig()).apiUrl;
    return runDeviceFlow({ apiUrl });
  }

  await maybeRunStartupRuntimeGc(argv);

  if (argv[0] === 'sessions') {
    const sub = argv[1];
    const rest = argv.slice(2);
    if (sub === 'list')        return runSessionsList(rest);
    if (sub === 'watch') {
      const mod = await import('./mc/commands/sessions-watch.js');
      return mod.run(rest);
    }
    if (sub === 'send')        return runSessionsSend(rest);
    if (sub === 'read')        return runSessionsRead(rest);
    if (sub === 'stop')        return runSessionsStop(rest);
    if (sub === 'remove' || sub === 'rm') return runSessionsRemove(rest);
    console.error(`Unknown sessions subcommand: ${sub ?? '<missing>'}`);
    printHelp();
    return 2;
  }

  // Lifecycle dispatch.
  if (Object.prototype.hasOwnProperty.call(LIFECYCLE, argv[0])) {
    const loader = LIFECYCLE[argv[0]];
    const mod = await loader();
    return mod.run(argv.slice(1));
  }

  // `mc wrap <label> [args...]` — tag a wrapped coding-tool session in the
  // current cwd with a friendly label. This is the old `mc new <label>`
  // semantics; the new lifecycle `mc new <name>` owns that verb now.
  if (argv[0] === 'wrap') {
    const label = argv[1];
    const rest = argv.slice(2);
    const v = validateLabel(label);
    if (!v.ok) {
      console.error(`mc: ${v.error}`);
      return 2;
    }
    return runWrap(rest, { label });
  }

  // Default: wrap the configured coding tool (no label, current cwd).
  return runWrap(argv);
}

/**
 * Allowed label characters keep things shell- and url-safe and rule
 * out leading dashes (so it can't masquerade as a flag).
 * Exported for tests.
 */
export function validateLabel(label) {
  if (typeof label !== 'string' || !label) {
    return { ok: false, error: 'label required: `mc new <label> [args...]`' };
  }
  if (label.length > 32) {
    return { ok: false, error: 'label must be ≤ 32 chars' };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(label)) {
    return { ok: false, error: 'label must match /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/' };
  }
  return { ok: true };
}

export function shouldRefuseBareMcInPrimaryWorktree({
  cwd,
  primary,
  env = process.env,
} = {}) {
  if (!cwd || !primary) return false;
  if (env.MC_SESSION_NAME) return false;
  const norm = (p) => {
    const s = String(p).replace(/\/+$/, '');
    return process.platform === 'darwin' && s.startsWith('/private/')
      ? s.slice('/private'.length)
      : s;
  };
  const current = norm(cwd);
  const root = norm(primary);
  return current === root || current.startsWith(`${root}/`);
}

export function shouldRunStartupRuntimeGc(argv = []) {
  const cmd = argv[0] || null;
  if (!cmd) return true;
  return cmd === 'wrap' || ['new', 'open', 'resume', 'attach'].includes(cmd);
}

async function maybeRunStartupRuntimeGc(argv) {
  if (!shouldRunStartupRuntimeGc(argv)) return;
  try {
    const [
      { maybeRunAutomaticRuntimeGc },
      { resolveStoragePolicy },
    ] = await Promise.all([
      import('./mc/storage-runtime-gc.js'),
      import('./mc/storage-policy.js'),
    ]);
    const config = await readConfig();
    await maybeRunAutomaticRuntimeGc({
      policy: resolveStoragePolicy({ config }),
    });
  } catch {
    // Startup cleanup is opportunistic. Explicit `mc storage` / `mc gc`
    // commands surface details when the user wants diagnostics.
  }
}

function printHelp() {
  console.log(`mc — grounded coding sessions

USAGE
  mc                              Start the default grounded coding tool here
  mc new <name> [focus]           Create worktree + branch + start a session
  mc spawn <name> "<brief>"       Create an idle tracked project session
  mc open                         List mc sessions available to open
  mc open <name>                  Open an existing session

COMMON
  mc list [--rich|--awaiting]     Show local sessions
  mc list --tree                  Show coordinator/project session tree
  mc status <name>                Show one session's state
  mc dev plan [service] [--profile <name>]
                                  Validate and show this worktree's dev plan
  mc dev list [--json]            Show machine-local dev servers
  mc dev status|logs <session>    Inspect one session's dev server
  mc dev stop|restart <session>   Run verified project-owned controls
  mc deps status|hydrate [service]
                                  Inspect or explicitly hydrate dependencies
  mc cd <name>                    cd into a session worktree
  mc end [<name>...]              End last-opened/current session or named sessions
  mc rename <old> <new>           Rename branch + worktree + registry entry

START OPTIONS
  mc new <name> [focus] --codex   Start the new session under Codex
  mc new <name> [focus] --claude  Start the new session under Claude Code
  mc new <name> [focus] --tool <claude|codex|gemini>
  mc new <name> --from <ref>      Branch from a ref other than HEAD
  mc open <name> --codex          Use Codex only before first launch or for Codex sessions
  mc open <name> --claude         Use Claude Code only before first launch or for Claude sessions

SETUP
  mc                              First run signs in to Memoro with browser device auth
  mc setup [--json]               Verify setup; choose local heavy-job limits on a TTY
  mc setup --resource-profile <unlimited|balanced|conservative|custom>
                                  Configure image/motion resource protection
  mc setup --resource-profile custom --heavy-max-concurrent <n>
           --heavy-max-threads <n> --heavy-max-rss-mb <n>
           --heavy-max-swap-mb <n> --heavy-min-free-disk-gb <n>
                                  Configure every custom safeguard
  mc setup --dependency-mode <auto|isolated|off>
                                  Choose snapshot reuse, worktree-only, or off
  mc install-shell                Install auto-cd support for zsh/bash
  mc auth status [--json]         Check Memoro + coding-tool auth
  mc auth memoro                  Token login/logout for CI or headless setup
  mc auth devices                 List/revoke Memoro device tokens
  mc github status [--json]       Check this repo via the Memoro GitHub App
  mc github connect [--json]      Start the central GitHub connection flow
  mc github repos [--json]        List selected GitHub repositories
  mc auth github [--json]         Alias for mc github status
  mc auth <claude|codex|gemini>   Re-check one coding tool
  mc tool-switch <tool>           Set the default tool for future sessions
  mc coding-profile read|diff|write
                                  Read, compare, or update your Coding Profile

SECRETS
  mc vault status                 Show vault setup + lock state
  mc vault setup                  Create a Memoro-account token vault
  mc vault unlock                 Unlock and cache the vault key briefly
  mc vault scan [file...]         Scan dotenv files for import candidates
  mc vault import <file>           Import dotenv secrets into the vault
  mc vault import <file> --dry-run Preview value-free import bindings
  mc vault set <label>            Store a secret
  mc vault list                   List secret labels, never values
  mc vault get <label>            Print a secret value, with confirmation
  mc vault rm|rotate|lock         Manage stored secrets
  mc tool-auth hydrate|persist    Internal cloud tool auth vault bridge

FLEET / ADVANCED
  mc spawn <name> "<brief>"       Create durable child project session
  mc fanout <plan.md>             Create one idle session per plan phase
  mc gather <plan-slug>           Merge phase PRs into a summary branch
  mc supervisor                   Open supervisor control prompt
  mc sessions list                List active sessions seen by Memoro
  mc sessions watch               Summarize local broker sessions for orchestration
  mc sessions send <label|id> <msg>
                                  Dispatch a message into another session
  mc sessions read <label|id>     Fetch another session's recent transcript
  mc sessions stop <label|id>     Stop a broker-owned session
  mc sessions remove <label|id>   Remove a broker session from inventory
  mc reconcile [--apply]          Detect sessions shipped elsewhere
  mc doctor                       Diagnose local mc memory/storage state
  mc storage status|candidates    Inspect local runtime/worktree storage
  mc storage repair [name] --dry-run|--apply
                                  Preview/apply safe local metadata repairs
  mc storage repair <name> --provider-backfill --apply
                                  Backfill a provider-native resume id
  mc storage prune-missing --dry-run|--apply
                                  Prune missing registry tombstones after 7d
  mc storage prune-deps --dry-run|--apply
                                  Prune old inactive worktree node_modules
  mc storage prune-generated --dry-run|--apply
                                  Prune old ignored build/cache directories
  mc gc [--dry-run]               Reap registry-dead, merged, clean worktrees
  mc gc --runtime                 Reap stale runtime pid/socket sidecars
  mc gc --stale-worktrees --only <names>
                                  Reap only named clean, merged worktrees
  mc gc --sidecars                Reap stale hosts/guard-bin runtime sidecars
  mc gc --all-safe --dry-run      Preview runtime + clean merged worktree cleanup
  mc broker start/status/stop     Local PTY broker admin
  mc broker connect               Connect local broker to Memoro cloud
  mc attach <session_id>          Attach to a broker-owned local session
  mc cloud-session start          Internal typed cloud mc runtime
  mc cloud-runtime run            Internal cloud sandbox runtime supervisor
  mc adapter sync                 Refresh tool instruction wrappers
  mc adapter materialise          Copy mc's coordinator canon into this repo
  mc wrap <label> [args...]       Start an in-place labelled wrapper session

COMMAND SURFACES
  Terminal commands manage machines and sessions: setup, auth, new, open,
  end, broker, vault, and repo/worktree lifecycle.

  Inside a launched LLM session, use explicit mc commands for durable working
  method updates, such as \`mc coding-profile read\`, \`mc coding-profile diff\`,
  and \`mc coding-profile write\`.
  Do not treat terminal setup/lifecycle commands as in-session instructions.
  The workflow stays the same across Codex, Claude Code, and future adapters;
  tool-specific slash commands are conveniences, not the main path.

NEW USER FLOW
  1. Install: \`npm install -g memoro-cli\`
  2. Sign in: run \`mc\` and approve the browser device flow
  3. Connect GitHub: \`mc github connect\` uses the central Memoro GitHub App
  4. Verify: \`mc setup\` checks readiness and offers optional resource limits
  5. Start: from a git repo, run \`mc new <name> [focus]\`

WHAT HAPPENS ON START
  Fresh starts (\`mc\`, \`mc new\`) inject project grounding before the
  coding tool wakes: compact User Profile and Coding Profile context when
  available, mc session identity/repo metadata, plus the current focus. mc does
  not create or read a repo-local MEMORO.md in the normal startup path. If the
  vault is locked, mc can offer to unlock it before launch so tokens materialise
  for the tool.

  \`mc open\` first attaches to a live broker-owned PTY when one exists,
  preserving that session surface without sending a new prompt. If no
  local live PTY is attachable, mc relaunches the same provider-native
  session by id. If mc cannot find that provider session id, it refuses to
  start a contextless replacement. Idle tracked sessions that have never
  launched start as fresh grounded sessions on first open.

TOOL SELECTION
  \`mc tool-switch <tool>\` changes the default for future bare \`mc\` and
  \`mc new\` starts. It does not change a running session. Tool flags on
  \`mc open <name>\` cannot switch provider for an existing provider
  session; use \`mc new\` for a new tool conversation.

  When a live broker PTY exists, \`mc open <name>\` and its tool-flag
  variants attach to that running session as-is instead of starting a
  duplicate.

  \`mc open\` lists mc's own registry sessions across tools and then calls
  the selected tool's native resume-by-id path directly, without opening
  Claude or Codex pickers.

  \`mc resume\` remains as a compatibility alias for existing scripts.

SESSION NAMES
  \`mc new <name>\` creates a local session name. Use that same name with
  \`mc open\`, \`mc status\`, \`mc cd\`, \`mc rename\`, and \`mc end\`.

REQUIREMENTS
  - Run inside a git repository.
  - Install Codex CLI for the default path, or Claude Code if selected.
  - Authenticate with Memoro: run \`mc\` for device login, or
    \`memoro-cli login\` for CI/headless use.

HELP
  mc <command> --help                Show command-specific usage
  mc --version                       Print version
`);
}

async function packageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrap mode — the main mc experience
// ─────────────────────────────────────────────────────────────────────────────

async function runWrap(argv, { label = null } = {}) {
  const config = await readConfig();

  // ─── Resolve the tool to launch (adapter-routed) ─────────────────────
  // Default is Codex; `mc new --tool` and `mc open --tool` thread
  // the chosen tool across the wrap-mode re-exec via MC_GROUNDING_TOOL.
  // The launch spec carries the
  // binary to spawn, how to map argv, and the heartbeat source. Unknown /
  // unimplemented / not-installed tools fail HIGH here (exit-before-side-
  // effect) — never a silent no-op spawning the wrong binary.
  const { resolveLaunch } = await import('./adapters/index.js');
  const requestedTool = resolveRequestedToolForWrap({ env: process.env, config });
  const launch = resolveLaunch(requestedTool);
  if (!launch.ok) {
    console.error(`mc: cannot launch "${requestedTool}": ${launch.hint}`);
    process.exit(1);
  }
  const launchSpec = launch.spec;
  const launchAdapter = launch.adapter;
  const launchToolId = launch.id;

  preflight(launchSpec.bin);
  const ptyModule = await import('node-pty');
  const pty = ptyModule.default || ptyModule;

  if (!existsSync(MC_DIR)) {
    mkdirSync(MC_DIR, { recursive: true, mode: 0o700 });
  }
  // Refresh managed Claude Code slash commands on every mc launch — pushes
  // updated bodies (coordinator prompts, update recipe) to existing
  // installs without requiring `memoro-cli hook install`. Claude-only:
  // these write into ~/.claude/commands, which codex doesn't read.
  if (launchToolId === 'claude-code') {
    await ensureCoordinatorSlashCommand();
    await installUpdateCommand().catch(() => { /* best effort */ });
  }

  const cwd = process.cwd();
  const effectivePolicy = resolvePolicyForWrap({
    sessionName: process.env.MC_SESSION_NAME || null,
    cwd,
    tool: launch.shortName,
    config,
  });
  const repoContext = await getRepoContext(cwd);
  if (!repoContext) {
    console.error('mc: not inside a git repository. Coordinator is gated on repos.');
    console.error('mc: run from inside a git repo, or use the coding tool directly for ad-hoc work.');
    process.exit(1);
  }
  const primary = primaryWorktree(cwd);
  if (shouldRefuseBareMcInPrimaryWorktree({
    cwd,
    primary,
    env: process.env,
    label,
  })) {
    console.error('mc: refusing to start a coding session in the primary worktree.');
    console.error('mc: use `mc new <name> [focus] --codex` to create an isolated worktree,');
    console.error('mc: or `mc open <name> --codex` to open an existing session.');
    process.exit(1);
  }

  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    // Reachable when MC_TEST_MODE=1 (device-flow auto-trigger skipped) or
    // when the user wipes the keychain mid-session. The user-friendly
    // path is "just run mc on a real TTY"; CI keeps memoro-cli login.
    console.error('mc: no Memoro token. Run `mc` on a real TTY to start the device flow, or `memoro-cli login` for CI.');
    process.exit(1);
  }

  const sessionName = process.env.MC_SESSION_NAME || null;
  const runtimeLabel = sessionName || label;
  const machineId = hostname();
  const registryEntry = sessionName ? findEntry(sessionName) : null;
  const { codingSessionId } = await resolveCodingSessionIdForWrap({
    sessionName,
    registryEntry,
    repoIdentity: repoContext.remoteUrl,
    machineId,
    lookupOrMint,
  });
  if (sessionName) {
    try {
      upsertEntry(buildWrapStartRegistryPatch({
        sessionName,
        codingSessionId,
        tool: launch.shortName,
        heartbeatSource: launchSpec.heartbeatSource,
        repoContext,
        cwd,
        machineId,
        pid: process.pid,
      }));
    } catch (err) {
      process.stderr.write(`mc: registry live-state update failed (${err.message}); continuing\n`);
    }
  }

  let wrapVault = { sessionId: null, shouldShredOnExit: false };
  try {
    wrapVault = await materialiseVaultForWrap({
      codingSessionId,
      cwd,
      launchAdapter,
    });
  } catch (err) {
    process.stderr.write(`mc: vault materialise failed (${err.message}); continuing without tokens\n`);
  }

  const { sockPath, metaPath } = wrapRuntimePaths({ mcDir: MC_DIR, codingSessionId });
  const repoName = deriveRepoName(repoContext);

  writeFileSync(metaPath, JSON.stringify(buildSessionMeta({
    codingSessionId,
    label: runtimeLabel,
    sockPath,
    repoContext,
    cwd,
    pid: process.pid,
    tool: launch.shortName,
    source: launchSpec.heartbeatSource,
    toolSessionId: registryEntry?.tool_session_id || null,
    transcriptPath: registryEntry?.tool_transcript_path || null,
  }), null, 2), { mode: 0o600 });

  // ─── Grounding (Phase 1) — pre-launch slot ──────────────────────────────
  // Ground the session BEFORE spawning the tool: assemble
  // { profile context + optional role/focus } and hand it to the selected adapter.
  // Adapters deliver it without mutating tracked project wrappers:
  // Claude via launch args, Codex as the initial prompt. Soft-degrade:
  // any failure prints a one-line hint and continues — grounding must
  // never block the launch.
  let groundingLaunchMessage = null;
  let startupMessage = null;
  try {
    const { groundSession } = await import('./mc/ground.js');
    // Route grounding through the SAME adapter the launcher picked. The
    // bundle itself is tool-agnostic; only the adapter delivery changes.
    const adapter = launchAdapter;
    // Focus precedence: the per-session `mc wrap <label>` tag, else the
    // `<task>` `mc new` threaded across the re-exec via MC_GROUNDING_FOCUS.
    // Both are soft standing-context pointers — never an opening prompt.
    // This is the SAME seam bare `mc`, `mc new`, and `mc resume` share
    // (new/resume re-exec into this runWrap), so entry-parity is one path.
    const focus = resolveWrapFocus({ label, env: process.env });
    const res = await groundSession({
      cwd,
      adapter,
      focus,
      repoContext,
      tool: launch.shortName,
      codingSessionId,
      sessionName: runtimeLabel,
      deps: {
        grounding: config.grounding,
        mcContextDeps: { apiUrl, token },
      },
    });
    groundingLaunchMessage = res.message || null;
    startupMessage = startupMessageFromGroundingParts(res.parts);
    if (!res.ok && res.reason) {
      process.stderr.write(`mc: grounding skipped (${res.reason}); continuing\n`);
    }
  } catch (err) {
    process.stderr.write(`mc: grounding failed (${err.message}); continuing without it\n`);
  }

  // Print a short stylized intro BEFORE handing the TTY to Claude. The
  // intro lands in the terminal's scrollback above Claude's TUI, so the
  // user can scroll up to find the session id whenever they need it.
  process.stderr.write(renderIntro({
    version: await packageVersion(),
    codingSessionId,
    repo: repoName,
    branch: repoContext.branch,
    label: runtimeLabel,
    tool: launchSpec.label,
  }));

  // ─── Spawn the chosen tool in a PTY we own ───────────────────────────────
  const spawnArgs = launchSpec.args(argv, {
    startupMessage: groundingLaunchMessage,
    effectivePolicy,
  });
  startupMessage = resolveStartupMessageForLaunch({
    delivery: launchSpec.startupMessageDelivery,
    groundingLaunchMessage,
    fallbackStartupMessage: startupMessage,
  });
  const { resolveDevSessionEnvironment } = await import('./mc/dev-definition.js');
  const devEnvironment = await resolveDevSessionEnvironment({
    worktreePath: repoContext.toplevel,
    globalConfig: config,
  });
  let spawnEnv = {
    ...process.env,
    MEMORO_MC_PARENT: '1',  // hooks see this and no-op their heartbeat-loop
    MC_CODING_SESSION_ID: codingSessionId,
    ...(runtimeLabel ? { MC_SESSION_NAME: runtimeLabel } : {}),
    ...devEnvironment,
  };
  try {
    const { prepareLocalResourceGuardEnv } = await import('./mc/local-resource-guard.js');
    spawnEnv = prepareLocalResourceGuardEnv({
      baseEnv: spawnEnv,
      config,
      mcDir: MC_DIR,
      codingSessionId,
    }).env;
  } catch (err) {
    console.error(`mc: failed to install local resource guard (${err.message}); refusing to launch`);
    process.exit(1);
  }
  if (launchToolId === 'codex') {
    try {
      const { prepareCloudflareGuardEnv } = await import('./mc/cloudflare-guard.js');
      const {
        readRepoLocalConfig,
        readRepoPolicyConfig,
        resolveEffectiveConfig,
      } = await import('./mc/config-model.js');
      const repoPolicyConfig = readRepoPolicyConfig({ cwd });
      const repoLocalConfig = readRepoLocalConfig({ cwd });
      const effectiveConfig = resolveEffectiveConfig({
        globalConfig: config,
        repoPolicy: repoPolicyConfig.config,
        localConfig: repoLocalConfig.config,
        entry: registryEntry || {},
        warnings: [
          ...(repoPolicyConfig.warnings || []),
          ...(repoLocalConfig.warnings || []),
        ],
      });
      spawnEnv = prepareCloudflareGuardEnv({
        baseEnv: spawnEnv,
        mcDir: MC_DIR,
        codingSessionId,
        effectiveConfig,
      }).env;
    } catch (err) {
      console.error(`mc: failed to install Codex Cloudflare guard (${err.message}); refusing to launch`);
      process.exit(1);
    }
  }
  const interactiveEnv = normalizeInteractivePtyEnv({
    baseEnv: spawnEnv,
    termName: process.env.TERM,
  });
  spawnEnv = interactiveEnv.env;

  const runtimeStartedAt = Date.now();
  const uploadStartMs = runtimeStartedAt - 1000;
  const ptyProcess = pty.spawn(launchSpec.bin, spawnArgs, {
    name: interactiveEnv.termName,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd,
    env: spawnEnv,
  });

  // Pipe PTY output → user's terminal. Also:
  //   - stamp `lastOutputAt` so the heartbeat ticker can report idle vs
  //     active to peer coordinators
  //   - keep a rolling raw-output buffer so the heartbeat can carry a
  //     stripped excerpt of what Claude is currently showing (lets a peer
  //     coordinator spot e.g. "How should I proceed?" prompts at a
  //     glance, not just "session B has been idle 2m")
  let lastOutputAt = runtimeStartedAt;
  let lastInputAt = null;
  let outputBuffer = '';
  const projectionTracker = new SessionProjectionTracker({ cwd });
  const startupMessageController = createStartupMessageController({
    message: startupMessage,
    delayMs: STARTUP_MESSAGE_IDLE_MS,
    deliver: (message) => {
      writeToPty(ptyProcess, message, launchSpec);
    },
  });
  ptyProcess.onData((data) => {
    lastOutputAt = Date.now();
    outputBuffer += data;
    if (outputBuffer.length > OUTPUT_BUFFER_BYTES) {
      outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_BYTES);
    }
    process.stdout.write(data);
    startupMessageController.schedule();
  });

  // Pipe user's keystrokes → PTY input. Raw mode so each keystroke flows
  // through unmodified (no line buffering, no signal translation by the
  // line discipline — Claude sees Ctrl+C / arrows / etc. exactly as typed).
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    lastInputAt = Date.now();
    ptyProcess.write(data);
  });

  // Terminal resize → PTY resize, so Claude redraws to the new size.
  const onResize = () => {
    try {
      ptyProcess.resize(process.stdout.columns, process.stdout.rows);
    } catch { /* PTY closed */ }
  };
  process.stdout.on('resize', onResize);

  // ─── Dispatch socket (local nc senders + mc sessions send) ───────────────
  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch {}
  }
  const server = createDispatchSocketServer({
    deliver: (message) => {
      lastInputAt = Date.now();
      writeToPty(ptyProcess, message, launchSpec);
    },
  });
  server.listen(sockPath, () => {
    try { chmodSync(sockPath, 0o600); } catch {}
  });

  // ─── WS client (remote dispatch via Memoro server) ──────────────────────
  const wsClient = new CliWsClient({
    apiUrl,
    token,
    codingSessionId,
    handlers: createWrapWsHandlers({
      transcriptPath: null,
      source: launchSpec.heartbeatSource,
      deliver: (message) => {
        lastInputAt = Date.now();
        writeToPty(ptyProcess, message, launchSpec);
      },
    }),
    logger: silentLogger(),
  });
  wsClient.start();

  // ─── Heartbeat ticker ───────────────────────────────────────────────────
  let alive = true;
  const heartbeatBase = buildHeartbeatBase({
    codingSessionId,
    machineId,
    heartbeatSource: launchSpec.heartbeatSource,
    repoContext,
    label: runtimeLabel,
  });
  (async () => {
    while (alive) {
      const now = Date.now();
      await postHeartbeatWithRetry({
        apiUrl, token,
        payload: buildHeartbeatPayload({
          base: heartbeatBase,
          outputBuffer,
          lastOutputAt,
          now,
          excerptMax: EXCERPT_MAX_CHARS,
          extractExcerpt,
          sessionProjection: projectionTracker.runtime({
            session: {
              session_state: 'live',
              attachable: true,
              started_at: new Date(runtimeStartedAt).toISOString(),
              last_output_at: new Date(lastOutputAt).toISOString(),
              last_input_at: lastInputAt ? new Date(lastInputAt).toISOString() : null,
            },
            output: outputBuffer,
            now,
          }),
        }),
      });
      if (!alive) break;
      try { await sleep(TICK_INTERVAL_MS); } catch {}
    }
  })();

  // ─── Cleanup ─────────────────────────────────────────────────────────────
  let cleanedUp = false;
  const cleanup = async (exitCode = 0) => {
    if (cleanedUp) return;
    cleanedUp = true;
    alive = false;
    try { wsClient.stop(); } catch {}
    try { startupMessageController.cancel(); } catch {}
    try { server.close(); } catch {}
    try { unlinkSync(sockPath); } catch {}
    try { unlinkSync(metaPath); } catch {}
    process.stdout.removeListener('resize', onResize);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    try { process.stdin.pause(); } catch {}
    try { ptyProcess.kill(); } catch {}
    if (sessionName) {
      try {
        upsertEntry(buildWrapExitRegistryPatch({
          sessionName,
          codingSessionId,
          exitCode,
        }));
      } catch { /* best effort */ }
    }
    try {
      await scheduleSessionUpload({
        source: launchSpec.heartbeatSource,
        cwd,
        repoHint: repoName,
        codingSessionId,
        newerThanMs: uploadStartMs,
      });
    } catch (err) {
      process.stderr.write(`mc: session upload scheduling failed (${err.message}); continuing\n`);
    }
    if (wrapVault.shouldShredOnExit && wrapVault.sessionId) {
      try {
        const { shredForSession } = await import('./mc/vault/lifecycle.js');
        await shredForSession({ sessionId: wrapVault.sessionId });
      } catch { /* best effort */ }
    }
    process.exit(exitCode);
  };

  // When the selected tool exits (user types /exit, Ctrl+D etc.), tear down.
  ptyProcess.onExit(({ exitCode }) => {
    void cleanup(exitCode || 0);
  });

  // External signals: forward to the selected tool and let its exit drive cleanup.
  // (User's Ctrl+C is bytes through stdin in raw mode, not SIGINT to us.)
  process.on('SIGTERM', () => {
    try { ptyProcess.kill('SIGTERM'); } catch {}
  });
  process.on('SIGHUP', () => {
    try { ptyProcess.kill('SIGHUP'); } catch {}
  });

  // Resolve never — wait for ptyProcess exit to call process.exit().
  return new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// `mc sessions list`
// ─────────────────────────────────────────────────────────────────────────────

async function runSessionsList(_argv, deps = {}) {
  const activeRes = await fetchActiveCodingSessionsWithLocalBroker({
    argv: _argv,
    deps,
  });
  const sessions = activeRes.sessions || [];
  if (!activeRes.ok && sessions.length === 0) {
    console.error(`mc: ${activeRes.warning || 'active sessions unavailable'}`);
    return 1;
  }
  if (sessions.length === 0) {
    console.log('No active coding sessions.');
    return 0;
  }

  process.stdout.write(renderSessionsListForList(sessions));
  return 0;
}

export function renderSessionsListForList(sessions = []) {
  const view = buildSessionListView({
    activeSessions: sessions,
    localEntries: [],
  });
  return renderSessionListHuman({
    view,
    title: 'mc sessions:',
  });
}

/**
 * Fetch active sessions, resolve `identifier` (label or id) to a real id.
 * Returns null after logging a clear error if not found.
 */
async function resolveIdentifierToId(apiUrl, token, identifier) {
  // Skip the lookup if the identifier already looks like a real session id.
  if (/^sess_[a-zA-Z0-9_-]{6,}$/.test(identifier)) return identifier;

  let res;
  try {
    res = await memoroFetch(apiUrl, '/api/coding-sessions/active', { token });
  } catch (err) {
    console.error(`mc: failed to look up "${identifier}": ${err.message}`);
    return null;
  }
  const { id, matchedBy, collisions } = resolveSessionIdentifier(res?.sessions ?? [], identifier);
  if (!id) {
    console.error(`mc: no active session matches "${identifier}"`);
    return null;
  }
  if (matchedBy === 'label' && collisions > 1) {
    console.error(`mc: warning — ${collisions} active sessions share label "${identifier}"; using most recent (${id})`);
  }
  return id;
}

/**
 * Resolve an identifier (label or coding_session_id) to a coding_session_id
 * by listing active sessions. Returns null if no match. If multiple
 * sessions share a label, prefers the most-recently-received_at one and
 * warns to stderr. Exported for tests.
 */
export function resolveSessionIdentifier(sessions, identifier) {
  if (!identifier || !Array.isArray(sessions)) return { id: null };
  // Direct id match takes priority over label lookup.
  const direct = sessions.find(s => s.coding_session_id === identifier);
  if (direct) return { id: direct.coding_session_id, matchedBy: 'id' };
  const matches = sessions.filter(s => s.label === identifier);
  if (matches.length === 0) return { id: null };
  if (matches.length > 1) {
    matches.sort((a, b) => (b.received_at || '').localeCompare(a.received_at || ''));
    return { id: matches[0].coding_session_id, matchedBy: 'label', collisions: matches.length };
  }
  return { id: matches[0].coding_session_id, matchedBy: 'label' };
}

/**
 * Translate `idle_seconds` from a heartbeat into a human-readable
 * status: ACTIVE (output recent), IDLE Nm (output stale — likely
 * awaiting input). Exported for tests.
 */
export function formatStatus(idleSeconds) {
  if (typeof idleSeconds !== 'number' || idleSeconds < 0) return 'unknown';
  if (idleSeconds < 5) return 'ACTIVE';
  if (idleSeconds < 60) return `idle ${idleSeconds}s`;
  if (idleSeconds < 3600) return `idle ${Math.floor(idleSeconds / 60)}m`;
  return `idle ${Math.floor(idleSeconds / 3600)}h`;
}

// ─────────────────────────────────────────────────────────────────────────────
// `mc sessions send <id> <message>`
// ─────────────────────────────────────────────────────────────────────────────

async function runSessionsSend(argv) {
  const identifier = argv[0];
  const message = argv.slice(1).join(' ');
  if (!identifier || !message) {
    console.error('Usage: mc sessions send <label_or_session_id> <message>');
    return 2;
  }

  const local = await dispatchLocalBrokerSession(identifier, message).catch(() => null);
  if (local?.ok) {
    console.log(`✓ dispatched to ${local.id} via local broker`);
    return 0;
  }
  if (local?.partial) {
    console.error(`mc: local dispatch partially failed: ${local.error || 'unknown error'}`);
    return 1;
  }

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('mc: no Memoro token. Run `memoro-cli login` first.');
    return 1;
  }

  const sid = await resolveIdentifierToId(apiUrl, token, identifier);
  if (!sid) return 1;

  const enqueue = await memoroFetch(apiUrl, `/api/coding-sessions/${encodeURIComponent(sid)}/commands`, {
    token,
    method: 'POST',
    body: { kind: 'dispatch_message', args: { message } },
  }).catch(err => { console.error(`mc: ${err.message}`); return null; });
  if (!enqueue?.command_id) return 1;

  const result = await pollCommandResult(apiUrl, token, enqueue.command_id);
  if (result?.status === 'done') {
    console.log(`✓ dispatched to ${sid}`);
    return 0;
  }
  console.error(`mc: dispatch failed: ${result?.error || result?.status || 'no result'}`);
  return 1;
}

export async function dispatchLocalBrokerSession(identifier, message, { request = requestBroker, wait = sleep } = {}) {
  if (!identifier || !message) return { ok: false, skipped: true, error: 'identifier and message are required' };

  const inventory = await listLocalBrokerAndHostSessions({ request })
    .then((sessions) => ({ ok: true, sessions }))
    .catch(() => request({ type: 'sessions' }).catch(() => null));
  let sid = identifier;
  let matched = false;
  let session = null;

  if (inventory?.ok && Array.isArray(inventory.sessions)) {
    session = inventory.sessions.find((item) => localSessionMatches(item, identifier));
    if (!session) return { ok: false, skipped: true, error: 'local session not found' };
    sid = session.id || session.coding_session_id || identifier;
    matched = true;
  }
  const sessionRequest = requestForSession(session, { request });

  const raw = await writeLocalDispatchedInput({
    request: sessionRequest,
    wait,
    sessionId: sid,
    message,
    tool: session?.tool,
  });
  if (raw?.ok) {
    return {
      ok: true,
      id: sid,
      matched,
      transport: 'write_session',
    };
  }
  if (raw?.partial) return { ...raw, id: sid, matched };

  const dispatched = await sessionRequest({ type: 'dispatch_session', id: sid, message }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (dispatched?.ok) {
    return {
      ok: true,
      id: sid,
      matched,
      transport: dispatched.transport || 'dispatch_session',
    };
  }
  return { ok: false, skipped: true, id: sid, error: dispatched?.error || 'local dispatch failed' };
}

async function writeLocalDispatchedInput({ request, wait, sessionId, message, tool }) {
  const first = await request({ type: 'write_session', id: sessionId, data: `${message}\r` }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!first?.ok) return first;

  for (let i = 1; i < submitEnterCountForLocalTool(tool); i += 1) {
    await wait(SUBMIT_ENTER_DELAY_MS);
    const next = await request({ type: 'write_session', id: sessionId, data: '\r' }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!next?.ok) return { ...next, partial: true };
  }
  return { ok: true };
}

function submitEnterCountForLocalTool(tool) {
  return /^codex\b|^codex-/i.test(String(tool || '').trim()) ? 2 : 1;
}

function localSessionMatches(session, identifier) {
  if (!session || !identifier) return false;
  return session.id === identifier
    || session.coding_session_id === identifier
    || session.name === identifier
    || session.label === identifier
    || localWorktreeName(session.cwd) === identifier;
}

function localWorktreeName(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// `mc sessions read <id>`
// ─────────────────────────────────────────────────────────────────────────────

async function runSessionsRead(argv) {
  const identifier = argv[0];
  if (!identifier) {
    console.error('Usage: mc sessions read <label_or_session_id>');
    return 2;
  }

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('mc: no Memoro token. Run `memoro-cli login` first.');
    return 1;
  }

  const sid = await resolveIdentifierToId(apiUrl, token, identifier);
  if (!sid) return 1;

  const enqueue = await memoroFetch(apiUrl, `/api/coding-sessions/${encodeURIComponent(sid)}/commands`, {
    token,
    method: 'POST',
    body: { kind: 'fetch_transcript' },
  }).catch(err => { console.error(`mc: ${err.message}`); return null; });
  if (!enqueue?.command_id) return 1;

  const result = await pollCommandResult(apiUrl, token, enqueue.command_id);
  if (result?.status === 'done') {
    console.log(JSON.stringify(result.result, null, 2));
    return 0;
  }
  console.error(`mc: read failed: ${result?.error || result?.status || 'no result'}`);
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// `mc sessions stop/remove <id>`
// ─────────────────────────────────────────────────────────────────────────────

async function runSessionsStop(argv) {
  const opts = parseSessionsControlArgs(argv);
  if (opts.error || !opts.identifier) {
    console.error(opts.error || 'Usage: mc sessions stop <label_or_session_id> [--signal SIGTERM]');
    return 2;
  }
  return runSessionsControl({
    identifier: opts.identifier,
    kind: 'stop_session',
    localAction: 'stop',
    signal: opts.signal,
  });
}

async function runSessionsRemove(argv) {
  const opts = parseSessionsControlArgs(argv);
  if (opts.error || !opts.identifier) {
    console.error(opts.error || 'Usage: mc sessions remove <label_or_session_id>');
    return 2;
  }
  return runSessionsControl({
    identifier: opts.identifier,
    kind: 'remove_session',
    localAction: 'remove',
    signal: opts.signal,
  });
}

async function runSessionsControl({ identifier, kind, localAction, signal }) {
  const local = await controlLocalBrokerSession(identifier, { action: localAction, signal }).catch(() => null);
  if (local?.ok) {
    console.log(`✓ ${localAction === 'stop' ? 'stopped' : 'removed'} ${local.id} via local broker`);
    return 0;
  }

  const config = await readConfig();
  const apiUrl = getApiUrl([]) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('mc: no Memoro token. Run `memoro-cli login` first.');
    return 1;
  }

  const sid = await resolveIdentifierToId(apiUrl, token, identifier);
  if (!sid) return 1;

  const body = { kind, args: signal ? { signal } : {} };
  const enqueue = await memoroFetch(apiUrl, `/api/coding-sessions/${encodeURIComponent(sid)}/commands`, {
    token,
    method: 'POST',
    body,
  }).catch(err => { console.error(`mc: ${err.message}`); return null; });
  if (!enqueue?.command_id) return 1;

  const result = await pollCommandResult(apiUrl, token, enqueue.command_id);
  if (result?.status === 'done') {
    console.log(`✓ ${localAction === 'stop' ? 'stopped' : 'removed'} ${sid}`);
    return 0;
  }
  console.error(`mc: ${localAction} failed: ${result?.error || result?.status || 'no result'}`);
  return 1;
}

export async function controlLocalBrokerSession(identifier, {
  action,
  signal = 'SIGTERM',
  request = requestBroker,
} = {}) {
  if (!identifier || !action) return { ok: false, skipped: true, error: 'identifier and action are required' };
  const inventory = await listLocalBrokerAndHostSessions({ request })
    .then((sessions) => ({ ok: true, sessions }))
    .catch(() => request({ type: 'sessions' }).catch(() => null));
  if (!inventory?.ok || !Array.isArray(inventory.sessions)) {
    return { ok: false, skipped: true, error: 'local broker unavailable' };
  }
  const session = inventory.sessions.find((item) => localSessionMatches(item, identifier));
  if (!session) return { ok: false, skipped: true, error: 'local session not found' };
  const sid = session.id || session.coding_session_id || identifier;
  const sessionRequest = requestForSession(session, { request });

  if (action === 'stop') {
    const stopped = await sessionRequest({ type: 'stop_session', id: sid, signal }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    return stopped?.ok ? { ok: true, id: sid, action } : { ok: false, id: sid, error: stopped?.error || 'stop failed' };
  }

  if (action === 'remove') {
    const removed = await sessionRequest({ type: 'remove_session', id: sid }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    return removed?.ok ? { ok: true, id: sid, action, removed: !!removed.removed } : { ok: false, id: sid, error: removed?.error || 'remove failed' };
  }

  return { ok: false, id: sid, error: `unknown action: ${action}` };
}

function parseSessionsControlArgs(argv) {
  const opts = { identifier: null, signal: 'SIGTERM' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--signal') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--signal requires a value' };
      opts.signal = next;
      continue;
    }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.identifier) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.identifier = arg;
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function preflight(bin) {
  if (!bin) {
    console.error('mc: launch binary not configured');
    process.exit(1);
  }
  // `bin` may be a bare name (claude, resolved via PATH) or an absolute
  // path (the real codex binary, already resolved by the adapter). For an
  // absolute path, existence on disk is the check; for a name, PATH.
  if (bin.includes('/')) {
    if (!existsSync(bin)) {
      console.error(`mc: launch binary not found: ${bin}`);
      process.exit(1);
    }
    return;
  }
  if (spawnSync('which', [bin], { stdio: 'ignore' }).status !== 0) {
    console.error(`mc: '${bin}' not found in PATH`);
    process.exit(1);
  }
}

/**
 * Strip ANSI escapes and control characters from a raw PTY-output buffer,
 * collapse runs of blank lines, and return the trailing `max` characters.
 *
 * Used to feed the heartbeat's `last_assistant_excerpt` so peer
 * coordinators can see what Claude is currently showing (e.g. a paused
 * "Next step?" prompt) instead of just "session B has been idle 2m".
 *
 * Conservative: we keep readable text + newlines + tabs, drop everything
 * that's screen-positioning, color, or other-noise. If the entire buffer
 * is ANSI noise, returns an empty string.
 *
 * Pure for testing.
 */
export { extractExcerpt };

export function resolveStartupMessageForLaunch({
  delivery,
  groundingLaunchMessage = null,
  fallbackStartupMessage = null,
} = {}) {
  if (delivery === 'argv-prompt' || delivery === 'launch-args') return null;
  if (delivery === 'deferred-pty') return groundingLaunchMessage || fallbackStartupMessage || null;
  return fallbackStartupMessage || null;
}

/**
 * Render the multi-line stylized intro printed before Claude takes the
 * terminal. Pure function for testing. Trailing blank line gives the
 * Claude TUI breathing room.
 */
export function renderIntro({ version, codingSessionId, repo, branch, label = null, tool = null }) {
  return renderSessionIntro({ version, codingSessionId, repo, branch, label, tool });
}

async function postHeartbeatWithRetry({ apiUrl, token, payload }) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await memoroFetch(apiUrl, '/api/sessions/heartbeat', {
        token, method: 'POST', body: payload,
      });
      return true;
    } catch {
      if (attempt < MAX_ATTEMPTS - 1) {
        try { await sleep(RETRY_INTERVAL_MS); } catch {}
      }
    }
  }
  return false;
}

async function pollCommandResult(apiUrl, token, commandId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const r = await memoroFetch(apiUrl, `/api/coding-sessions/commands/${encodeURIComponent(commandId)}`, { token });
      if (r?.status === 'done' || r?.status === 'error') return r;
    } catch {
      // poll again
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: 'timeout' };
}

export function ageSeconds(isoString) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

export function humanAge(seconds) {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// Exposed for tests.
export const __test__ = {
  TICK_INTERVAL_MS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
};

// Only run main() when invoked as a script — not when imported by tests.
// Compare via realpath because npm installs the bin as a symlink.
if (isEntryScript()) {
  main()
    .then(code => { process.exitCode = code ?? 0; })
    .catch((err) => {
      console.error(err?.stack || err?.message || String(err));
      process.exitCode = 1;
    });
}

function isEntryScript() {
  try {
    const here = fileURLToPath(import.meta.url);
    const argv1 = realpathSync(process.argv[1]);
    return here === argv1;
  } catch {
    return false;
  }
}
