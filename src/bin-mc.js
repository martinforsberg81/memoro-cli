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
import { getRepoContext, deriveRepoName } from './lib/git-context.js';
import { lookupOrMint } from './lib/coding-session.js';
import { CliWsClient } from './commands/ws-client.js';
import { createFetchTranscriptHandler } from './commands/handlers/fetch-transcript.js';
import { ensureCoordinatorSlashCommand } from './mc/coordinator-command.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printHelp();
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(await packageVersion());
    return 0;
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

  // Default: wrap claude.
  return runWrap(argv);
}

function printHelp() {
  console.log(`mc — Memoro for developers

USAGE
  mc [args...]                    Wrap \`claude\` (args passed through);
                                  register this session with Memoro.

  mc sessions list                List your active coding sessions
  mc sessions send <id> <msg>     Dispatch a message into another session
  mc sessions read <id>           Fetch another session's recent transcript

  mc --help                       This help
  mc --version                    Print version

REQUIREMENTS
  - claude     (Claude Code CLI)
  - memoro-cli login              (one-time token setup)
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

async function runWrap(argv) {
  preflight();

  if (!existsSync(MC_DIR)) {
    mkdirSync(MC_DIR, { recursive: true, mode: 0o700 });
  }
  await ensureCoordinatorSlashCommand();

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
    console.error('mc: no Memoro token. Run `memoro-cli login` first.');
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
    sock_path: sockPath,
    repo: deriveRepoName(repoContext),
    branch: repoContext.branch,
    cwd,
    started_at: new Date().toISOString(),
    pid: process.pid,
  }, null, 2), { mode: 0o600 });

  // Print the one-line banner BEFORE handing the TTY to Claude. Stays in
  // the terminal's scrollback above Claude's output.
  process.stderr.write(`[mc] session ${codingSessionId} — ${deriveRepoName(repoContext)} (${repoContext.branch})\n`);

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

  // Pipe PTY output → user's terminal.
  ptyProcess.onData((data) => {
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
    last_assistant_excerpt: '',
  };
  (async () => {
    while (alive) {
      await postHeartbeatWithRetry({
        apiUrl, token,
        payload: { ...heartbeatBase, at: new Date().toISOString() },
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
    const excerpt = (s.last_user_excerpt || s.last_assistant_excerpt || '').replace(/\s+/g, ' ').slice(0, 80);
    console.log(`[${s.coding_session_id}] ${s.repo}  ${s.branch}  ${s.machine_id}  ${ageLabel}`);
    if (excerpt) console.log(`    ${excerpt}`);
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// `mc sessions send <id> <message>`
// ─────────────────────────────────────────────────────────────────────────────

async function runSessionsSend(argv) {
  const sid = argv[0];
  const message = argv.slice(1).join(' ');
  if (!sid || !message) {
    console.error('Usage: mc sessions send <session_id> <message>');
    return 2;
  }

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('mc: no Memoro token. Run `memoro-cli login` first.');
    return 1;
  }

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
  const sid = argv[0];
  if (!sid) {
    console.error('Usage: mc sessions read <session_id>');
    return 2;
  }

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('mc: no Memoro token. Run `memoro-cli login` first.');
    return 1;
  }

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
