/**
 * Mint and persist `coding_session_id` for the coordinator.
 *
 * One id per (repoIdentity, machineId, llmSessionId) tuple. Within a Claude
 * Code session, restarts in the same repo reuse the id; switching repos
 * mints a new one. Persistence is `~/.memoro/sessions.json` (mode 0600).
 *
 * Server contract: id matches /^sess_[a-zA-Z0-9_-]{6,}$/.
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const STATE_DIR = () => join(homedir(), '.memoro');
const STATE_FILE = () => join(STATE_DIR(), 'sessions.json');

// Entries older than this since last_seen_at are pruned on the next
// read-modify-write. Generous because losing an id is harmless (we'd just
// mint another) but keeping them lets restarts within the window resume
// cleanly.
const STALE_DAYS = 30;

export function mintCodingSessionId() {
  // 9 random bytes → 12 base64url chars. Total length 17 ("sess_" + 12)
  // satisfies the server regex /^sess_[a-zA-Z0-9_-]{6,}$/.
  return `sess_${randomBytes(9).toString('base64url')}`;
}

export function makeKey({ repoIdentity, machineId, llmSessionId }) {
  return `${repoIdentity}::${machineId}::${llmSessionId}`;
}

export async function readSessions() {
  if (!existsSync(STATE_FILE())) return {};
  try {
    const raw = await readFile(STATE_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeSessions(map) {
  if (!existsSync(STATE_DIR())) {
    await mkdir(STATE_DIR(), { recursive: true, mode: 0o700 });
  }
  await writeFile(STATE_FILE(), JSON.stringify(map, null, 2), { mode: 0o600 });
  try { await chmod(STATE_FILE(), 0o600); } catch { /* best effort */ }
}

/**
 * Pure: drop entries older than STALE_DAYS. Returns a new object; does
 * not mutate `map`.
 */
export function sweepStale(map, now = Date.now()) {
  const cutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000;
  const next = {};
  for (const [k, v] of Object.entries(map || {})) {
    const lastSeen = v?.last_seen_at ? Date.parse(v.last_seen_at) : 0;
    if (Number.isFinite(lastSeen) && lastSeen >= cutoff) next[k] = v;
  }
  return next;
}

/**
 * Pure: given the current sessions map and an identity, return the
 * `coding_session_id` to use plus the next map state. Mints fresh if
 * absent. Always updates `last_seen_at`.
 */
export function lookupOrMintPure(map, identity, now = new Date()) {
  const swept = sweepStale(map, now.getTime());
  const key = makeKey(identity);

  const existing = swept[key]?.coding_session_id;
  const codingSessionId = existing || mintCodingSessionId();

  swept[key] = {
    coding_session_id: codingSessionId,
    created_at: swept[key]?.created_at ?? now.toISOString(),
    last_seen_at: now.toISOString(),
  };

  return { codingSessionId, map: swept, minted: !existing };
}

/**
 * I/O: load sessions, look up or mint, write back. Returns the id.
 */
export async function lookupOrMint(identity) {
  const current = await readSessions();
  const { codingSessionId, map } = lookupOrMintPure(current, identity);
  await writeSessions(map);
  return codingSessionId;
}
