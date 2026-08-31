/**
 * What failed in a suite run, named — every level of it.
 *
 * The gate runs one suite and reports what went red in it. The verdict is only
 * as good as the names it is made of, and two ways of getting the names wrong
 * have already been seen in practice:
 *
 * Counting instead of naming. "3 red" is not something anybody can act on, and
 * a count is what a round reported for a week while the names it had were
 * thrown away. So the red set is a set of names, and the verdict names them.
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
 * The run's own totals, when it printed them — every process of it.
 *
 * A suite is not always one process. memoro's runner spawns one `node --test`
 * per resource class (standard, sqlite, heavy), so a single `npm test` emits
 * three summaries, and this function used to keep the last one it saw: on
 * 2026-08-30 a round printed `# tests 2477`, `# tests 9` and `# tests 39`, and
 * reported "39 tests, 0 red names" as the whole suite. Both sides of the gate
 * were wrong the same way, so the red comparison still held — but every number
 * a person read off that round, and every total written into the baseline cache
 * for the next one, was the last batch's alone.
 *
 * So the summaries are summed, and `runs` says how many there were. A
 * single-process suite prints one summary and is unaffected: the sum of one
 * number is that number.
 *
 * This cannot see a summary that was never printed. A runner that stops after a
 * red batch emits two summaries instead of three, and nothing here can tell
 * that from a suite that only ever had two. Reporting honestly what was printed
 * is this function's half of the problem; not truncating is the runner's.
 */
export function tapTotals(tap) {
  const totals = {};
  let runs = 0;
  for (const line of String(tap ?? '').split('\n')) {
    const counted = /^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/u.exec(line);
    if (!counted) continue;
    const [, key, value] = counted;
    if (key === 'tests') runs += 1;
    totals[key] = (totals[key] ?? 0) + Number(value);
  }
  return {
    tests: totals.tests ?? null,
    pass: totals.pass ?? null,
    fail: totals.fail ?? null,
    cancelled: totals.cancelled ?? null,
    /** How many summaries the output carried — one per process the suite ran in. */
    runs,
    /** A run that never printed its totals did not finish, whatever its exit code said. */
    finished: runs > 0,
  };
}
