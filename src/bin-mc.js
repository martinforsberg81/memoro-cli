#!/usr/bin/env node
/**
 * mc — Memoro for developers.
 *
 * The terminal coordinator. Two modes:
 *
 *   mc                          # wrap `claude` in a tmux session, attach you
 *                                 to it, and register the session with Memoro
 *                                 so it can be coordinated with peers.
 *   mc sessions list            # show your active coding sessions across
 *                                 machines.
 *   mc sessions send <id> <msg> # dispatch a message into another session
 *                                 (lands as if the user typed it there).
 *   mc sessions read <id>       # fetch the recent transcript of another
 *                                 session.
 *
 * The wrapper attaches a Unix-domain dispatch socket per session, holds a
 * WebSocket to Memoro's `UserSession` Durable Object, and routes incoming
 * `dispatch_message` commands to the wrapped Claude via `tmux send-keys`.
 * The same channel serves `fetch_transcript` for the future dashboard.
 */

import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync, chmodSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostname } from 'node:os';

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
  mc                              Wrap \`claude\` and register this session
  mc [args...]                    Same; args passed through to claude
  mc --no-attach                  Wrap but don't attach (debug / scripting)

  mc sessions list                List your active coding sessions
  mc sessions send <id> <msg>     Dispatch a message into another session
  mc sessions read <id>           Fetch another session's recent transcript

  mc --help                       This help
  mc --version                    Print version

REQUIREMENTS
  - tmux       (brew install tmux)
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
  const attach = !argv.includes('--no-attach');
  const passthrough = argv.filter(a => a !== '--no-attach');

  preflight();

  if (!existsSync(MC_DIR)) {
    mkdirSync(MC_DIR, { recursive: true, mode: 0o700 });
  }

  // First-run idempotent install of the /memoro-coordinator slash command.
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

  const tmuxSession = sanitizeTmuxName(codingSessionId);
  const sockPath = join(MC_DIR, `${codingSessionId}.sock`);
  const metaPath = join(MC_DIR, `${codingSessionId}.json`);

  // Persist session metadata for `mc sessions list` (local view).
  writeFileSync(metaPath, JSON.stringify({
    coding_session_id: codingSessionId,
    tmux_session: tmuxSession,
    sock_path: sockPath,
    repo: deriveRepoName(repoContext),
    branch: repoContext.branch,
    cwd,
    started_at: new Date().toISOString(),
    pid: process.pid,
  }, null, 2), { mode: 0o600 });

  // Build the claude command line. Set MEMORO_MC_PARENT=1 so any
  // SessionStart/SessionEnd heartbeat-loop hook installed in claude config
  // sees the env var and no-ops, avoiding duplicate daemons.
  const claudeCmd = ['env', 'MEMORO_MC_PARENT=1', CLAUDE_BIN, ...passthrough].map(shquote).join(' ');

  const newSession = spawnSync('tmux', [
    'new-session', '-d', '-s', tmuxSession, claudeCmd,
  ], { stdio: 'inherit' });
  if (newSession.status !== 0) {
    console.error(`mc: failed to start tmux session "${tmuxSession}"`);
    process.exit(1);
  }

  // Enable mouse mode so scroll-wheel scrolls tmux history instead of being
  // absorbed by Claude's TUI.
  spawnSync('tmux', ['set-option', '-t', tmuxSession, '-g', 'mouse', 'on'], { stdio: 'ignore' });

  process.stderr.write(`[mc] session ${codingSessionId} — ${deriveRepoName(repoContext)} (${repoContext.branch})\n`);
  process.stderr.write(`[mc] dispatch socket: ${sockPath}\n`);

  // ─── Dispatch socket (local nc dispatch — also used by mc sessions send
  // when the target is on this same machine) ───────────────────────────────
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
      const sent = sendKeys(tmuxSession, message);
      conn.end(JSON.stringify({ ok: sent, message }) + '\n');
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
        transcriptPath: null,  // mc owns its lifecycle — no SessionStart hook event
        source: 'claude-code',
      }),
      dispatch_message: async (args) => {
        const message = typeof args?.message === 'string' ? args.message : null;
        if (!message?.trim()) throw new Error('message required');
        const sent = sendKeys(tmuxSession, message);
        if (!sent) throw new Error('tmux send-keys failed');
        return { ok: true, delivered_at: new Date().toISOString() };
      },
    },
    logger: silentLogger(),
  });
  wsClient.start();

  // ─── Heartbeat ticker ───────────────────────────────────────────────────
  let alive = true;
  const heartbeatPayload = {
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
        payload: { ...heartbeatPayload, at: new Date().toISOString() },
      });
      if (!alive) break;
      try { await sleep(TICK_INTERVAL_MS); } catch {}
    }
  })();

  // ─── Cleanup on shutdown ─────────────────────────────────────────────────
  const cleanup = () => {
    alive = false;
    try { wsClient.stop(); } catch {}
    try { server.close(); } catch {}
    try { unlinkSync(sockPath); } catch {}
    try { unlinkSync(metaPath); } catch {}
    spawnSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' });
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  if (attach) {
    const attached = spawn('tmux', ['attach-session', '-t', tmuxSession], {
      stdio: 'inherit',
    });
    attached.on('exit', () => cleanup());
  } else {
    process.stderr.write('[mc] running detached; Ctrl+C to stop\n');
  }
  return 0;
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
  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
    console.error('mc: tmux is required. Install: brew install tmux');
    process.exit(1);
  }
  if (spawnSync('which', [CLAUDE_BIN], { stdio: 'ignore' }).status !== 0) {
    console.error(`mc: '${CLAUDE_BIN}' not found in PATH`);
    process.exit(1);
  }
}

export function sendKeys(tmuxSession, message) {
  const text = spawnSync('tmux', ['send-keys', '-t', tmuxSession, '-l', message], { stdio: 'ignore' });
  if (text.status !== 0) return false;
  const enter = spawnSync('tmux', ['send-keys', '-t', tmuxSession, 'Enter'], { stdio: 'ignore' });
  return enter.status === 0;
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

export function sanitizeTmuxName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function shquote(arg) {
  if (/^[A-Za-z0-9_\-./@:=]+$/.test(arg)) return arg;
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
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

// Only run main() when invoked as a script — not when imported by tests
// or other modules. Compare via realpath because npm installs the bin as
// a symlink (e.g. /opt/homebrew/bin/mc → .../node_modules/memoro-cli/src/bin-mc.js);
// import.meta.url resolves to the real path, process.argv[1] does not.
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
