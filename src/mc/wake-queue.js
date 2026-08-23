/**
 * Wakes that could not be delivered yet, kept until they can.
 *
 * The guard refuses to type into a prompt that holds a draft, and it is right
 * to: the draft is somebody's. But the consequence was a session nobody could
 * reach — the file arrived in its inbox, nothing told it to read, and it
 * stood still for twenty minutes with an answer waiting (2026-08-22). Trying
 * by hand went worse: Enter did not take, and Escape cleared the draft the
 * guard had existed to protect.
 *
 * So a refused wake on a draft is not dropped, it is queued, and the queue
 * is tried again by the session guard's round: when the prompt clears, the
 * knock lands; until then the status board says the session is unreachable
 * and since when. Nothing here ever types over a draft — there is no flag
 * for that, because typing into a draft and pressing Enter *sends the draft*,
 * and a flag that did that would be the harm with a name.
 *
 * One entry per area: a second wake to the same area while one is queued
 * refreshes nothing — the knock says "read your inbox", and one of those is
 * all a session needs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';
import { watchRoot } from './watch-paths.js';

export const QUEUE_SCHEMA = 'mc-wake-queue';
export const QUEUE_VERSION = 1;

export function wakeQueuePath(root = mcHome()) {
  return join(watchRoot(root), 'pending-wakes.json');
}

/** Every queued wake, oldest first. An unreadable file is an empty queue. */
export function readWakeQueue({ root = mcHome() } = {}) {
  try {
    if (!existsSync(wakeQueuePath(root))) return [];
    const raw = JSON.parse(readFileSync(wakeQueuePath(root), 'utf8'));
    if (raw?.schema !== QUEUE_SCHEMA || !Array.isArray(raw.wakes)) return [];
    return raw.wakes.filter((item) => item && typeof item.name === 'string');
  } catch {
    return [];
  }
}

function writeWakeQueue(wakes, root) {
  writeJsonAtomic(wakeQueuePath(root), { schema: QUEUE_SCHEMA, version: QUEUE_VERSION, wakes });
}

/** Queue a wake for an area. Returns the entry — the existing one if there was one. */
export function enqueueWake({ name, target, sender, inbox, reason, root = mcHome(), now = new Date() } = {}) {
  const wakes = readWakeQueue({ root });
  const existing = wakes.find((item) => item.name === name);
  if (existing) return { entry: existing, already: true };
  const entry = {
    name,
    target: target || null,
    sender: sender || null,
    inbox: inbox || null,
    reason: reason || null,
    since: now.toISOString(),
    attempts: 0,
  };
  writeWakeQueue([...wakes, entry], root);
  return { entry, already: false };
}

/** Forget a queued wake — it landed, or the area is gone. */
export function dropWake({ name, root = mcHome() } = {}) {
  const wakes = readWakeQueue({ root });
  const kept = wakes.filter((item) => item.name !== name);
  if (kept.length !== wakes.length) writeWakeQueue(kept, root);
  return kept.length !== wakes.length;
}

/** The queued wake for one area, or null. */
export function pendingWakeFor(name, { root = mcHome() } = {}) {
  return readWakeQueue({ root }).find((item) => item.name === name) || null;
}

/**
 * Try every queued wake once. `attempt(entry)` does the knocking and answers
 * `{ ok, reason, gone }`; a landed knock drops the entry, a gone target drops
 * it too (nothing to knock on, and the file is still in the inbox), and
 * anything else keeps it with one more attempt counted. Returns what happened
 * to each, for the round's log.
 */
export function flushWakeQueue({ attempt, root = mcHome(), now = new Date() } = {}) {
  const wakes = readWakeQueue({ root });
  if (wakes.length === 0) return [];
  const outcomes = [];
  const kept = [];
  for (const entry of wakes) {
    let result;
    try { result = attempt(entry); } catch (error) { result = { ok: false, reason: error?.message || String(error) }; }
    if (result?.ok) {
      outcomes.push({ name: entry.name, outcome: 'woke', since: entry.since });
      continue;
    }
    if (result?.gone) {
      outcomes.push({ name: entry.name, outcome: 'gone', reason: result.reason || null, since: entry.since });
      continue;
    }
    kept.push({ ...entry, attempts: (entry.attempts || 0) + 1, last_reason: result?.reason || null, last_tried: now.toISOString() });
    outcomes.push({ name: entry.name, outcome: 'kept', reason: result?.reason || null, since: entry.since });
  }
  writeWakeQueue(kept, root);
  return outcomes;
}
