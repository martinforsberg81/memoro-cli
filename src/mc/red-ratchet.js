/**
 * The standing red set, written down — a statement about main, not a gate.
 *
 * ## Nothing in a round reads this any more
 *
 * Read this first, because the rest of the file is the argument for a
 * mechanism the round no longer runs. On 2026-08-31 Martin ruled that a round
 * evaluates the diff and nothing else: a test the change reaches is either
 * green, or the round is red. Whether main was already red — the question this
 * file was built to keep honest — is not asked at a merge. So the gate's
 * consultation of the floor went out with the baseline it was compared
 * against, and `mc test` and `mc merge` neither read nor report it.
 *
 * What still reads it is `enforcement.js`, which asks whether a repository
 * carrying standing red has recorded a floor at all. That check is fed by the
 * round log's `standing_red`, which new rounds no longer write — so it answers
 * only from lines older than the ruling, and will fall silent as they age out.
 * Whether a floor for main is worth keeping anywhere is a separate question
 * and was deliberately left open; this file is kept, unused by the round,
 * rather than deleted on the way past.
 *
 * The rest of this header is the reasoning as it stood, kept because the two
 * arguments below outlived the mechanism.
 *
 * ## What it used to do, twice over
 *
 * Until 2026-08-30 a red name absent from this list *stopped the round*. That
 * rule could not fire on a fault the pull request introduced: the differential
 * comparison had already returned on anything red on the candidate and green
 * on the base, so by the time the floor was consulted every name it could stop
 * on was already red on main. It refused changes for something it
 * simultaneously said was not their fault, and the demonstration arrived the
 * same day — `codex` was installed but unrunnable on this laptop, thirteen
 * broker tests were red for that reason alone, and they sat above the floor.
 * What is installed on a machine has nothing to do with whether a change may
 * land.
 *
 * From then until 2026-08-31 it reported instead: main above its own floor was
 * said loudly, into the round log, and never refused anybody's change. One
 * stop survived, and it was genuinely about the diff — a pull request removing
 * names from this file while those tests are still red is lowering the floor
 * under failing tests. That stop went with the rest: it needed both the floor
 * on main and a measurement of main to check the claim, and the round has
 * neither now.
 *
 * ## Names, not a count
 *
 * The set is names, and a rise means a name that is not in it. The obvious
 * cheaper design — store the number, fail when it goes up — was measured and
 * rejected. Two rounds hours apart on this repository gave 55 and then 56 red
 * names, and the fifty-sixth was green again on the next run: one
 * load-sensitive test (`fails explicitly when workspace preparation never
 * settles`) on a machine with three other builders on it. A count ratchet
 * would have written down 55, then failed the next perfectly good pull request
 * because the machine was busy. A gate that fails at random is worse than the
 * word it was built to correct, because people stop reading it.
 *
 * A name-set ratchet breathes with that test for free. The flaky name is in
 * the set, so it appearing is not a rise and it vanishing is not a fall that
 * anything acts on. No list of known-flaky names to maintain, no second
 * mechanism to keep in agreement with the first — the information is already
 * in the names, which is the whole reason the red set is named rather than
 * counted one layer down in `tap-red.js`.
 *
 * ## Why nothing here writes the file
 *
 * The obvious next step is for the merge round to write the smaller set down
 * automatically when tests come good. It must not, and the reason is the same
 * measurement. A lucky round where the load-sensitive test passes would evict
 * it from the set; the next round where it does not would then read as a rise
 * and fail a pull request that changed nothing. Automatic tightening turns
 * every flaky green into a trap laid for the next author.
 *
 * Lowering it is therefore a commit somebody makes. That also keeps the
 * property that makes the file worth having: every movement of the floor, in
 * either direction, is in somebody's diff.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RATCHET_SCHEMA = 'mc-red-ratchet';
export const RATCHET_VERSION = 1;

/** Where a repository records its standing red set, relative to its root. */
export const RATCHET_FILE = join('.mc', 'red-ratchet.json');

/** The absolute path, for a checkout or a gate worktree. */
export function ratchetPath(dir) {
  return join(dir, RATCHET_FILE);
}

/**
 * The recorded set, or the reason there is not one.
 *
 * Absent is not an error. Most repositories have no ratchet and the round runs
 * exactly as it did before; the gate says the floor is unrecorded rather than
 * inventing one, because a floor mc guessed at is a floor nobody agreed to.
 *
 * A file that is present and unreadable is different, and it is a stop. The
 * failure mode to avoid is a malformed ratchet being read as an empty set,
 * which would make every standing red name look like a rise — a gate that
 * fails everything on a typo, having first told the operator that the typo was
 * fine.
 */
export function readRatchet(dir) {
  const path = ratchetPath(dir);
  if (!existsSync(path)) {
    return { present: false, ok: true, path, names: [], reason: 'no standing red set is recorded for this repository' };
  }
  let raw = null;
  try { raw = readFileSync(path, 'utf8'); } catch {
    return { present: true, ok: false, path, names: [], reason: `${RATCHET_FILE} could not be read` };
  }
  return parseRatchet(raw, path);
}

/**
 * The floor as it stands on a ref, without a worktree.
 *
 * The base branch's own floor is what says whether a change *lowered* it, and
 * the baseline worktree is not always built — a carried baseline (A1) skips
 * it entirely. `git show` needs no worktree and is always available, so the
 * comparison does not quietly stop happening on exactly the rounds that are
 * cheapest.
 *
 * Absent is not an error, the same as for a checkout: a base branch with no
 * floor is a repository that has not recorded one.
 */
export function ratchetAtRef({ git, ref, cwd }) {
  const path = `${ref}:${RATCHET_FILE}`;
  let out = null;
  try { out = git(['show', path], { cwd }); } catch {
    return { present: false, ok: true, path, names: [], reason: `${RATCHET_FILE} could not be read at ${ref}` };
  }
  // A missing path is a nonzero status from real git; an empty body is what a
  // stub gives back. Both mean the same thing — there is no floor here — and
  // neither is a malformed file.
  if (!out || out.status !== 0 || !String(out.stdout || '').trim()) {
    return { present: false, ok: true, path, names: [], reason: `no ${RATCHET_FILE} at ${ref}` };
  }
  return parseRatchet(out.stdout, path);
}

/** One parser, so a floor read from a checkout and one read from a ref cannot disagree. */
export function parseRatchet(text, path) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    return { present: true, ok: false, path, names: [], reason: `${RATCHET_FILE} is not readable JSON` };
  }
  if (!parsed || !Array.isArray(parsed.names)) {
    return { present: true, ok: false, path, names: [], reason: `${RATCHET_FILE} has no "names" array` };
  }
  if (parsed.names.some((name) => typeof name !== 'string')) {
    return { present: true, ok: false, path, names: [], reason: `${RATCHET_FILE} has a "names" entry that is not a string` };
  }

  // Deduplicated on the way in, so a name written twice by hand cannot make the
  // recorded floor look higher than the set it actually describes.
  return { present: true, ok: true, path, names: [...new Set(parsed.names)], reason: null };
}

/**
 * A red set against the floor that was agreed.
 *
 * `risen` is names red that nobody wrote down. Applied to *main's* red set it
 * is main's drift, which is reported; it is no longer applied to the
 * candidate's, for the reason in this file's header.
 *
 * `fallen` decides nothing and must not be read as a to-do. A name can fall
 * out of the red set because the machine changed rather than because the code
 * did — thirteen fell on 2026-08-30 when a broken `codex` install was
 * repaired, and removing them would have made this laptop's package manager a
 * precondition for merging.
 */
export function compareRatchet(accepted, red) {
  const floor = new Set(accepted);
  const now = new Set(red);
  return {
    risen: red.filter((name) => !floor.has(name)),
    fallen: accepted.filter((name) => !now.has(name)),
  };
}

/**
 * The file, as it should be written.
 *
 * Sorted, because the point of it is to be read in a diff: insertion order
 * would make an unrelated round reshuffle fifty lines and bury the one that
 * changed. `standing_red` is the count of the names beside it — a convenience
 * for a person opening the file, never read back by anything here, so it
 * cannot become a second answer that disagrees with the first.
 *
 * `note` is the same kind of thing: where this floor came from, for whoever
 * opens the file wondering who agreed to fifty-five failing tests. A JSON file
 * cannot carry a comment and this one is going to be read by people more often
 * than by anything else.
 */
export function renderRatchet(names, { note = null } = {}) {
  const sorted = [...new Set(names)].sort();
  return `${JSON.stringify({
    schema: RATCHET_SCHEMA,
    version: RATCHET_VERSION,
    ...(note ? { note } : {}),
    standing_red: sorted.length,
    names: sorted,
  }, null, 2)}\n`;
}
