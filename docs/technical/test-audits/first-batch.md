# First bounded test-value audit: mc

2026-11-04. Examined revision: `26490524d90800a8e26d24d48cc8fcedc46dc1fc`.
Only the three files below are decision subjects. Nearby tests are evidence of
overlap, not additional audit subjects. This applies the approved
[test strategy](../../../canon/skills/writing-tests/references/test-strategy.md).
Recommendations commission **no implementation or deletion**; protection stays
unchanged pending a separately planned follow-up. No residual risk is accepted.

## Runtime evidence and limits

Run from this repository:

```sh
mc gate tests/mc/canon-text.test.js tests/mc/roles-decisions.test.js tests/mc/branch-landed.test.js
```

Observed: **GREEN, 54 tests, 0 failed, 24s** (gate's rounded elapsed time).
The complete gate log is
`gate-20261104T125803Z-04465d35-0ed0-47cb-9271-98b46bbd27f4.log` under
`$MC_SCRATCH` for session `goal-mc-tests-audit-first-test-batch-20261104T125641Z`.
The TAP footer reports `duration_ms: 18475.542459` for the selected Node round,
including file loading and fixtures, not just callback time. These are one
machine observation, not a benchmark or promised future duration.

| File | Actual TAP evidence | Setup/startup evidence |
| --- | --- | --- |
| `canon-text.test.js` | Suite durations 256.233 ms (one home) and 23.770 ms (role skills). | Repeated synchronous canon reads and skill enumeration; isolated file startup/read cost **unmeasured**: no separate instrumentation was run. Included in the selected-round total. |
| `roles-decisions.test.js` | Suite durations 19.633 ms (decision shape) and 70.758 ms (shared rules). | Reads shipped skills and expands real role instructions; isolated file startup **unmeasured**, needing a separate file-level measurement. |
| `branch-landed.test.js` | `real work is ahead, a conflict is unknown, and no base is unknown too`: 1273.656 ms; `asks the system who stands in a directory: nobody in a fresh one, this process in its own`: 1668.174 ms. Gate log reports 193 instrumented Git calls in this file. | Five Git history templates are constructed at module load, then copied per fixture. Separate template/copy/OS-probe startup attribution **unmeasured**, needing phase instrumentation. Round total above includes it; callback times do not. |

No fault was injected, no tests were changed, and no full suite was requested.
The follow-up fault checks below are proposed acceptance evidence, **not runs
claimed by this audit**. Passing a text test does not prove an agent obeys it.

## 1. `canon-text.test.js` — rebuild, retaining structural delivery checks

**Protection and consequence.** [The test](../../../tests/mc/canon-text.test.js)
checks single ownership of task instructions, known skill names, required
role-to-skill links and pointer-only expansion. Missing guidance or conflicting
copies can steer unattended sessions into unsafe Git, process or publication
actions. The real delivery chain is
[readCanonRole / instructionsFor](../../../src/mc/roles.js#L103) and
[expandRoleSkills](../../../src/mc/skills.js#L246), which turns `@skill` into an
installed-path pointer, not the skill body. Direct function calls and narrow
canon inspection are credible for this **instruction artifact contract**, not
for actual agent decisions or hard permission enforcement.

**Evidence of brittleness/overlap.** `DEFINING` requires one exact sentence per
skill and an exact skill-name set. A harmless paraphrase fails; unrelated
dangerous advice can coexist with the expected sentence. The `RULES` carrier
assertion permits `[]` when no carrier exists, so that assertion alone cannot
prove the rule still exists. Sentence splitting, permission-language regexes
and a 60-line cap are textual heuristics, not semantic authority checks.
These observations are from the assertions, not demonstrated faulty runs.
[roles.test.js](../../../tests/mc/roles.test.js#L183) already proves shared
instruction delivery and [skills.test.js](../../../tests/mc/skills.test.js#L122)
proves per-tool pointer expansion and unknown-name handling. The proposals and
publisher role links overlap with decision 2 below.

**Fixture and cost.** No home/database/service fixture: shipped canon files
plus real parsing/expansion. `canonSkills()` also reads skill reference files
through [filesUnder](../../../src/mc/skills.js#L98), so repeated enumeration is
not merely an in-memory lookup. Measured suite and unmeasured startup costs are
in the evidence table; no performance defect is inferred from synchronous I/O.

**Unique protection at risk.** Exact defining-sentence presence and exclusive
placement, role/skill cross-coverage, duplicate prose detection, permission
word patterns and page length would not all survive a move to delivery tests.
Some are explicit authoring constraints. Do not retire them just because they
are not behavioural tests; agree which constraints remain commissioned first.

**Bounded follow-up.** Plan a rebuild confined to existing canon/role/skill
tests: retain known/required skill wiring and one-home constraints; consolidate
duplicate delivery assertions; replace wording pins only after agreeing the
artifact invariant they stand for. Do not introduce agent-output evaluations.
Acceptance command:

```sh
mc gate tests/mc/canon-text.test.js tests/mc/roles-decisions.test.js tests/mc/roles.test.js tests/mc/skills.test.js
```

In that later change, remove one required `@skill` and separately duplicate a
retained rule: the relevant assertions must fail, then pass after restoration.
An agreed harmless paraphrase should pass without weakening required wiring.
Record any deliberately retired authoring constraint and its planning decision.

## 2. `roles-decisions.test.js` — consolidate, preserving unique guidance

**Protection and level.** [The test](../../../tests/mc/roles-decisions.test.js)
checks that the build role points to asking-martin, other listed roles reach
proposals/publication guidance, and the shipped skills discourage menus and
premature questions and explain proposal routing. The consequential failure is
an unattended finding disappearing into the wrong inbox or a question reaching
Martin without a grounded recommendation. It uses real
[instruction assembly](../../../src/mc/roles.js#L337), but most assertions read
skill text directly; it cannot prove the skill was loaded or followed.
Artifact-level checks are credible for pointer presence; editorial review is
needed for meaning. This is not an AI-quality evaluation.

**Overlap and brittleness.** Its proposals/publisher pointer assertions repeat
[canon-text's required-role links](../../../tests/mc/canon-text.test.js#L129).
Its no-copy `LOOSE_THREAD` check overlaps canon-text's defining proposal sentence
and general duplicate-sentence check. The proposal path assertion pins wrapping,
punctuation and explanation fragments. `unclear|not ready` plus `read` can pass
in unrelated prose; no assertion proves readiness judgement. The authors list
contains only `build-session:goal`, so the heading is not coverage of all roles.

**Fixture/cost.** Real shipped Markdown read synchronously; `toldTo` uses the
actual parser and expander. No launches, network or isolated home are needed.
Measured suites and the startup gap are recorded above; consolidation is
recommended for overlapping maintenance, not claimed runtime savings.

**Unique protection at risk.** Build-to-asking-martin wiring, rejection of the
former option-menu instructions, readiness guidance, proposal directory and
why intake is inappropriate are not all established by the overlapping tests.
Preserve those agreed obligations during consolidation; wholesale retirement
would lose them. No other examined test proves agent adherence.

**Bounded follow-up and executable check.** Consolidate common role-pointer
and no-copy assertions into the existing canon/skill tests, with an explicit
old-to-retained obligation mapping. Keep unique asking/proposal obligations
until planning decides how their meaning should be reviewed. Run the same
four-file `mc gate` command in decision 1. In the future change, removing the
build's asking-martin pointer must fail the retained assertion; removing its
proposal pointer must also fail. Compare the actual installed guidance with
the preserved obligations by review, not a new permanent report-wording test.

## 3. `branch-landed.test.js` — rebuild cost hotspots; keep real Git evidence

**Protection and consequence.** [The test](../../../tests/mc/branch-landed.test.js)
exercises [branchLanded](../../../src/mc/branch-landed.js#L35) against real squash,
ahead, conflict and absent-base histories. It checks actual worktree/branch
removal and retention through
[removeWorktree](../../../src/mc/work-area.js#L284) and
[releaseVerdict / releaseWorkArea](../../../src/mc/work-area.js#L457).
Wrong answers either strand landed work or, more seriously, delete unlanded
work. [Remote landing checks](../../../src/mc/branch-landed.js#L94) cover
restacked patches, later mends, pruned branches, missing objects, pull-ref fetch
and local work left over. `mergedPullAtTip` also refuses older matching heads,
bad answers and missing tips. Those are consequential unattended decisions.

**Credible level and fixture.** Real temporary repositories and local bare
origins are necessary to expose Git tree, patch-equivalence and fetch behaviour;
a model returning canned answers cannot replace that evidence. Five templates
(squash, restack and three mend variants) are built once at load, copied to
isolated directories, and the copied origin URL is rewritten. Cleanup removes
copies and templates. GitHub answers are substituted at the remote boundary;
there is no live GitHub validation. The worktree consumer checks inject
`inUse: nobody`; one separate check invokes the real OS process probe.

**Overlap/brittleness.** [work-release-verdict.test.js](../../../tests/mc/work-release-verdict.test.js)
already tests pure keep/remove decisions for in-use, dirty, ahead, landed and
unknown states. It does not prove Git classification or physical removal.
The OS probe assumes the current directory identifies a `node` process and
depends on process visibility. Commit-count and explanatory wording assertions
are secondary to preserving real work. Both the grouped Git decision case and
the OS case exceeded one second in this run; this is measured, not a reason to
discard their protection. Hoisting more work out of callbacks is not a fix.

**Unique protection at risk.** A rewrite to pure stubs would lose squash/tree
semantics, real conflict handling, patch-equivalent restacks, pruned-head
recovery and deletion/retention effects. Removing the OS case loses actual
process-discovery integration; `nobody` cannot replace it. Keep all of these
until an equivalent replacement or explicit residual-risk decision exists.

**Bounded follow-up.** Plan a cost rebuild of this file's grouped history and
OS-probe setup, using the existing pure verdict tests for policy overlap while
retaining minimal real-Git cases. Do not split callbacks or prebuild extra
fixtures to hide cost. If the OS contract cannot meet the existing budget,
return the evidence for planning rather than substituting a mock or raising a
timeout. Acceptance command:

```sh
mc gate tests/mc/branch-landed.test.js tests/mc/work-release-verdict.test.js
```

Later fault proof: substituting SHA-ahead count for tree comparison must fail
the squash case; treating unknown as landed must fail the conflict/keep case;
accepting local extra work as landed must fail a remote-extra-commit case.
Restore each fault, rerun, and record per-test, file startup/template and whole
selected-round timings. This audit has not performed those mutations.

## Delivery boundary

This report and its [changelog fragment](../../../changelog.d/audit-first-test-batch.md)
are the only intended changes in this repository. No protection is retired.
The companion Memoro report covers the other three commissioned files; neither
report certifies the estate. Publication gates are recorded in the PR and goal
log separately from the audit's focused runtime evidence above.
