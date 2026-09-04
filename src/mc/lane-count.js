/**
 * How many steps `mc run` may have in flight per repository — the setting
 * behind `mc run lanes [<n>]`.
 *
 * One number in one file, `~/.memoro/mc/lanes.json`, beside the gate lock and
 * the leases, written the way they are. Absent, unreadable or nonsense reads
 * as 1, which is exactly what the runner did before the setting existed: an
 * operator who sets nothing gets what they always got. The runner reads it
 * once, at start — a running runner keeps the count it was started with, and
 * `mc run --update` (or stop and start) is how a new count takes effect,
 * which is what the verb says when it writes.
 *
 * Why per repository and not in total: memoro's lane and memoro-cli's never
 * touch (different mains, different worktrees), so the number that matters
 * is how many steps share one main — that is where two landings meet at the
 * gate, and where `landPr` now waits rather than losing one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';

export const LANES_MIN = 1;
export const LANES_MAX = 8;
export const DEFAULT_LANES = 1;

export function laneCountPath(root = mcHome()) {
  return join(root, 'lanes.json');
}

/** The count as set, or 1. Never throws: a broken file is the default, not a wall. */
export function readLaneCount({ root = mcHome() } = {}) {
  try {
    const raw = JSON.parse(readFileSync(laneCountPath(root), 'utf8'));
    const n = Number(raw?.per_repo);
    return Number.isInteger(n) && n >= LANES_MIN && n <= LANES_MAX ? n : DEFAULT_LANES;
  } catch {
    return DEFAULT_LANES;
  }
}

/** Set it. Returns `{ ok, count }` or `{ ok: false, reason }` for a value outside 1..8. */
export function writeLaneCount(value, { root = mcHome(), now = new Date() } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < LANES_MIN || n > LANES_MAX) {
    return { ok: false, reason: `lanes is a whole number from ${LANES_MIN} to ${LANES_MAX}, not ${JSON.stringify(value)}` };
  }
  writeJsonAtomic(laneCountPath(root), { per_repo: n, set: now.toISOString() }, { mode: 0o600 });
  return { ok: true, count: n };
}
