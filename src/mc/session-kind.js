/**
 * The kinds of headless session the runner runs: `build` and `review`
 * (Martin, 2026-11-02), and `finish` and `mend` (Martin, 2026-11-07). A build
 * has two variants, `project` (one step of a project) and `goal`; a review is
 * of a project (its review step) or of a goal. A finish and a mend are always
 * a goal's and have no variant. `plan` is read for the rows and lane files the
 * runner wrote before 2026-11-07, the interactive plan session, and the
 * runner's focused next-draft planning assignment (2026-11-09).
 *
 * Everything a person reads names a session this way: the page, `mc --json`,
 * the runner's lane files and `runs.tsv`. `runs.tsv` has one `kind` column
 * and a header written once when the file was made, so the variant rides in
 * the cell — `build-project`, `build-goal`, `review-project`, `review-goal`,
 * `finish`, `mend`, `plan` — rather than in a column an old file's header
 * would not have.
 *
 * Rows and lane files from before carry the old words, and are still read:
 * `step` was a project's build, `goal` a goal's session (a build, or until
 * then its review too), and `review` a project's review step.
 */
export const SESSION_KINDS = Object.freeze(['plan', 'build', 'review', 'finish', 'mend']);
export const BUILD_VARIANTS = Object.freeze(['project', 'goal']);
/** The kinds without a variant: one way to start each. */
const PLAIN_KINDS = Object.freeze(['plan', 'finish', 'mend']);

const OLD = Object.freeze({
  step: { kind: 'build', variant: 'project' },
  goal: { kind: 'build', variant: 'goal' },
  review: { kind: 'review', variant: 'project' },
});

/**
 * `{ kind, variant }` for what a lane file or a runs.tsv row says: the new
 * pair, the `runs.tsv` cell, or an old word. Null for anything that is not a
 * session of these kinds (`helper`, `intake`, a chore).
 */
export function sessionKind(kind, variant = null) {
  const word = String(kind ?? '');
  if (PLAIN_KINDS.includes(word)) return { kind: word, variant: null };
  if ((word === 'build' || word === 'review') && BUILD_VARIANTS.includes(variant)) return { kind: word, variant };
  const cell = /^(build|review)-(project|goal)$/u.exec(word);
  if (cell) return { kind: cell[1], variant: cell[2] };
  if (word === 'build' || word === 'review') return { kind: word, variant: null };
  return OLD[word] ?? null;
}

/** The `runs.tsv` cell for a session: `build-project`, `review-goal`, `finish`, `mend`. */
export function runsKind({ kind, variant = null }) {
  return variant ? `${kind}-${variant}` : kind;
}
