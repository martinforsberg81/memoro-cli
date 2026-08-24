/**
 * The notices ledger — one knocker, and this is what it reads from.
 *
 * The guard (designnote §4) watches sessions and finds things worth saying.
 * It never knocks PM itself. It appends a line here, and the round (§3)
 * delivers whatever is not yet delivered on its next pass. That is the whole
 * point of the file: exactly one component understands the wake channel and
 * its guard, so PM's requirement — *do not wake me for something the guard
 * already flagged* — is true by construction rather than by two programs
 * agreeing to be careful.
 *
 * The file is append-only, one JSON object per line, at
 * `<mc home>/watch/notices.jsonl`:
 *
 *     {"id":"…","at":"…Z","source":"guard","session":"msr-cleanup",
 *      "pattern":"silent","detail":"no output for 4h12m"}
 *     {"type":"delivered","id":"…","at":"…Z"}
 *
 * Delivery is a new line, never an edit of an old one, and nothing is ever
 * removed: mc adds to the user's data. Current state is the replay of the
 * lines — the same law the task journal (§6) is built on.
 *
 * Two patterns are urgent — `dead` and `quota-exhausted`. For those the guard
 * knocks immediately through the same channel and writes the `delivered` line
 * itself, so the round never repeats it. Two classes, both recorded, no third:
 * `URGENT_PATTERNS` is the whole exception and it is a constant, not a rule
 * somebody can widen by accident.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import { watchRoot } from './watch-paths.js';

export const NOTICES_FILE = 'notices.jsonl';

/**
 * The two patterns that may not wait for the next pass.
 *
 * A session that has died cannot be woken later, and one out of quota is
 * burning calendar time for nothing. A session stopped with mail it has not
 * read, and a group in which nobody works, are the work itself standing
 * still (B2, 2026-08-23: four tracks, 20–41 minutes, nothing said) — and
 * the round's half hour is exactly the latency they cannot afford.
 * A context nearly full (2026-08-24) is the same shape: its next turns
 * are the ones that stall, and PM found one at 99 % only by looking.
 * Everything else waits — half an hour of latency on a flag is cheaper than
 * a channel nobody trusts to be quiet.
 */
export const URGENT_PATTERNS = Object.freeze(['dead', 'quota-exhausted', 'unattended', 'quiet-group', 'context']);

export function noticesPath(root = mcHome()) {
  return join(watchRoot(root), NOTICES_FILE);
}

export function isUrgent(pattern) {
  return URGENT_PATTERNS.includes(String(pattern));
}

/**
 * Append one notice and return the record as it was written.
 *
 * `source`, `session` and `pattern` are required and `detail` is the one free
 * line. A notice with a missing field throws rather than landing malformed:
 * the writer is a program, and a ledger the reader has to guess at is worse
 * than a loud failure at the moment of writing.
 *
 * `id` and `at` may be given — a test needs both to be its own — and are
 * generated otherwise.
 */
export function appendNotice({
  source, session, pattern, detail = null, id = null, at = null,
} = {}, { root = mcHome(), now = new Date() } = {}) {
  const record = {
    id: id || randomUUID(),
    at: at || now.toISOString(),
    source: required(source, 'source'),
    session: required(session, 'session'),
    pattern: required(pattern, 'pattern'),
    detail: detail === null || detail === undefined ? null : String(detail),
  };
  appendLine(record, root);
  return record;
}

/**
 * Say a notice has been handed to PM.
 *
 * Written by the round once the message is on disk in PM's inbox, and by the
 * guard itself for the two urgent patterns. An id that matches no notice is
 * accepted and recorded: refusing would mean reading the whole ledger before
 * every write, and a delivered line for nothing is inert.
 */
export function markDelivered(id, { root = mcHome(), now = new Date() } = {}) {
  const record = { type: 'delivered', id: required(id, 'id'), at: now.toISOString() };
  appendLine(record, root);
  return record;
}

/**
 * The ledger, replayed.
 *
 * A line that will not parse is counted rather than thrown on: the file is
 * appended to by more than one process, and a torn last line must not cost
 * the reader every good line above it. `malformed` is returned so a caller
 * can say so out loud instead of quietly reading less than is there.
 */
export function readLedger({ root = mcHome() } = {}) {
  let text = '';
  try {
    text = readFileSync(noticesPath(root), 'utf8');
  } catch {
    return { notices: [], delivered: new Set(), malformed: 0, exists: false };
  }
  const notices = [];
  const delivered = new Set();
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record = null;
    try { record = JSON.parse(line); } catch { malformed += 1; continue; }
    if (!record || typeof record !== 'object') { malformed += 1; continue; }
    if (record.type === 'delivered') {
      if (record.id) delivered.add(String(record.id));
      else malformed += 1;
      continue;
    }
    if (!record.id || !record.pattern) { malformed += 1; continue; }
    notices.push(record);
  }
  return { notices, delivered, malformed, exists: true };
}

/**
 * Everything the round still owes PM, oldest first.
 *
 * A notice appears here exactly once: the delivered line takes it out of the
 * set for good, and there is no other way out — which is what makes the round
 * safe to run at any interval and safe to restart mid-pass.
 */
export function pendingNotices({ root = mcHome() } = {}) {
  const ledger = readLedger({ root });
  return ledger.notices
    .filter((notice) => !ledger.delivered.has(String(notice.id)))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function appendLine(record, root) {
  mkdirSync(watchRoot(root), { recursive: true, mode: 0o700 });
  // One write of one line, opened for append: two processes writing at once
  // interleave whole lines rather than halves of two.
  appendFileSync(noticesPath(root), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function required(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`a notice needs a ${field}`);
  return text;
}
