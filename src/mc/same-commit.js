/**
 * Are two readings of a commit the same commit? One function for the page's
 * production line (`page-collect.js`) and for the check after a deploy
 * (`deploy-check.js`), so they cannot disagree about it.
 */

/** The shortest sha two readings may be compared on: git's own abbreviation. */
export const SHA_MIN = 7;

/**
 * Compared on the shorter of the two.
 *
 * `deploys.tsv` records the full 40-character sha and `/api/version` answers
 * the 7-character one, so `!==` said *mismatch* on every deploy this machine
 * ever made — the line was bold-yellow with `919de24` printed on both sides of
 * it. Below git's own abbreviation nothing is compared at all: a prefix that
 * short matches too much to mean anything, so two readings that disagree in
 * length there are reported as they are.
 */
export function sameCommit(a, b) {
  const one = String(a || '').toLowerCase();
  const two = String(b || '').toLowerCase();
  if (!one || !two) return false;
  const n = Math.min(one.length, two.length);
  if (n < SHA_MIN) return one === two;
  return one.slice(0, n) === two.slice(0, n);
}
