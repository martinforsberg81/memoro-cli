/**
 * What the guard remembers between rounds.
 *
 * One thing, and it is the reason the guard is affordable: for every
 * conversation it has seen, the size and mtime of that conversation's
 * transcript at the end of the last round.
 *
 * That is the cost gate, and it is a lock rather than an intention (design
 * note §4 and §7). A session whose transcript has not moved since the last
 * round costs one `stat` — the model is never asked about it. Everything the
 * guard spends is spent on output that actually changed.
 *
 * It also remembers which patterns were already flagged for a conversation, so
 * a pattern that is simply still true does not become a notice every round. A
 * flag is worth reading the first time and noise the fourth; the ledger is
 * append-only and a nagger fills it up.
 *
 * The pid file and the log are not here — those are `watch-daemon.js`, shared
 * with the round. One daemon form, not two.
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';
import { sessionsSeenPath } from './watch-paths.js';

export const STATE_SCHEMA = 'mc-watch-sessions';
export const STATE_VERSION = 1;

/**
 * Ten minutes.
 *
 * `mc repo watch` runs every minute because a repository's answer is cheap and
 * a person may be staring at it. This one is not free — every session whose
 * output moved costs a model turn, and on a busy machine that turn takes two
 * minutes of tool start-up before it takes eleven seconds of model. Ten
 * minutes leaves a round room to finish before the next one is due, and the
 * thing the guard exists to catch is a session that has sat for an hour: found
 * with fifty minutes to spare, at a thirtieth of what a minute would cost.
 */
export const DEFAULT_INTERVAL_MS = 10 * 60_000;

/** How long a session may sit before the guard says so. */
export const DEFAULT_WAITING_MS = 20 * 60_000;
export const DEFAULT_SILENT_MS = 20 * 60_000;

export { sessionsSeenPath };

/**
 * What the last round saw, keyed by conversation id.
 *
 * A shape that cannot be read is an empty memory rather than an error: the
 * worst that costs is one extra round of model turns, and refusing to watch
 * because a cache file went bad would trade the whole feature for a file
 * nobody would miss.
 */
export function readMemory({ root = mcHome() } = {}) {
  let value = null;
  try { value = JSON.parse(readFileSync(sessionsSeenPath(root), 'utf8')); } catch { return blank(); }
  if (value?.schema !== STATE_SCHEMA || value?.version !== STATE_VERSION) return blank();
  return {
    at: value.at || null,
    last_round: typeof value.last_round === 'string' ? value.last_round : null,
    sessions: value.sessions && typeof value.sessions === 'object' ? value.sessions : {},
  };
}

export function writeMemory(sessions, { root = mcHome(), now = new Date(), lastRound = null } = {}) {
  return writeJsonAtomic(sessionsSeenPath(root), {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    at: now.toISOString(),
    // The round's own summary of its last pass, verbatim — the same sentence
    // that went into the log. `mc watch sessions status` shows it rather than
    // paraphrasing it, because a page with a second opinion about a pass
    // nobody watched is a page arguing with the log.
    last_round: lastRound,
    sessions,
  });
}

function blank() {
  return { at: null, last_round: null, sessions: {} };
}

/**
 * One conversation, as the next round needs to remember it.
 *
 * Deliberately small: the transcript's identity and size, whether anybody was
 * running it, and which flags are standing. Not the output, and not what the
 * model said about the output — the guard keeps no opinion between rounds
 * because it holds none.
 */
export function rememberSession(seen, { active = [], readAt = null } = {}) {
  return {
    area: seen.area,
    bytes: seen.bytes,
    updated_ms: seen.updated_ms,
    live: Boolean(seen.live),
    state: seen.state,
    turn: seen.turn,
    active: [...active].sort(),
    ...(readAt ? { read_at: readAt } : {}),
  };
}
