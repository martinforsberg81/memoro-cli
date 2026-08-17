/**
 * Is the holder of a lease still working — asked of the board, not of a clock.
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
 * for. The board already knows: a holder is a work area, and the board reads
 * every area's processes and transcripts at the moment of asking. So this asks
 * the board, and adds no file, no clock and no expiry.
 *
 * And it says `unknown` rather than guessing. A holder outside the work root —
 * a person's own shell, `user@host` — has no row on the board at all, and an
 * empty row must never be shown as though it meant "dead": that reading is what
 * would license the force-release this whole thing exists to prevent.
 */
import { workStatus } from './work-status.js';

/**
 * What a holder's liveness can be.
 *
 * `working` and `waiting` are the board's own words for a conversation that is
 * mid-turn and one that has stopped and wants a person. `idle` is an area with
 * nothing running in it. `unknown` is the honest answer, and the only one that
 * is ever inferred from an absence.
 */
export const LIVENESS = Object.freeze(['working', 'waiting', 'idle', 'unknown']);

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

  // Only a work area can be looked up. A shell holder is answered without
  // asking, which also means a machine with no work areas costs nothing.
  const names = [...new Set(held
    .filter((lease) => lease.holder_kind === 'work-area')
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
    state: area.working ? 'working' : area.waiting ? 'waiting' : 'idle',
    // Rounded because a transcript's modification time arrives with the file
    // system's sub-millisecond fraction, and a timestamp with a decimal point
    // in it reads as a measurement rather than as the clock it is.
    last_seen_ms: lastSeen ? Math.round(lastSeen) : null,
    known: true,
    reason: null,
  };
}

function unknown(reason) {
  return { state: 'unknown', last_seen_ms: null, known: false, reason };
}
