section: Removed

- **`MEMORO.md`, the repo's intent-map.** Its own opening said what it was for:
  *"The orchestrator grounds in this file at session start and keeps it current
  as work lands."* There is no orchestrator any more, `buildRole` is gone, and
  nothing in `src/` ever opened the file — the map was being kept by hand for a
  reader that had stopped existing. What it held that is still true lives in
  `docs/plans/`, which it always said was where detail belonged, and what work
  is actually in flight is a `PLAN.md` the runner reads.
  It had also drifted into saying things that were no longer so, describing
  `mc adapter materialise` and `buildRole`'s package-canon awareness as shipped
  features months after both were deleted.
  The only live mention left is a pair of strings in `wrap-start.test.js`
  asserting that mc does *not* synthesize the legacy startup prompt. Those stay:
  they are about a behaviour that was removed, not about the file. The
  historical plans under `docs/plans/` keep their references, which is what a
  document headed *Historical* is for.
