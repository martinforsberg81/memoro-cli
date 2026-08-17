/**
 * What failed in a suite run, named — every level of it.
 *
 * The gate compares two suite runs and asks whether the candidate went red
 * anywhere the baseline was green. That comparison is only as good as the
 * names it is made of, and two ways of getting the names wrong have already
 * been seen in practice:
 *
 * Counting instead of naming. A round where one failure was fixed and another
 * introduced has the same total on both sides, and a gate that compares totals
 * calls it unchanged. So the red set is a set of names, and the verdict is
 * about set membership.
 *
 * Reading only the top level. A file's suites and their tests each get a TAP
 * line, and a failing test makes its suite and its file fail too — so a run
 * with 31 failing top-level entries can carry 55 failing entries in total. A
 * change that swaps which test inside a suite fails leaves the top level
 * identical. So every level is read, and a name is the path to it: the suites
 * it sits under, then its own name.
 *
 * TAP nesting is indentation — four spaces per level — and each entry is
 * announced by a `# Subtest:` line before its result line, at the same indent.
 * That is the whole grammar this needs, which is why it is parsed here rather
 * than by pulling in a TAP library: the format that matters is the one node's
 * own reporter emits, and it is this small.
 */

const SUBTEST = /^(\s*)# Subtest: (.*)$/u;
const RESULT = /^(\s*)not ok \d+ - (.*)$/u;

/**
 * A directive on a result line — `# SKIP`, `# TODO` — and what it means here.
 *
 * A todo test that fails is a test that announced it was going to. It is not a
 * regression and it must not be able to stop a merge, so it is not red. A
 * skipped one never ran at all. Both are recognised on the result line rather
 * than inferred from a count, because a run's totals report them separately
 * and the gate never sees the totals.
 */
const DIRECTIVE = /\s+#\s+(SKIP|TODO)\b/iu;

/** How deep a TAP line sits: four spaces to the level. */
const INDENT = 4;

/**
 * The failing entries of one suite run, as full names.
 *
 * Order is the order they failed in, which is the order a person reads them.
 * Duplicates are kept out — a name is a name — but nothing else is filtered:
 * deciding which failures are worth caring about is the caller's business, and
 * a list that quietly dropped some would be the place real breakage hid.
 */
export function redNames(tap) {
  const names = [];
  const seen = new Set();
  // The suite path, indexed by level: `path[0]` is the outermost entry the
  // failing one sits under, and the failing entry's own name goes on the end.
  const path = [];

  for (const line of String(tap ?? '').split('\n')) {
    const announced = SUBTEST.exec(line);
    if (announced) {
      const level = Math.floor(announced[1].length / INDENT);
      path.length = level;
      path[level] = announced[2].trim();
      continue;
    }

    const failed = RESULT.exec(line);
    if (!failed) continue;
    if (DIRECTIVE.test(failed[2])) continue;

    const level = Math.floor(failed[1].length / INDENT);
    // The result line repeats the name its `# Subtest:` announced, and that
    // announcement is what put the parents in place. Trust the line's own name
    // over the path entry: a run that was cut off mid-file can leave a stale
    // one behind, and a wrong parent is better than a wrong name.
    const name = [...path.slice(0, level), failed[2].trim()].join(' › ');
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * The run's own totals, when it printed them.
 *
 * Reported alongside the names but never used to decide anything: they are how
 * a person checks the parse looks sane, and how a run that died before it
 * finished — no plan, no totals — is told apart from one that passed.
 */
export function tapTotals(tap) {
  const totals = {};
  for (const line of String(tap ?? '').split('\n')) {
    const counted = /^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/u.exec(line);
    if (counted) totals[counted[1]] = Number(counted[2]);
  }
  return {
    tests: totals.tests ?? null,
    pass: totals.pass ?? null,
    fail: totals.fail ?? null,
    cancelled: totals.cancelled ?? null,
    /** A run that never printed its totals did not finish, whatever its exit code said. */
    finished: totals.tests !== undefined,
  };
}

/**
 * What the candidate broke — names red on one side and not the other.
 *
 * The gate's whole verdict is this function's first return value being empty.
 * `fixed` is the other direction and decides nothing: a round that repaired
 * something is welcome to, and a gate that insisted the sets match exactly
 * would refuse every PR that fixed a test.
 */
export function compareRed(baseline, candidate) {
  const before = new Set(baseline);
  const after = new Set(candidate);
  return {
    broke: candidate.filter((name) => !before.has(name)),
    fixed: baseline.filter((name) => !after.has(name)),
  };
}
