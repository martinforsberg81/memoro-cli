/**
 * How many steps `mc run` may have in flight — the setting behind
 * `mc run lanes [<n>] [--total <n>|none]`.
 *
 * Two numbers in one file, `~/.memoro/mc/lanes.json`, beside the gate lock and
 * the leases, written the way they are. Absent, unreadable or nonsense reads
 * as the default, which is exactly what the runner did before the setting
 * existed: an operator who sets nothing gets what they always got. Each number
 * falls back on its own, so a file with one good value and one bad one keeps
 * the good one. The runner reads them once, at start — a running runner keeps
 * what it was started with, and `mc run --update` (or stop and start) is how a
 * new value takes effect, which is what the verb says when it writes.
 *
 * `per_repo` is why per repository and not in total: memoro's lane and
 * memoro-cli's never touch (different mains, different worktrees), so the
 * number that matters is how many steps share one main — that is where two
 * landings meet at the gate, and where `landPr` now waits rather than losing
 * one. It is a correctness number.
 *
 * `total` is the other question, and not a substitute for that one: it bounds
 * this machine — CPU, memory, API quota, and how much of a fleet one person
 * can follow — across every repository at once. `mc run lanes 3` on two
 * repositories is six sessions, and until this number existed nothing in the
 * code objected. Absent means no total cap, so it changes nothing for anybody
 * who does not set it; set, it and `per_repo` both bind and the smaller wins.
 *
 * A count of sessions is a proxy for load, not a measurement of it. Memory and
 * API quota are the honest measurements and neither is read here. Anyone about
 * to build a resource guard on this number should know it is standing in for
 * one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';

export const LANES_MIN = 1;
export const LANES_MAX = 8;
export const DEFAULT_LANES = 1;
/** What `--total` takes to mean "no total cap", written as an absent `total`. */
export const LANES_NONE = 'none';

export function laneCountPath(root = mcHome()) {
  return join(root, 'lanes.json');
}

/** A value in 1..8, or null for anything else — absent, nonsense, out of range. */
function inRange(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= LANES_MIN && n <= LANES_MAX ? n : null;
}

/**
 * The pair as set: `{ per_repo, total }`, `per_repo` 1 when unset and `total`
 * null for no cap. Never throws: a broken file is the default, not a wall.
 */
export function readLaneCount({ root = mcHome() } = {}) {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(laneCountPath(root), 'utf8'));
  } catch {
    raw = null;
  }
  return { per_repo: inRange(raw?.per_repo) ?? DEFAULT_LANES, total: inRange(raw?.total) };
}

/**
 * Set one of the two, leaving the other as it was: the file is written whole,
 * so it is read and merged first. `field` is `per_repo` (the default, which is
 * what the bare positional has always meant) or `total`, and `total` also
 * takes `none` for no cap.
 *
 * Returns `{ ok, field, count, per_repo, total }` — the pair as the file now
 * holds it — or `{ ok: false, reason }` naming the forms it accepts.
 */
export function writeLaneCount(value, { field = 'per_repo', root = mcHome(), now = new Date() } = {}) {
  const total = field === 'total';
  const none = total && typeof value === 'string' && value.trim().toLowerCase() === LANES_NONE;
  const n = none ? null : inRange(value);
  if (!none && n === null) {
    const forms = `a whole number from ${LANES_MIN} to ${LANES_MAX}${total ? `, or ${LANES_NONE} for no cap` : ''}`;
    const what = total ? 'lanes --total is' : 'lanes is';
    return { ok: false, reason: `${what} ${forms}, not ${JSON.stringify(value)}` };
  }
  const next = readLaneCount({ root });
  next[field] = n;
  writeJsonAtomic(laneCountPath(root), { ...next, set: now.toISOString() }, { mode: 0o600 });
  return { ok: true, field, count: n, ...next };
}
