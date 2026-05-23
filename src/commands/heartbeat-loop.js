/**
 * memoro-cli heartbeat-loop --tool <id>
 *
 * Background daemon spawned at SessionStart. Posts a heartbeat every 60 s
 * to /api/sessions/heartbeat for as long as the LLM session is alive.
 *
 * Lifecycle:
 *   1. Read hook event (Claude Code: { session_id, cwd, ... }) from stdin
 *      or, when --from-event-file is set, from the file the parent dropped
 *      before detaching.
 *   2. Detect git repo at cwd; exit cleanly if not in a repo.
 *   3. Look up or mint coding_session_id for (repo, machine, llm_session).
 *   4. Write PID file at ~/.memoro/heartbeat-<llmSessionId>.pid.
 *   5. Loop: post heartbeat, sleep 60 s, repeat. SIGTERM exits cleanly.
 *
 * Retry policy: each POST is tried up to 3 times (initial + 2 retries) at
 * 5-min intervals. If all attempts fail, the tick is dropped; the next
 * tick starts fresh. The KV TTL on the server (90 min) absorbs occasional
 * misses without marking the session dead.
 *
 * Adaptive cadence and rich excerpts (UserPromptSubmit hooks) land in a
 * follow-up PR.
 */

import { readFile, writeFile, mkdir, rm, unlink } from 'node:fs/promises';
import { existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { getSecret } from '../lib/keychain.js';
import { ACCOUNTS } from './auth.js';
import { readConfig, getApiUrl, CONFIG_DIR } from '../lib/config.js';
import { memoroFetch } from '../lib/api.js';
import { readHookEvent, parseHookEvent } from '../lib/hook-event.js';
import { getRepoContext, deriveRepoName } from '../lib/git-context.js';
import { lookupOrMint } from '../lib/coding-session.js';
import { CliWsClient } from './ws-client.js';
import { createFetchTranscriptHandler } from './handlers/fetch-transcript.js';

const TICK_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export async function heartbeatLoop(argv) {
  const { flags } = parseFlags(argv);

  // When `mc` parents the session, IT owns the heartbeat + WS lifecycle.
  // The Claude SessionStart hook still fires this command, so it must
  // detect the parent and exit immediately to avoid a duplicate daemon.
  if (process.env.MEMORO_MC_PARENT === '1') {
    return 0;
  }

  if (flags.background) {
    return forkDetached(argv);
  }

  let event = null;
  if (flags.fromEventFile) {
    try {
      const raw = await readFile(flags.fromEventFile, 'utf8');
      event = parseHookEvent(raw);
    } catch { /* missing or unreadable — proceed with null */ }
    try { await rm(flags.fromEventFile, { force: true }); } catch {}
  } else {
    event = await readHookEvent();
  }

  const llmSessionId = event?.session_id;
  if (!llmSessionId) {
    console.error('[heartbeat-loop] No session_id in hook event; nothing to track');
    return 1;
  }

  const cwd = event?.cwd || process.cwd();
  const repoContext = await getRepoContext(cwd);
  if (!repoContext) {
    // Coordinator only tracks coding work inside a git repo. Bail silently.
    return 0;
  }

  const machineId = hostname();
  const codingSessionId = await lookupOrMint({
    repoIdentity: repoContext.remoteUrl,
    machineId,
    llmSessionId,
  });

  const pidFile = pidFilePath(llmSessionId);
  await writePidFile(pidFile, process.pid);

  let alive = true;
  const stop = () => { alive = false; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('[heartbeat-loop] No Memoro token in keychain; exiting');
    await cleanupPidFile(pidFile);
    return 0;
  }

  const source = flags.tool || 'claude-code';
  const repo = deriveRepoName(repoContext);

  // Open the WS command channel in parallel with the heartbeat ticker.
  // The CLI reads its local transcript on demand when the dashboard's
  // scoped-session view asks for it; nothing is streamed otherwise.
  const wsLogger = makeFileLogger(join(CONFIG_DIR, 'heartbeat.log'));
  const wsClient = new CliWsClient({
    apiUrl,
    token,
    codingSessionId,
    handlers: {
      fetch_transcript: createFetchTranscriptHandler({
        transcriptPath: event?.transcript_path,
        source,
      }),
    },
    logger: wsLogger,
  });
  wsClient.start();
  const stopWs = () => wsClient.stop();
  process.on('SIGTERM', stopWs);
  process.on('SIGINT', stopWs);

  while (alive) {
    await postHeartbeatWithRetry({
      apiUrl,
      token,
      payload: {
        coding_session_id: codingSessionId,
        machine_id: machineId,
        source,
        repo,
        branch: repoContext.branch,
        files_touched_since_last: [],
        last_user_excerpt: '',
        last_assistant_excerpt: '',
        at: new Date().toISOString(),
      },
    });
    if (!alive) break;
    try {
      await sleep(TICK_INTERVAL_MS);
    } catch { /* signal-interrupted sleep — falls through to alive check */ }
  }

  wsClient.stop();
  await cleanupPidFile(pidFile);
  return 0;
}

/**
 * Append-only logger that writes to heartbeat.log instead of stderr.
 * heartbeat-loop runs detached with stderr → heartbeat.log already, so
 * `appendFile` here is paranoia in case stderr is captured differently in
 * the future.
 */
function makeFileLogger(_path) {
  // For now, route through console.error which is already piped to the
  // heartbeat.log file via the detached child's stdio redirect.
  return {
    info: (msg) => console.error(msg),
    warn: (msg) => console.error(msg),
    error: (msg) => console.error(msg),
  };
}

async function postHeartbeatWithRetry({ apiUrl, token, payload }) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await memoroFetch(apiUrl, '/api/sessions/heartbeat', {
        token,
        method: 'POST',
        body: payload,
      });
      return true;
    } catch (err) {
      const isLast = attempt === MAX_ATTEMPTS - 1;
      if (isLast) {
        console.error(`[heartbeat-loop] Heartbeat failed after ${MAX_ATTEMPTS} attempts: ${err.message}`);
        return false;
      }
      try { await sleep(RETRY_INTERVAL_MS); } catch {}
    }
  }
  return false;
}

export function pidFilePath(llmSessionId) {
  const safe = String(llmSessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return join(homedir(), '.memoro', `heartbeat-${safe}.pid`);
}

async function writePidFile(file, pid) {
  const dir = join(homedir(), '.memoro');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(file, String(pid), { mode: 0o600 });
}

async function cleanupPidFile(file) {
  try { await unlink(file); } catch { /* best effort */ }
}

function parseFlags(argv) {
  const flags = {};
  const valueFlags = new Set(['--tool', '--api-url', '--api']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tool' && argv[i + 1])            { flags.tool = argv[++i]; continue; }
    if (a === '--background' || a === '-b')       { flags.background = true; continue; }
    if (a === '--from-event-file' && argv[i + 1]) { flags.fromEventFile = argv[++i]; continue; }
    if (valueFlags.has(a) && argv[i + 1])         { i++; continue; }
  }
  return { flags };
}

/**
 * Drain stdin into a temp file, then fork a detached grandchild that
 * outlives the SessionStart hook process. Same pattern as session upload's
 * --background path. Hook returns immediately; daemon keeps ticking.
 */
async function forkDetached(argv) {
  let rawStdin = '';
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawStdin = Buffer.concat(chunks).toString('utf8');
  }

  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  const eventFile = join(tmpdir(), `memoro-cli-heartbeat-${Date.now()}-${process.pid}.json`);
  await writeFile(eventFile, rawStdin, { mode: 0o600 });

  // Strip --background; add --from-event-file pointing at the drained stdin.
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--background' || a === '-b') continue;
    passthrough.push(a);
  }

  const binJs = process.argv[1];
  const childArgs = [binJs, 'heartbeat-loop', ...passthrough, '--from-event-file', eventFile];

  const logPath = join(CONFIG_DIR, 'heartbeat.log');
  const logFd = openSync(logPath, 'a');

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  return 0;
}

// Exposed for tests.
export const __test__ = {
  TICK_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  MAX_ATTEMPTS,
  parseFlags,
};
