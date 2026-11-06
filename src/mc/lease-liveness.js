/**
 * Is the holder of a lease still working — asked of the process that holds it,
 * or of the board when the lease recorded no process.
 *
 * The incident this exists for: a lease reading `grindvarv #344` had stood for
 * 27 minutes with a silent holder, and to everybody looking at it that was
 * indistinguishable from one somebody had walked away from. It was neither. The
 * round was running, and it was minutes from being force-released out from
 * under itself.
 *
 * Age answers the wrong question. A gate round *should* take half an hour, and
 * a forgotten lease can be two minutes old, so no threshold separates the two.
 * What was missing was not a timeout — it was knowing whether the holder was
 * still at work.
 *
 * Derived, never reported in. A heartbeat would need the holder to run mc at
 * intervals, and the lease that looks deadest is precisely the one whose holder
 * is ten minutes into a suite run — which is exactly when no mc command runs at
 * all. A heartbeat would therefore have failed hardest in the case it was built
 * for. So nothing is written in for this: a lease that recorded its process
 * (lease-owner.js) is answered by the kernel about that process, and a lease
 * that did not is answered by the board, which reads every work area's
 * processes and transcripts at the moment of asking. No file, no clock, no expiry.
 *
 * The board stopped carrying merge rounds (2026-10-31, mc/lane-holder-and-push-
 * guard): a merge round holding the lane is on no board, so the board's answer
 * for it was always "nothing called … is on the board", which hid the merger.
 * A round that recorded its process is answered from that process instead, and
 * the board is not asked about it at all.
 *
 * And it says `unknown` rather than guessing. A holder outside the work root —
 * a person's own shell, `user@host` — has no row on the board at all, and an
 * empty row must never be shown as though it meant "dead": that reading is what
 * would license the force-release this whole thing exists to prevent. The
 * reverse holds for a recorded process that is gone: that is `dead`, said as
 * the fact the kernel gave, because a missing process is an answer and not an
 * absence.
 */
import { workStatus } from './work-status.js';

/**
 * What a holder's liveness can be.
 *
 * `working` and `waiting` are the board's own words for a conversation that is
 * mid-turn and one that has stopped and wants a person. `idle` is an area with
 * nothing running in it. `dead` is a recorded process that is gone. `unknown`
 * is the honest answer, and the only one that is ever inferred from an absence.
 */
export const LIVENESS = Object.freeze(['working', 'waiting', 'idle', 'dead', 'unknown']);

/**
 * Read the board once for a set of leases, and answer for each holder.
 *
 * Asked for the holders by name and without git, because the question is "is
 * this area alive", not "what is in its worktrees" — the git half is all of the
 * board's cost and none of this answer.
 *
 * A lease nobody holds gets no liveness at all: there is no holder to ask
 * about, and `null` says that without pretending it is a fourth state.
 */
export async function livenessForLeases(leases, { env = process.env, status = null } = {}) {
  const held = leases.filter((lease) => lease?.held);
  const answers = new Map();
  if (held.length === 0) return answers;

  // Only a work area whose lease did not record its process can be looked up on
  // the board: the others are answered by the process, or by nothing. A shell
  // holder is answered without asking, which also means a machine with no work
  // areas costs nothing.
  const names = [...new Set(held
    .filter((lease) => lease.holder_kind === 'work-area' && asksBoard(lease))
    .map((lease) => lease.holder))];

  let report = status;
  if (!report && names.length) {
    try {
      report = await workStatus({ env, names, git: false });
    } catch {
      // The board itself failed. That is not evidence about anybody's holder,
      // so every answer below falls through to `unknown` — which is what it
      // means: mc could not find out.
      report = null;
    }
  }

  const areas = new Map((report?.areas || []).map((area) => [area.name, area]));
  for (const lease of held) answers.set(lease.holder, livenessOf(lease, areas));
  return answers;
}

/**
 * One holder, against the board's areas.
 *
 * Exported for the single-lease path (`mc repo who`), which has one lease and
 * no reason to build a map first.
 */
export function livenessOf(lease, areas) {
  if (!lease?.held) return null;
  // The lease recorded its process: that process answers, and the board is not
  // asked. This is the merge round's answer, and it is the only one a merger
  // can give.
  if (Number.isInteger(lease.owner_pid)) return processAnswer(lease);
  // A merge round with no pid (taken before one was recorded) has no way to be
  // asked, and the board does not carry it. Said so, and not looked up.
  if (roundOf(lease) !== null) return unknown('its merger recorded no process, so mc cannot see whether it is running');
  if (lease.holder_kind !== 'work-area') {
    return unknown('the holder is a shell, not a piece of work the board can see');
  }
  const area = areas.get(lease.holder);
  if (!area) return unknown(`nothing called “${lease.holder}” is on the board`);

  const lastSeen = area.conversations.reduce(
    (latest, item) => Math.max(latest, item.updated_ms || 0),
    0,
  );
  return {
    source: 'board',
    state: area.working ? 'working' : area.waiting ? 'waiting' : 'idle',
    // Rounded because a transcript's modification time arrives with the file
    // system's sub-millisecond fraction, and a timestamp with a decimal point
    // in it reads as a measurement rather than as the clock it is.
    last_seen_ms: lastSeen ? Math.round(lastSeen) : null,
    known: true,
    reason: null,
  };
}

/**
 * A holder answered by the process it recorded.
 *
 * `owner_alive` is the kernel's word (lease-owner.js), so a gone process reads
 * `dead`: a statement, not the absence `unknown` is. The round and how long it
 * has held come from the lease's own errand and clock, so the line can name the
 * merger, its PR and its duration.
 */
function processAnswer(lease) {
  const facts = {
    source: 'process',
    pid: lease.owner_pid,
    round: roundOf(lease),
    since: lease.since ?? null,
    held_ms: Number.isFinite(lease.age_ms) ? lease.age_ms : null,
    last_seen_ms: null,
    reason: null,
  };
  if (lease.owner_alive === true) return { ...facts, state: 'working', known: true };
  if (lease.owner_alive === false) return { ...facts, state: 'dead', known: true };
  return unknown(`its process (pid ${lease.owner_pid}) could not be asked`);
}

/** Only a lease that recorded no process, and is not a merge round, is a board question. */
function asksBoard(lease) {
  return !Number.isInteger(lease.owner_pid) && roundOf(lease) === null;
}

/** The PRs a merge round is for, as its errand names them (`#14600`, or `#1 #2`). `null` for any other errand. */
export function roundOf(lease) {
  const match = /^merge round for (.+)$/u.exec(lease?.errand || '');
  return match ? match[1] : null;
}

function unknown(reason) {
  return { state: 'unknown', last_seen_ms: null, known: false, reason };
}
