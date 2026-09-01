section: Fixed

- **Five standing red tests were assertions that outlived their subject.**
  None of them broke; each checks a mechanism a merged change removed, and no
  one updated the test.
  `tests/mc/session-fabric.test.js` drives `mc spawn`. There is no such verb —
  the failure is literally `mc: unknown command "spawn"` — so the file goes.
  Two in `tests/runtime/broker/launch-client.test.js` assert that
  `groundSession` ran. #321 stopped mc grounding a launched session at all, and
  a third test in the same file already asserts the opposite and passes. One of
  the two even says *"without auto-submitting grounding"* in its own name while
  asserting that grounding happened; both now assert what the code does.
  This matters beyond the tidying. Since the 2026-08-31 ruling, the merge round
  refuses on any red the selection reaches, so a stale assertion inside a
  widely imported module is a standing veto over unrelated work — these five
  blocked every pull request whose diff reached `roles.js`. `.mc/red-ratchet.json`
  goes 38 → 31; the whole suite, 26 red → 21 (2479 tests, measured 2026-09-01).
