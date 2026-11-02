/**
 * How many headless sessions `mc run` may run at once — the setting behind
 * `mc run lanes [<n>]`.
 *
 * One number, `lanes`, in `~/.memoro/mc/lanes.json`, beside the gate lock and
 * the leases, written the way they are. It is the total: every repository and
 * every kind of session (plan, build, review) share it, and a free lane takes
 * the next work of any of them (`lane-pick.js`). The merge lanes, one per
 * repository (ruling 61), are not these lanes and are not counted here.
 *
 * Absent, unreadable or nonsense reads as `DEFAULT_LANES`, which is what the
 * runner did with no file before this: one lane on each of two repositories.
 * The runner reads it live, starting a missing lane on its next poll and
 * ending one above it after its session; neither needs `mc run --update`.
 *
 * Until 2026-11-02 the file held two numbers, `per_repo` (that many lanes on
 * each repository) and `total` (a cap across both), and the smaller of
 * `per_repo × repositories` and `total` was what the machine ran. A file in
 * that shape is read once into the new number — the count it actually
 * allowed — and written back. Every write also keeps `per_repo` and `total`
 * beside `lanes`, set so that a runner older than the total reads the same
 * number of lanes from them (`legacyFields`): an old and a new runner run side
 * by side through a handover (`mc run --update`), and on 2026-11-02 the old one
 * read a file with `lanes` alone as one lane per repository. The new reader
 * never reads them while `lanes` is there.
 *
 * The file is under `MC_HOME` (`mcHome()`), like every other piece of mc's
 * state there: a probe or test that sets `MC_HOME` reads and migrates its own
 * copy and never the person's.
 *
 * A count of sessions is a proxy for load, not a measurement of it. Memory and
 * API quota are the honest measurements and neither is read here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';

export const LANES_MIN = 1;
/**
 * Sixteen, because that is what the old pair allowed at most: `per_repo` 8 on
 * each of two repositories, with no total. A file set that way migrates to the
 * sixteen it ran, not to a clamped eight.
 */
export const LANES_MAX = 16;
/** The old reader's bound on each of its two fields. */
const LEGACY_MAX = 8;
/** What no file meant before the total: one lane on each of two repositories. */
export const DEFAULT_LANES = 2;

/** What `per_repo` and `--total` became, for the line that refuses them. */
export const LANES_REPLACED = 'mc run lanes <n> is the total number of headless sessions across every repository; per_repo and --total are gone';

export function laneCountPath(root = mcHome()) {
  return join(root, 'lanes.json');
}

/** A value in 1..16, or null for anything else — absent, nonsense, out of range. */
function inRange(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= LANES_MIN && n <= LANES_MAX ? n : null;
}

/** The old reader's range for one field: 1..8, or null. */
function legacyRange(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= LANES_MIN && n <= LEGACY_MAX ? n : null;
}

/**
 * What a file in the old shape allowed: `per_repo` on each of `repos`
 * repositories, capped by `total` when one was set — read with the old
 * reader's own bounds, 1 to 8 for each field, so the number is the one that
 * runner ran. Null when the file names neither field, so it is not old.
 */
export function migratedLanes(raw, repos = 2) {
  if (!raw || typeof raw !== 'object' || (!('per_repo' in raw) && !('total' in raw))) return null;
  const per = legacyRange(raw.per_repo) ?? 1;
  const all = per * Math.max(1, repos);
  const total = legacyRange(raw.total);
  return Math.min(LANES_MAX, total === null ? all : Math.min(all, total));
}

/**
 * The old pair that makes a runner older than the total run `lanes` sessions
 * across two repositories: `per_repo` that many (at most 8) and `total` the
 * same as a cap. Above 8 the old reader has no total that large, so `total` is
 * left out and it runs `per_repo` 8 on each, sixteen — at most what `lanes`
 * says only at 16, more below it. Such a runner is one finishing its steps
 * after a handover, and starts no new ones.
 */
export function legacyFields(lanes) {
  return lanes <= LEGACY_MAX ? { per_repo: lanes, total: lanes } : { per_repo: LEGACY_MAX, total: null };
}

/**
 * The total as set: `{ lanes, migrated }`, `migrated` the old `{ per_repo,
 * total }` when this read turned one into `lanes` (and wrote it back), null
 * otherwise. Never throws: a broken file is the default, not a wall, and a
 * migration that cannot be written is still read as migrated.
 */
export function readLaneCount({ root = mcHome(), repos = 2, now = new Date() } = {}) {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(laneCountPath(root), 'utf8'));
  } catch {
    raw = null;
  }
  const lanes = inRange(raw?.lanes);
  if (lanes !== null) return { lanes, migrated: null };
  const old = migratedLanes(raw, repos);
  if (old === null) return { lanes: DEFAULT_LANES, migrated: null };
  try {
    writeJsonAtomic(laneCountPath(root), { lanes: old, ...legacyFields(old), migrated: { per_repo: raw.per_repo ?? null, total: raw.total ?? null, at: now.toISOString() }, set: raw.set ?? null }, { mode: 0o600 });
  } catch { /* read as migrated all the same; the next read tries again */ }
  return { lanes: old, migrated: { per_repo: raw.per_repo ?? null, total: raw.total ?? null } };
}

/**
 * One value against the rule, without touching the file: `{ ok, count }`, or
 * `{ ok: false, reason }` naming the form it takes.
 */
export function laneValue(value) {
  const n = inRange(value);
  if (n === null) return { ok: false, reason: `lanes is a whole number from ${LANES_MIN} to ${LANES_MAX}, not ${JSON.stringify(value)}` };
  return { ok: true, count: n };
}

/** Set the total. Returns `{ ok, lanes }`, or `{ ok: false, reason }`. */
export function writeLaneCount(value, { root = mcHome(), now = new Date() } = {}) {
  const seen = laneValue(value);
  if (!seen.ok) return seen;
  writeJsonAtomic(laneCountPath(root), { lanes: seen.count, ...legacyFields(seen.count), set: now.toISOString() }, { mode: 0o600 });
  return { ok: true, lanes: seen.count };
}
