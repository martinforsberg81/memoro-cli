/**
 * The standing red set, written down — so it can only get smaller.
 *
 * The gate's verdict is differential: it compares the candidate's red set
 * against a baseline measured in the same round, and passes when nothing new
 * went red. That is the right rule and this file does not touch it. What it
 * adds is the thing the rule structurally cannot see.
 *
 * Inside one round a rise is always visible — if the candidate has more red
 * names than the baseline, at least one of them is not in the baseline, so it
 * is in `broke` and the gate is red. That was checked against `compareRed`
 * over every subset pair of a six-name universe: zero rounds where the count
 * rose and `broke` was empty. A brand new test that is born red is caught for
 * the same reason; it is red on the candidate and absent from the baseline, so
 * set difference puts it straight into `broke`.
 *
 * The leak is *between* rounds. Every round measures main afresh and remembers
 * nothing, so whatever main is red at is simply accepted as the new floor. A
 * name that reaches main by any path this gate did not stand in — a merge by
 * hand, a direct push, a round nobody ran — becomes part of the baseline, and
 * from then on the gate reports "no new red" over it forever. Fifty-five
 * standing red names got there that way. Nothing in a memoryless comparison
 * can notice a floor that has moved.
 *
 * So the floor is written down, in the repository, in the diff, where a rise
 * has to be reviewed by somebody instead of inherited by the next round.
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
 * Lowering it is therefore a commit somebody makes, and the gate prints
 * exactly which names to remove so that commit is a paste rather than an
 * investigation. That also keeps the property that makes the file worth
 * having: every movement of the floor, in either direction, is in somebody's
 * diff.
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

  let parsed = null;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch {
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
 * The red set now against the floor that was agreed.
 *
 * `risen` is the verdict — names red on this round that nobody wrote down.
 * `fallen` decides nothing, for the reason in this file's header: it is what
 * the gate offers the next commit, not something it acts on.
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
