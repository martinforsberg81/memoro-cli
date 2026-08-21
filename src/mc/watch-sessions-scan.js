/**
 * The half of the guard that is arithmetic.
 *
 * Everything with a deterministic answer is script, not model (design note §4,
 * KP-05's second law). Whether a transcript has moved, how long ago it moved,
 * whether the process holding it is gone, whether mail is sitting unread in an
 * inbox, whether the wake guard would refuse this pane — all of that is
 * subtraction and the filesystem, and none of it is worth a model turn. The
 * model is let in exactly once, in `watch-sessions-read.js`, where the output is
 * prose and reading it needs interpretation.
 *
 * Six patterns, and the guard's whole vocabulary:
 *
 *   waiting        script  stopped for a person, and has been for a while
 *   silent         script  meant to be working, and nothing has come out
 *   dead           script  it was alive last round, its turn never finished
 *   unreachable    script  mail it has not read, in a pane no wake can reach
 *   stalled        script  an order it was given has not moved in twelve hours
 *   blocked        model   it says it is stuck on something it cannot get
 *   quota-exhausted model  it says it ran out
 *   error          model   something in the output failed
 *
 * There is no eighth, there is no severity, and there is no order. The guard
 * flags; it does not decide and it does not rank.
 */
import { readdirSync } from 'node:fs';

import { DEFAULT_SILENT_MS, DEFAULT_WAITING_MS } from './watch-sessions-store.js';
import { inboxPath } from './work-send.js';
import { listOpenTasks } from './task-log.js';

export const SCRIPT_PATTERNS = Object.freeze(['waiting', 'silent', 'dead', 'unreachable', 'stalled']);
export const MODEL_PATTERNS = Object.freeze(['blocked', 'quota-exhausted', 'error']);
export const PATTERNS = Object.freeze([...SCRIPT_PATTERNS, ...MODEL_PATTERNS]);

/**
 * Turn one status report into the guard's own view of it.
 *
 * The report is `workStatus()` — the same page `mc status` draws, asked for
 * without git because the guard never looks at a branch. Using it rather than
 * counting for itself is the point: the guard and the board cannot disagree
 * about which conversations exist or which are running, because there is one
 * answer and the guard is not its author.
 */
export function scanSessions({
  report,
  previous = {},
  now = Date.now(),
  waitingMs = DEFAULT_WAITING_MS,
  silentMs = DEFAULT_SILENT_MS,
  inbox = countInbox,
  reachable = null,
  tasks = listOpenTasks,
  stalledMs = STALLED_MS,
} = {}) {
  const sessions = [];
  for (const area of report.areas || []) {
    for (const conversation of area.conversations || []) {
      sessions.push(oneSession({
        area, conversation, previous: previous[conversation.id] || null, now, waitingMs, silentMs,
      }));
    }
  }
  // Asked once per area rather than once per conversation: the inbox and the
  // pane belong to the area, and an area with three conversations in it would
  // otherwise be read three times and flagged three times for one piece of
  // unread mail.
  //
  // It is hung on the area's live conversation because that is what the memory
  // is keyed by. If which conversation is live changes while the mail is still
  // unread, the flag is written a second time — one extra line, and it errs in
  // the direction the design asks for: a flag repeated costs a glance, and a
  // flag withheld is invisible.
  const areaFlags = [
    ...unreachableAreas({ report, sessions, inbox, reachable }),
    ...stalledAreas({ sessions, tasks, now, stalledMs }),
  ];
  for (const flag of areaFlags) {
    const owner = sessions.find((item) => item.area === flag.area && item.live)
      || sessions.find((item) => item.area === flag.area);
    if (owner) owner.patterns.push({ pattern: flag.pattern, detail: flag.detail });
  }
  return { at: new Date(now).toISOString(), sessions };
}

function oneSession({
  area, conversation, previous, now, waitingMs, silentMs,
}) {
  const quiet = now - (conversation.updated_ms || 0);
  const patterns = [];

  // Alive last round, gone this round, and its last turn never finished. That
  // is the pane that died mid-work — the failure that cost an hour on
  // 2026-08-17 and the reason KP-05 exists.
  //
  // It needs the previous round to mean anything: without it, every
  // conversation ever abandoned mid-sentence would read as having just died,
  // and the guard's first round would flag the whole machine. So the first
  // sighting of a conversation can never be `dead`, and that is correct rather
  // than a gap — the guard did not see it die.
  if (previous?.live && !conversation.live && conversation.turn === 'working') {
    patterns.push({ pattern: 'dead', detail: 'it was running last round; its last turn never finished' });
  }

  if (conversation.live && conversation.state === 'working' && quiet > silentMs) {
    patterns.push({ pattern: 'silent', detail: `working, but nothing has come out for ${describeSpan(quiet)}` });
  }

  if (conversation.live && conversation.state === 'waiting' && quiet > waitingMs) {
    patterns.push({ pattern: 'waiting', detail: `stopped and waiting for ${describeSpan(quiet)}` });
  }

  const changed = previous === null
    || previous.bytes !== conversation.bytes
    || previous.updated_ms !== conversation.updated_ms;

  return {
    id: conversation.id,
    area: area.name,
    tool: conversation.tool,
    path: conversation.path,
    bytes: conversation.bytes,
    updated_ms: conversation.updated_ms,
    live: Boolean(conversation.live),
    state: conversation.state,
    turn: conversation.turn,
    // The cost gate, computed here and honoured by the round: only a live
    // conversation whose transcript actually moved is worth a model turn.
    changed,
    readable: Boolean(conversation.live) && changed,
    patterns,
    was: previous?.active || [],
  };
}

/**
 * Mail delivered into a session that cannot be knocked on.
 *
 * `--wake` closed the loop for a session that is idle and reachable. It cannot
 * close it for a session the knock never gets to, and there are three ways
 * that happens. All three are facts rather than opinions — the unread mail is
 * files in a directory, and the rest is the channel's own answer — so all
 * three are script, and none of them is a model looking at a screen.
 *
 *  1. Somebody is attached to the pane. The client guard refuses, correctly:
 *     the cleanup keystroke would land on their half-written sentence.
 *  2. There is unsent text in the prompt. It refuses again, correctly again:
 *     typing after it produces one pasted-together sentence. Measured
 *     2026-08-21 — a worker sat with its own half-typed line in the box while
 *     an order it had never read lay in its inbox.
 *  3. mc cannot address the session at all. Added 2026-08-22, after PM
 *     measured it on nine of mc's own sessions: waking looks up the tmux
 *     session `mc-<area>`, and those nine ran under short names of their own.
 *     Every send delivered the file and never even tried to knock, and mc
 *     said "nothing is running" — which reads as "never started" rather than
 *     "started, and out of reach".
 *
 * The third is the quietest and the only one that leaves no trace at all: the
 * other two at least say they refused. That is why it is worth its own reason
 * rather than being folded into "not running".
 *
 * An area with no live conversation is still not flagged. Mail waiting for a
 * session that genuinely is not running gets read when it boots — that is the
 * designed path, and flagging it would make every finished session a standing
 * flag. The live conversation is what separates the two, and the status board
 * decides that from the operating system rather than from tmux — which is
 * exactly why it can see a session tmux cannot name.
 */
function unreachableAreas({ report, sessions, inbox, reachable }) {
  if (!reachable) return [];
  const flags = [];
  for (const area of report.areas || []) {
    const unread = inbox(area.path);
    if (unread.count === 0) continue;
    if (!sessions.some((item) => item.area === area.name && item.live)) continue;
    const verdict = reachable(area.name);
    if (!verdict || verdict.ok) continue;
    flags.push({
      area: area.name,
      pattern: 'unreachable',
      detail: `${unread.count} unread in inbox/, oldest ${unread.oldest}`
        + `, and ${verdict.reason}`,
    });
  }
  return flags;
}

/**
 * Unprocessed mail: files at the top level, excluding `README.md`.
 *
 * The same rule the round counts PM's inbox by (§3). Archiving into
 * `inbox/archive/` is what makes an item processed, so a directory is never an
 * item and a file that is still lying there is.
 */
/**
 * Twelve hours, and the note picked the number (§6).
 *
 * Long enough that a session working steadily through a hard order is never
 * flagged for taking its time, short enough that an order nobody ever started
 * is found the same day it was given.
 */
export const STALLED_MS = 12 * 60 * 60_000;

/**
 * An order that was given and has not moved.
 *
 * The task journal (D-0113) is append-only and the current state is the replay
 * of its lines, which is exactly what makes this a timestamp subtraction over
 * the last line rather than something that has to be kept in sync. So it is
 * script, as §6 says it is — the guard was named there as one of the four
 * readers, and this is that reading.
 *
 * It says how many and how long and gives the id, and it does not say what the
 * task was about. That is the round's rule for the inbox (§3) applied to the
 * same kind of thing: naming the order would be the guard summarising work it
 * has no opinion about.
 *
 * Only for an area the guard can see; a task addressed to a session that does
 * not exist on this machine is somebody else's problem to notice.
 */
function stalledAreas({ sessions, tasks, now, stalledMs }) {
  if (!tasks) return [];
  const known = new Set(sessions.map((item) => item.area));
  const byArea = new Map();
  for (const task of tasks()) {
    if (!known.has(task.session)) continue;
    const moved = Date.parse(task.updated_at || task.opened_at || '');
    if (!Number.isFinite(moved) || now - moved <= stalledMs) continue;
    const found = byArea.get(task.session) || [];
    found.push({ id: String(task.id).slice(0, 8), since: now - moved });
    byArea.set(task.session, found);
  }
  const flags = [];
  for (const [area, found] of byArea) {
    const oldest = found.reduce((a, b) => (a.since >= b.since ? a : b));
    flags.push({
      area,
      pattern: 'stalled',
      detail: `${found.length} open task${found.length === 1 ? '' : 's'} not moved`
        + ` in over ${describeSpan(stalledMs)}, oldest ${describeSpan(oldest.since)} (${oldest.id})`,
    });
  }
  return flags;
}

export function countInbox(areaPath) {
  let entries = [];
  try { entries = readdirSync(inboxPath(areaPath), { withFileTypes: true }); } catch { return { count: 0, oldest: null }; }
  const items = entries
    .filter((entry) => entry.isFile() && entry.name !== 'README.md' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  return { count: items.length, oldest: items[0] || null };
}

/** Hours and minutes, because "4h12m" is read faster than 15120000. */
export function describeSpan(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}
