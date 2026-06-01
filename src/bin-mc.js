#!/usr/bin/env node
/**
 * mc — Memoro for developers.
 *
 * The terminal coordinator. Two modes:
 *
 *   mc                          # wrap `claude` in a PTY this process owns,
 *                                 pipe it to your terminal, register the
 *                                 session with Memoro for cross-session
 *                                 dispatch.
 *   mc sessions list            # show your active coding sessions across
 *                                 machines.
 *   mc sessions send <id> <msg> # dispatch a message into another session
 *                                 (lands as if the user typed it there).
 *   mc sessions read <id>       # fetch the recent transcript of another
 *                                 session.
 *
 * The wrapper holds:
 *   - a node-pty child running `claude`, piped transparently to/from this
 *     process's TTY (so your terminal's native scrollback works)
 *   - a Unix-domain dispatch socket for local senders
 *   - a WebSocket to Memoro's UserSession DO for remote `dispatch_message`
 *     and `fetch_transcript` commands
 *
 * Dispatches land by writing to the PTY's input stream, which delivers the
 * bytes to Claude's stdin as if the user had typed them.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync, chmodSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostname } from 'node:os';

import pty from 'node-pty';

import { getSecret } from './lib/keychain.js';
import { ACCOUNTS } from './commands/auth.js';
import { readConfig, getApiUrl } from './lib/config.js';
import { memoroFetch } from './lib/api.js';
import { needsDeviceAuth, runDeviceFlow } from './lib/device-flow.js';
import { getRepoContext, deriveRepoName } from './lib/git-context.js';
import { lookupOrMint } from './lib/coding-session.js';
import { CliWsClient } from './commands/ws-client.js';
import { createFetchTranscriptHandler } from './commands/handlers/fetch-transcript.js';
import { ensureCoordinatorSlashCommand } from './mc/coordinator-command.js';
import { installUpdateCommand } from './adapters/claude-code.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_BIN = 'claude';
const MC_DIR = join(homedir(), '.memoro', 'mc');

const TICK_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

// Raw PTY bytes kept for excerpt extraction. ANSI escapes typically
// strip down to ~30–50%, so 4 KiB raw yields plenty of clean text to
// slice the trailing 500 chars from (server's EXCERPT_MAX).
const OUTPUT_BUFFER_BYTES = 4096;
const EXCERPT_MAX_CHARS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

// Lifecycle subcommands → src/mc/commands/<name>.js (lazy-loaded so the
// hot path of `mc` wrap-mode boot doesn't pay for them).
const LIFECYCLE = {
  new:           () => import('./mc/commands/new.js'),
  list:          () => import('./mc/commands/list.js'),
  end:           () => import('./mc/commands/end.js'),
  rename:        () => import('./mc/commands/rename.js'),
  cd:            () => import('./mc/commands/cd.js'),
  resume:        () => import('./mc/commands/resume.js'),
  gc:            () => import('./mc/commands/gc.js'),
  status:        () => import('./mc/commands/status.js'),
  dispatch:      () => import('./mc/commands/dispatch.js'),
  read:          () => import('./mc/commands/read.js'),
  'install-shell': () => import('./mc/commands/install-shell.js'),
  auth:          () => import('./mc/commands/auth.js'),
  setup:         () => import('./mc/commands/setup.js'),
  reconcile:     () => import('./mc/commands/reconcile.js'),
  vault:         () => import('./mc/commands/vault.js'),
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

  if (argv[0] === 'sessions') {
    const sub = argv[1];
    const rest = argv.slice(2);
    if (sub === 'list')        return runSessionsList(rest);
    if (sub === 'send')        return runSessionsSend(rest);
    if (sub === 'read')        return runSessionsRead(rest);
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

  // `mc wrap <label> [args...]` — tag a wrapped Claude session in the
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

  // Default: wrap claude (no label, current cwd).
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

function printHelp() {
  console.log(`mc — Memoro for developers

USAGE
  mc [args...]                       Wrap \`claude\` in current cwd
  mc wrap <label> [args...]          Same, but tag this session with a
                                     friendly label for peer lookup

  mc new <name>                      Create worktree + branch + launch tool
  mc list [--rich|--awaiting|...]    Show sessions (filters per §9d)
  mc list --orphans                  List orphan heartbeat daemons (§9j)
  mc status <name>                   Per-session derived status (§9a)
  mc resume <name>                   cd into worktree + relaunch tool
  mc end <name> [<name>...]          End worktrees (bulk + --dry-run supported)
  mc rename <old> <new>              Rename branch + dir + registry entry
  mc cd <name>                       cd into worktree (needs install-shell)
  mc gc [--dry-run]                  Reap dead + merged + clean worktrees
  mc gc --reap-orphans [--min-age D] SIGTERM orphan heartbeat daemons (§9j)
  mc reconcile [--apply --only-safe] Detect shipped-elsewhere sessions (§9e)
  mc install-shell                   Install the zsh/bash wrapper
  mc setup [--json]                  Self-verifying setup checklist (§11b)
  mc auth status [--json]            Single-screen health check (§11a)
  mc auth memoro [--logout|--status] Log in / out of Memoro (§11c)
  mc auth devices [--json]           List device tokens (§14e)
  mc auth devices revoke <prefix>    Revoke a device token
  mc auth <claude|codex|gemini>      Re-check that tool's status + hint

  mc vault setup                     Create a Memoro-account-wide token vault
  mc vault unlock                    Validate the master password
  mc vault list [--json]             List secret labels (no values)
  mc vault get <label>               Print a secret value (with confirm)
  mc vault set <label> [--type ...]  Store a new secret
  mc vault rm <label>                Delete a secret
  mc vault rotate <label>            Replace a secret (keeps -prev copy)
  mc vault change-password           Change the master password
  mc vault status / lock / --help    Self-explanatory

  mc sessions list                   List your active coding sessions
  mc sessions send <label|id> <msg>  Dispatch a message into another session
  mc sessions read <label|id>        Fetch another session's recent transcript

  mc --help                          This help
  mc --version                       Print version

LABELS
  Labels let you refer to sessions by topic instead of by random
  sess_xxx id. Example: \`mc new audit\` → then from anywhere
  \`mc sessions send audit "summary please"\`. Labels are local-machine
  free-form; first-match-wins on collision.

REQUIREMENTS
  - claude     (Claude Code CLI)
  - memoro-cli login                 (one-time token setup)
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
  preflight();

  if (!existsSync(MC_DIR)) {
    mkdirSync(MC_DIR, { recursive: true, mode: 0o700 });
  }
  // Refresh managed Claude Code slash commands on every mc launch — pushes
  // updated bodies (coordinator prompts, update recipe) to existing
  // installs without requiring `memoro-cli hook install`.
  await ensureCoordinatorSlashCommand();
  await installUpdateCommand().catch(() => { /* best effort */ });

  const cwd = process.cwd();
  const repoContext = await getRepoContext(cwd);
  if (!repoContext) {
    console.error('mc: not inside a git repository. Coordinator is gated on repos.');
    console.error('mc: run from inside a git repo, or use plain `claude` for ad-hoc work.');
    process.exit(1);
  }

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    // Reachable when MC_TEST_MODE=1 (device-flow auto-trigger skipped) or
    // when the user wipes the keychain mid-session. The user-friendly
    // path is "just run mc on a real TTY"; CI keeps memoro-cli login.
    console.error('mc: no Memoro token. Run `mc` on a real TTY to start the device flow, or `memoro-cli login` for CI.');
    process.exit(1);
  }

  const machineId = hostname();
  const llmSessionId = `mc-${Date.now()}-${process.pid}`;
  const codingSessionId = await lookupOrMint({
    repoIdentity: repoContext.remoteUrl,
    machineId,
    llmSessionId,
  });

  const sockPath = join(MC_DIR, `${codingSessionId}.sock`);
  const metaPath = join(MC_DIR, `${codingSessionId}.json`);

  writeFileSync(metaPath, JSON.stringify({
    coding_session_id: codingSessionId,
    label,
    sock_path: sockPath,
    repo: deriveRepoName(repoContext),
    branch: repoContext.branch,
    cwd,
    started_at: new Date().toISOString(),
    pid: process.pid,
  }, null, 2), { mode: 0o600 });

  // Print a short stylized intro BEFORE handing the TTY to Claude. The
  // intro lands in the terminal's scrollback above Claude's TUI, so the
  // user can scroll up to find the session id whenever they need it.
  process.stderr.write(renderIntro({
    version: await packageVersion(),
    codingSessionId,
    repo: deriveRepoName(repoContext),
    branch: repoContext.branch,
    label,
  }));

  // ─── Spawn claude in a PTY we own ────────────────────────────────────────
  const ptyProcess = pty.spawn(CLAUDE_BIN, argv, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd,
    env: {
      ...process.env,
      MEMORO_MC_PARENT: '1',  // hooks see this and no-op their heartbeat-loop
    },
  });

  // Pipe PTY output → user's terminal. Also:
  //   - stamp `lastOutputAt` so the heartbeat ticker can report idle vs
  //     active to peer coordinators
  //   - keep a rolling raw-output buffer so the heartbeat can carry a
  //     stripped excerpt of what Claude is currently showing (lets a peer
  //     coordinator spot e.g. "How should I proceed?" prompts at a
  //     glance, not just "session B has been idle 2m")
  let lastOutputAt = Date.now();
  let outputBuffer = '';
  ptyProcess.onData((data) => {
    lastOutputAt = Date.now();
    outputBuffer += data;
    if (outputBuffer.length > OUTPUT_BUFFER_BYTES) {
      outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_BYTES);
    }
    process.stdout.write(data);
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
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    conn.on('end', () => {
      let payload;
      try { payload = JSON.parse(buf); }
      catch {
        conn.end(JSON.stringify({ ok: false, error: 'invalid JSON' }) + '\n');
        return;
      }
      const message = payload?.message;
      if (typeof message !== 'string' || !message.trim()) {
        conn.end(JSON.stringify({ ok: false, error: 'message required' }) + '\n');
        return;
      }
      writeToPty(ptyProcess, message);
      conn.end(JSON.stringify({ ok: true, message }) + '\n');
    });
  });
  server.listen(sockPath, () => {
    try { chmodSync(sockPath, 0o600); } catch {}
  });

  // ─── WS client (remote dispatch via Memoro server) ──────────────────────
  const wsClient = new CliWsClient({
    apiUrl,
    token,
    codingSessionId,
    handlers: {
      fetch_transcript: createFetchTranscriptHandler({
        transcriptPath: null,
        source: 'claude-code',
      }),
      dispatch_message: async (args) => {
        const message = typeof args?.message === 'string' ? args.message : null;
        if (!message?.trim()) throw new Error('message required');
        writeToPty(ptyProcess, message);
        return { ok: true, delivered_at: new Date().toISOString() };
      },
    },
    logger: silentLogger(),
  });
  wsClient.start();

  // ─── Heartbeat ticker ───────────────────────────────────────────────────
  let alive = true;
  const heartbeatBase = {
    coding_session_id: codingSessionId,
    machine_id: machineId,
    source: 'claude-code',
    repo: deriveRepoName(repoContext),
    branch: repoContext.branch,
    files_touched_since_last: [],
    last_user_excerpt: '',
    ...(label ? { label } : {}),
  };
  (async () => {
    while (alive) {
      const now = Date.now();
      await postHeartbeatWithRetry({
        apiUrl, token,
        payload: {
          ...heartbeatBase,
          last_assistant_excerpt: extractExcerpt(outputBuffer, EXCERPT_MAX_CHARS),
          idle_seconds: Math.max(0, Math.floor((now - lastOutputAt) / 1000)),
          at: new Date(now).toISOString(),
        },
      });
      if (!alive) break;
      try { await sleep(TICK_INTERVAL_MS); } catch {}
    }
  })();

  // ─── Cleanup ─────────────────────────────────────────────────────────────
  let cleanedUp = false;
  const cleanup = (exitCode = 0) => {
    if (cleanedUp) return;
    cleanedUp = true;
    alive = false;
    try { wsClient.stop(); } catch {}
    try { server.close(); } catch {}
    try { unlinkSync(sockPath); } catch {}
    try { unlinkSync(metaPath); } catch {}
    process.stdout.removeListener('resize', onResize);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    try { process.stdin.pause(); } catch {}
    try { ptyProcess.kill(); } catch {}
    process.exit(exitCode);
  };

  // When claude exits (user types /exit, Ctrl+D etc.), tear down.
  ptyProcess.onExit(({ exitCode }) => {
    cleanup(exitCode || 0);
  });

  // External signals → forward to claude, let its exit drive cleanup.
  // (User's Ctrl+C is bytes through stdin in raw mode, not SIGINT to us.)
  process.on('SIGTERM', () => {
    try { ptyProcess.kill('SIGTERM'); } catch {}
  });
  process.on('SIGHUP', () => {
    try { ptyProcess.kill('SIGHUP'); } catch {}
  });

  // Resolve never — wait for ptyProcess.onExit to call process.exit().
  return new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// `mc sessions list`
// ─────────────────────────────────────────────────────────────────────────────

async function runSessionsList(_argv) {
  const config = await readConfig();
  const apiUrl = getApiUrl(_argv) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('mc: no Memoro token. Run `memoro-cli login` first.');
    return 1;
  }

  let res;
  try {
    res = await memoroFetch(apiUrl, '/api/coding-sessions/active', { token });
  } catch (err) {
    console.error(`mc: failed to list sessions: ${err.message}`);
    return 1;
  }

  const sessions = res?.sessions ?? [];
  if (sessions.length === 0) {
    console.log('No active coding sessions.');
    return 0;
  }

  for (const s of sessions) {
    const ageSec = ageSeconds(s.received_at);
    const ageLabel = ageSec == null ? '?' : humanAge(ageSec);
    const statusLabel = formatStatus(s.idle_seconds);
    const excerpt = (s.last_user_excerpt || s.last_assistant_excerpt || '').replace(/\s+/g, ' ').slice(0, 80);
    const identifier = s.label || s.coding_session_id;
    console.log(`[${identifier}] ${s.repo}  ${s.branch}  ${s.machine_id}  ${statusLabel}  ${ageLabel}`);
    if (excerpt) console.log(`    ${excerpt}`);
  }
  return 0;
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
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function preflight() {
  if (spawnSync('which', [CLAUDE_BIN], { stdio: 'ignore' }).status !== 0) {
    console.error(`mc: '${CLAUDE_BIN}' not found in PATH`);
    process.exit(1);
  }
}

/**
 * Send a dispatched message into the wrapped Claude session. Appends a
 * carriage return so the TUI submits the prompt. Exported for tests.
 */
export function writeToPty(ptyProcess, message) {
  ptyProcess.write(message + '\r');
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
export function extractExcerpt(rawBuffer, max = EXCERPT_MAX_CHARS) {
  if (!rawBuffer) return '';

  // 1. CSI / SGR sequences: ESC [ ... letter
  // 2. OSC sequences: ESC ] ... BEL or ESC ]
  // 3. Single-character ESC escapes (ESC =, ESC >, ESC c, etc.)
  // 4. Bracketed paste / DECPRIVATE: covered by the CSI regex
  let s = rawBuffer
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // CSI / SGR
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')  // OSC (BEL or ST terminated)
    .replace(/\x1b[=>cDEHM7-9NO]/g, '');      // common single-char ESC

  // Drop non-printable control bytes except newline + tab
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

  // Collapse runs of 3+ blank lines into 2 for legibility
  s = s.replace(/\n{3,}/g, '\n\n');

  // Trim trailing whitespace per line (TUI redraws often leave trailing
  // spaces from cleared cells)
  s = s.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');

  // Return the trailing `max` chars — that's what's "currently on screen"
  if (s.length > max) s = s.slice(-max);

  // Strip leading whitespace from the slice so we don't start mid-line
  return s.replace(/^\s+/, '');
}

/**
 * Render the multi-line stylized intro printed before Claude takes the
 * terminal. Pure function for testing. Trailing blank line gives the
 * Claude TUI breathing room.
 */
export function renderIntro({ version, codingSessionId, repo, branch, label = null }) {
  const headline = label
    ? `  \x1b[1mmc\x1b[0m \x1b[2m${version}\x1b[0m  ·  \x1b[33m${label}\x1b[0m  ·  ${repo} \x1b[2m(${branch})\x1b[0m`
    : `  \x1b[1mmc\x1b[0m \x1b[2m${version}\x1b[0m  ·  ${repo} \x1b[2m(${branch})\x1b[0m`;
  return [
    '',
    headline,
    `  \x1b[2msession\x1b[0m  ${codingSessionId}`,
    '',
    `  \x1b[36m/memoro-coordinator\x1b[0m   manage other sessions from inside Claude`,
    `  \x1b[36mmc --help\x1b[0m              cli reference`,
    '',
    '',
  ].join('\n');
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
  main().then(code => { process.exit(code ?? 0); });
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
