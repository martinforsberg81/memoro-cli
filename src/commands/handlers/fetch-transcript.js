/**
 * fetch_transcript command handler.
 *
 * Reads the Claude Code transcript file at `transcript_path` (passed in
 * via the SessionStart hook event and held by the heartbeat-loop daemon),
 * parses it into the same cleaned conversation shape the SessionEnd
 * upload uses, and returns the result over the WS channel.
 *
 * The dashboard's scoped-session view triggers this when the user opens
 * a session; full transcripts never get persisted server-side beyond a
 * short KV cache.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { parseTranscript } from '../../lib/distill.js';

/**
 * Build a command handler bound to the daemon's known transcript path.
 * The factory shape lets the handler stay pure of process state — the
 * heartbeat-loop owns the path and the WS client just calls the function.
 */
export function createFetchTranscriptHandler({ transcriptPath, source = 'claude-code' }) {
  return async function fetchTranscript(_args) {
    if (!transcriptPath) {
      throw new Error('transcript_path was not supplied at session start');
    }
    if (!existsSync(transcriptPath)) {
      throw new Error(`transcript file not found at ${transcriptPath}`);
    }

    const raw = await readFile(transcriptPath, 'utf8');
    const parsed = parseTranscript(raw, { tool: source });

    return {
      source,
      session_id: parsed.sessionId ?? null,
      cwd: parsed.cwd ?? null,
      tool_version: parsed.toolVersion ?? null,
      started_at: parsed.startedAt ?? null,
      ended_at: parsed.endedAt ?? null,
      messages: parsed.messages ?? [],
      activities: parsed.activities ?? [],
    };
  };
}
