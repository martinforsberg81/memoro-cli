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
 * Eleven patterns, and the guard's whole vocabulary:
 *
 *   waiting        script  stopped for a person, and has been for a while
 *   silent         script  meant to be working, and nothing has come out
 *   dead           script  it was alive last round, its turn never finished
 *   unreachable    script  mail it has not read, in a pane no wake can reach
 *   unattended     script  stopped, with mail that arrived after it last moved
 *   quiet-group    script  nobody under a named prefix is working at all
 *   stalled        script  an order it was given has not moved in twelve hours
 *   holding        script  it holds the suite right, and nothing has run under it
 *   blocked        model   it says it is stuck on something it cannot get
 *   quota-exhausted model  it says it ran out
 *   error          model   something in the output failed
 *
 * There is no twelfth, there is no severity, and there is no order. The guard
 * flags; it does not decide and it does not rank.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SILENT_MS, DEFAULT_WAITING_MS } from './watch-sessions-store.js';
import { inboxPath } from './work-send.js';
import { listOpenTasks } from './task-log.js';

export const SCRIPT_PATTERNS = Object.freeze(['waiting', 'silent', 'dead', 'unreachable', 'unattended', 'quiet-group', 'stalled', 'holding']);

/**
 * Ten minutes stopped with unread mail, and the order picked the number
 * (B2, 2026-08-23: "N configurable, suggest 10"). The case it is for, measured
 * the same evening: a track idle for 9m36s with an answer it was waiting for
 * lying in its own inbox, and nothing said so to anybody.
 */
export const DEFAULT_IDLE_MS = 10 * 60_000;
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
  holdingMs = HOLDING_MS,
  idleMs = DEFAULT_IDLE_MS,
  arrivals = arrivedSince,
  groups = [],
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
    ...unattendedAreas({ report, sessions, now, idleMs, arrivals }),
    ...stalledAreas({ sessions, tasks, now, stalledMs }),
    ...holdingAreas({ report, holdingMs }),
  ];
  for (const flag of areaFlags) {
    const owner = sessions.find((item) => item.area === flag.area && item.live)
      || sessions.find((item) => item.area === flag.area);
    if (owner) owner.patterns.push({ pattern: flag.pattern, detail: flag.detail });
  }
  // A group is not a session, so its flag hangs on an entry of its own —
  // `group:<prefix>` — which the memory keeps like any other, so that a
  // group quiet for three rounds is one notice rather than three.
  for (const group of quietGroups({ sessions, groups, previous, now })) sessions.push(group);
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
 * Stopped, with mail it cannot have read (B2, 2026-08-23).
 *
 * "Unread" is not "files in inbox/": a work area does not archive, and an
 * inbox of fifty-five read files would flag its owner forever. A file that
 * arrived *after the conversation last moved* is one it cannot have read, and
 * that is a subtraction of two mtimes. A live conversation that has been
 * stopped for longer than `idleMs` with such a file is the track that stood
 * idle for 9m36s with its answer lying in its own inbox — the flag says the
 * area, how long, how many, and the oldest. It is urgent: the guard knocks
 * PM with it at once, and the round would otherwise carry it half an hour
 * later, which is the gap it exists to close.
 *
 * Mail that arrived while the session was working is not this: the session
 * will read it when its turn ends, or be woken by the sender's `--wake`.
 */
function unattendedAreas({ report, sessions, now, idleMs, arrivals }) {
  if (!arrivals) return [];
  const flags = [];
  for (const area of report.areas || []) {
    const live = sessions.find((item) => item.area === area.name && item.live);
    if (!live || live.state !== 'waiting') continue;
    const quiet = now - (live.updated_ms || 0);
    if (quiet <= idleMs) continue;
    const unread = arrivals(area.path, live.updated_ms || 0);
    if (unread.count === 0) continue;
    flags.push({
      area: area.name,
      pattern: 'unattended',
      detail: `stopped for ${describeSpan(quiet)} with ${unread.count} inbox file${unread.count === 1 ? '' : 's'}`
        + ` that arrived since it last moved, oldest ${unread.oldest}`,
    });
  }
  return flags;
}

/**
 * Nobody under a prefix is working (B2's second condition).
 *
 * Four tracks stood still for twenty to forty minutes one evening and every
 * one of them was, on its own, merely "waiting". Seen as a group they were
 * the whole of the work stopped. A group is named by prefix on `mc watch
 * sessions start --group msr-track-`; it is quiet when it has at least one
 * live conversation and none of them is working, and the flag says for how
 * long — the shortest time since any of them last moved, which is when the
 * last one stopped. A group with nothing live at all is not quiet, it is
 * finished or not started, and the board already says which.
 */
function quietGroups({ sessions, groups, previous, now }) {
  const entries = [];
  for (const prefix of groups || []) {
    const members = sessions.filter((item) => item.live && !item.id.startsWith('group:') && item.area.startsWith(prefix));
    const id = `group:${prefix}`;
    const patterns = [];
    if (members.length > 0 && !members.some((item) => item.state === 'working')) {
      const stoppedMs = Math.min(...members.map((item) => now - (item.updated_ms || 0)));
      patterns.push({
        pattern: 'quiet-group',
        detail: `none of ${members.length} live under ${prefix}* is working — the last stopped ${describeSpan(stoppedMs)} ago`
          + ` (${members.map((item) => item.area).sort().join(', ')})`,
      });
    }
    entries.push({
      id,
      area: `${prefix}*`,
      tool: null,
      path: null,
      bytes: 0,
      updated_ms: 0,
      live: members.length > 0,
      state: patterns.length ? 'quiet' : 'working',
      turn: null,
      changed: false,
      readable: false,
      patterns,
      was: previous[id]?.active || [],
    });
  }
  return entries;
}

/**
 * Fifteen minutes with nothing running. A gate round runs two suites with
 * git work between them — a minute or two of silence, not fifteen — and a
 * claim by hand precedes a run by seconds. Fifteen minutes of a held right and
 * no suite is a run that ended without its holder, or a holder who forgot.
 */
export const HOLDING_MS = 15 * 60 * 1000;

/**
 * The suite right, held with nothing running under it (D-0141 family).
 *
 * The board already showed "held 2h 25m · nothing running" for the whole of
 * the two hours and twenty-five minutes PM held the suite right after its own
 * round was killed — and nobody read the board. This flag is that row said to
 * somebody: the holder's live session, by name, and the round carries it to
 * PM. A process that is gone is said as that; a hold by hand is said as a
 * hold. Nothing is released here — the guard flags, it does not decide.
 *
 * Only a work-area holder can be flagged, because the flag hangs on a
 * session; a shell holder has none, and the board row is what there is.
 */
function holdingAreas({ report, holdingMs }) {
  const lease = report?.suite?.lease;
  if (!lease?.held || lease.holder_kind !== 'work-area') return [];
  const running = report.suite.running || [];
  if (running.length > 0) return [];
  if (!Number.isFinite(lease.age_ms) || lease.age_ms <= holdingMs) return [];
  const detail = lease.orphaned
    ? `holds the suite right for ${describeSpan(lease.age_ms)} and the process that took it (pid ${lease.owner_pid}) is gone — nothing is running; the next claim takes it, or mc suite release now`
    : `holds the suite right for ${describeSpan(lease.age_ms)} with no suite running${lease.errand ? ` (“${lease.errand}”)` : ''} — mc suite release if the run is over`;
  return [{ area: lease.holder, pattern: 'holding', detail }];
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

/**
 * Inbox files that arrived after a moment: top level, not `README.md`, and
 * with a modification time later than `sinceMs`. The oldest is named by file,
 * the way the round names PM's.
 */
export function arrivedSince(areaPath, sinceMs) {
  let entries = [];
  try { entries = readdirSync(inboxPath(areaPath), { withFileTypes: true }); } catch { return { count: 0, oldest: null }; }
  const items = entries
    .filter((entry) => entry.isFile() && entry.name !== 'README.md' && !entry.name.startsWith('.'))
    .filter((entry) => {
      try { return statSync(join(inboxPath(areaPath), entry.name)).mtimeMs > sinceMs; } catch { return false; }
    })
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
