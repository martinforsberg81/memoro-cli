/**
 * memoro-cli heartbeat-stop
 *
 * SessionEnd companion to heartbeat-loop. Reads the hook event from stdin
 * to find the LLM session_id, looks up the daemon's PID file, sends
 * SIGTERM, removes the file. Silent and best-effort — any failure here
 * shouldn't block the rest of SessionEnd.
 */

import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { readHookEvent } from '../lib/hook-event.js';
import { pidFilePath } from './heartbeat-loop.js';

export async function heartbeatStop(_argv) {
  // mc parents the daemon — nothing for the SessionEnd hook to stop.
  if (process.env.MEMORO_MC_PARENT === '1') return 0;

  const event = await readHookEvent();
  const llmSessionId = event?.session_id;
  if (!llmSessionId) return 0;

  const file = pidFilePath(llmSessionId);
  if (!existsSync(file)) return 0;

  let pid = null;
  try {
    const raw = (await readFile(file, 'utf8')).trim();
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch { /* unreadable */ }

  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  try { await unlink(file); } catch { /* best effort */ }
  return 0;
}
