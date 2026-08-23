/**
 * The guard's round, and the loop around it.
 *
 * Kept apart from the process control (`watch-daemon.js`, shared with the
 * round) and from the runner that starts it, for one reason: a round is a plain
 * async function, so a test can run one with an injected clock and an injected
 * model and look at what it wrote, without spawning a daemon or spending a
 * turn.
 *
 * One round, in order:
 *
 *   1. Ask the status board what exists. Not a second implementation of it —
 *      the guard must not be able to disagree with `mc status` about which
 *      conversations are running.
 *   2. Work out the four script patterns (`watch-sessions-scan.js`).
 *   3. For the conversations whose output actually moved, and only those, spend
 *      one Haiku turn each (`watch-sessions-read.js`).
 *   4. Write what is newly true to the ledger. Not what is still true — a flag
 *      that stands for six rounds is one notice, not six.
 *   5. Knock only for `dead` and `quota-exhausted`, and mark those delivered.
 *      Everything else waits for the round to carry it (§5).
 *   6. Remember sizes and mtimes, so the next round can be cheap.
 */
import { mcHome } from './paths.js';
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_SILENT_MS,
  DEFAULT_WAITING_MS,
  readMemory,
  rememberSession,
  writeMemory,
} from './watch-sessions-store.js';
import { excerptOf, readOutput } from './watch-sessions-read.js';
import { scanSessions } from './watch-sessions-scan.js';
import { appendNotice, isUrgent } from './watch-notices.js';
import { knock } from './watch-sessions-knock.js';
import { readTailEntries } from './conversations.js';
import { reservedRoleName } from './roles.js';
import { backgroundTarget } from './work-open.js';
import { flushPendingWakes, paneWillTakeText, sendToArea } from './work-send.js';
import { workStatus } from './work-status.js';

/**
 * How many sessions one round will read, and how many at a time.
 *
 * These are the numbers that keep the expensive half of the guard inside its
 * interval on a loaded machine, and they are the only place the guard is
 * bounded rather than complete — so it says what it left.
 *
 * Two at a time. The tool takes around two minutes to start on a machine
 * already running six conversations, so reads have to overlap or one round
 * outlives its own interval; but every one of them is a process competing with
 * the very conversations being watched, and a watchman that slows the work
 * down has cost more than it found.
 *
 * Six a round, longest-unread first. What a round could not get to is logged
 * and comes first in the next one — a ceiling that rotates, never one that
 * quietly always drops the same session.
 *
 * The cheap half has no ceiling at all: waiting, silent, dead and unreachable
 * are computed for every conversation on the machine, every round, for about
 * five seconds of filesystem. That is the split the whole design turns on —
 * the complete pass is the free one.
 */
/** Every notice this file writes is the guard's, and says so. */
export const NOTICE_SOURCE = 'guard';

export const MAX_READS_PER_ROUND = 6;
export const READ_CONCURRENCY = 2;

export async function watchRound({
  root = mcHome(),
  now = Date.now(),
  waitingMs = DEFAULT_WAITING_MS,
  silentMs = DEFAULT_SILENT_MS,
  maxReads = MAX_READS_PER_ROUND,
  concurrency = READ_CONCURRENCY,
  status = null,
  read = null,
  send = null,
  reachable = null,
  flush = null,
  log = () => {},
} = {}) {
  const started = Date.now();
  // Wakes the guard refused on a draft, tried again first: a prompt that has
  // cleared since gets its knock now, and the rest of the round sees the
  // session as reachable again rather than flagging it a second time.
  try {
    (flush || flushPendingWakes)({ root, now: new Date(now), log });
  } catch (error) {
    log(`could not retry queued wakes: ${error?.message || String(error)}`);
  }
  const previous = readMemory({ root }).sessions;
  // Without git: the guard never looks at a branch, and the git questions are
  // all of the cost in that report.
  const report = await (status || (() => workStatus({ git: false })))();
  const scan = scanSessions({
    report, previous, now, waitingMs, silentMs, reachable: reachable || paneVerdict,
  });

  const { queue, deferred } = readingOrder(scan.sessions, previous, maxReads);
  if (deferred > 0) {
    log(`${deferred} changed session${deferred === 1 ? '' : 's'} not read this round — they are first in the next one`);
  }
  // Stamped whether the read succeeded or not, so a session the tool keeps
  // timing out on rotates to the back like any other instead of holding the
  // front of the queue for ever and starving the rest.
  const readAt = new Date(now).toISOString();
  let failedReads = 0;
  await inWaves(queue, concurrency, async (session) => {
    const outcome = await (read || defaultRead)(session);
    if (outcome.failed) {
      failedReads += 1;
      log(`could not read ${session.area}: ${outcome.failed}`);
    }
    session.patterns.push(...outcome.patterns);
    session.read_at = readAt;
  });

  // Newly true, not still true. `was` is what this conversation was already
  // flagged for at the end of the last round, so a session that has been
  // waiting for three hours is one notice from three hours ago rather than
  // thirty-six identical lines nobody will read.
  const fresh = [];
  const sessions = {};
  for (const session of scan.sessions) {
    const active = session.patterns.map((item) => item.pattern);
    for (const item of session.patterns) {
      if (session.was.includes(item.pattern)) continue;
      fresh.push({ session, ...item });
    }
    sessions[session.id] = rememberSession(session, {
      active,
      readAt: session.read_at || previous[session.id]?.read_at || null,
    });
  }

  const written = fresh.map(({ session, pattern, detail }) => ({
    pattern,
    notice: appendNotice({
      source: NOTICE_SOURCE, session: session.area, pattern, detail,
    }, { root, now: new Date(now) }),
  }));

  // A held suite right with nothing running is told to the one who holds it,
  // not only to PM through the ledger: the holder is the one who can end it,
  // and in the incident this is for the holder *was* PM and read nothing. One
  // file with a wake, once per flag (it is `fresh`, so not once per round).
  // Still the guard on the channel — the same component, one more recipient.
  const holding = fresh.filter((item) => item.pattern === 'holding');
  for (const { session, detail } of holding) {
    const deliver = send || ((message) => sendToArea(message));
    try {
      const told = deliver({ name: session.area, message: `mc watch sessions: you ${detail}`, wake: true });
      log(told?.ok
        ? `told ${session.area} it holds the suite right${told.woke ? '' : ` — delivered without waking (${told.reason || 'nobody to wake'})`}`
        : `could not tell ${session.area} about the suite right: ${told?.reason || 'send failed'}`);
    } catch (error) {
      log(`could not tell ${session.area} about the suite right: ${error?.message || String(error)}`);
    }
  }

  // The bound in §5, and the whole of it. Two classes knock; every other flag
  // sits in the ledger until the round carries it, which is what keeps exactly
  // one component in charge of the wake channel.
  const urgent = written.filter((item) => isUrgent(item.pattern)).map((item) => item.notice);
  let knocked = null;
  if (urgent.length > 0) {
    knocked = knock(urgent, { root, send: send || ((message) => sendToArea(message)), now: new Date(now) });
    log(knocked.ok
      ? `knocked for ${urgent.length} urgent flag${urgent.length === 1 ? '' : 's'}${knocked.woke ? '' : ` — delivered without waking (${knocked.reason || 'nobody to wake'})`}`
      : `could not deliver ${urgent.length} urgent flag${urgent.length === 1 ? '' : 's'}: ${knocked.reason}`);
  }

  // Stamped when the round finished, not when it started. The notices carry
  // the moment they were observed; this one answers "is anybody still
  // watching", and a round that spent five minutes waiting on the tool must
  // not read as five minutes behind.
  writeMemory(sessions, { root });

  return {
    at: scan.at,
    sessions: scan.sessions.length,
    live: scan.sessions.filter((item) => item.live).length,
    read: queue.length - failedReads,
    unreadable: failedReads,
    deferred,
    flagged: written.length,
    urgent: urgent.length,
    knocked: knocked?.ok ? urgent.length : 0,
    took_ms: Date.now() - started,
  };
}

/**
 * Which changed sessions get read, and in what order.
 *
 * Longest unread first, so a ceiling that bites rotates rather than starving
 * the same conversation every round. A conversation nobody has ever read comes
 * before one read an hour ago, which is what makes a session that has just
 * appeared get looked at immediately.
 */
export function readingOrder(sessions, previous, maxReads) {
  const changed = sessions.filter((session) => session.readable);
  changed.sort((a, b) => {
    const at = (id) => Date.parse(previous[id]?.read_at || '') || 0;
    return at(a.id) - at(b.id);
  });
  return { queue: changed.slice(0, maxReads), deferred: Math.max(0, changed.length - maxReads) };
}

async function defaultRead(session) {
  const excerpt = excerptOf(readTailEntries(session.path));
  return readOutput(excerpt);
}

/**
 * Could a wake reach this session right now, and if not, which way not?
 *
 * Three answers, and the scan only asks it for an area that has a live
 * conversation — so "no pane" here does not mean "nobody is working", it means
 * mc cannot find the pane of somebody who is. That is the third and quietest
 * failure: `backgroundTarget` looks up the tmux session `mc-<area>`, and a
 * session running under a name of its own is invisible to every wake mc will
 * ever send it, while `mc work send` reports "nothing is running".
 *
 * The reason is phrased to finish the sentence the scan starts, so the flag
 * reads as one line rather than two halves.
 */
function paneVerdict(name) {
  const target = backgroundTarget(name);
  if (!target) {
    return {
      ok: false,
      target: null,
      reason: `mc cannot address it: something is running in it, but no tmux pane stands in it (neither mc-${name} nor one found by its path) — started outside tmux`,
    };
  }
  // Read only — no probe, so a ghost (D-0151) reads as "drawn", never as a
  // typed draft — and the role-pane exception (D-0013) as the wake applies it.
  const verdict = paneWillTakeText({ target, attachedOk: reservedRoleName(name) });
  return { ok: verdict.ok, target, reason: verdict.reason ? `it cannot be woken: ${verdict.reason}` : null };
}

/** Run `work` over `items`, `size` of them at a time. */
async function inWaves(items, size, work) {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map((item) => work(item)));
  }
}

/**
 * Round, wait, round.
 *
 * A round that throws is logged and the loop goes on, for the same reason the
 * repository watcher's does: the guard exists so somebody notices, and one
 * session it could not read this minute is a gap in one round, never a reason
 * to stop watching the others.
 */
export async function watchLoop({
  intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(),
  rounds = Infinity, shouldStop = () => false, log = () => {}, now = null, ...rest
} = {}) {
  for (let round = 0; round < rounds && !shouldStop(); round += 1) {
    try {
      const outcome = await watchRound({ root, log, now: now ? now() : Date.now(), ...rest });
      log(`${outcome.sessions} conversations, ${outcome.live} live, ${outcome.read} read`
        + `${outcome.unreadable ? ` (${outcome.unreadable} could not be read)` : ''}`
        + `, ${outcome.flagged} flagged in ${Math.round(outcome.took_ms / 100) / 10}s`);
    } catch (error) {
      log(`round failed: ${error?.stack || error?.message || String(error)}`);
    }
    if (shouldStop()) break;
    // An interval after this round finished, not on a fixed clock: a round
    // that outlasts its interval must not queue another behind itself.
    await sleep(intervalMs, shouldStop);
  }
}

async function sleep(ms, shouldStop) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldStop()) return;
    await new Promise((resolve) => { setTimeout(resolve, Math.max(1, Math.min(200, deadline - Date.now()))); });
  }
}

/**
 * One sentence about the pass, written once and used twice.
 *
 * It goes into the log and into the memory, and `mc watch sessions status`
 * shows the stored one verbatim. Two wordings of the same pass would be a page
 * arguing with a log about a round nobody watched.
 */
export function summarise({
  sessions, live, read, unreadable, deferred, flagged, tookMs,
}) {
  return `${sessions} conversations, ${live} live, ${read} read`
    + `${unreadable ? ` (${unreadable} could not be read)` : ''}`
    + `${deferred ? `, ${deferred} left for next round` : ''}`
    + `, ${flagged} flagged in ${Math.round(tookMs / 100) / 10}s`;
}
