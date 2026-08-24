section: Changed

- **Steg 1 of making mc memoro-only: the dead session surface's flaky tests
  are gone, and the gate can measure again (Martin, 2026-08-24).** Half the
  repo was the old portable-session vision, and 27 of the ~42 tests that
  were red on every gate round lived in it — red not because anything broke
  but because the heavy old-surface tests (session-v1, cli-lifecycle) are
  load-flaky under full concurrency: two runs of the same code drew a
  DIFFERENT 42, so the gate's broke-count was a property of the run, not the
  change, and #404–#408 landed on luck (a gate that could not tell). This
  slice removes those load-flaky test files, cuts the 17 zero-call session
  verbs from the CLI (measured across 1157 transcripts), makes `mc status`
  the board only, reshapes `mc doctor` to the enforcement list alone (its
  old pre-V1 session/dev-server scan produced 27 identical unread lines),
  and gives the improve pulse its own 30-minute clock so a busy inbox
  cannot flood the helper. Result, measured: the suite is STABLE across
  runs (the red set is identical), all remaining red is pre-existing, and
  the differential gate works again. The dead SOURCE is kept for now —
  it is entangled with the live broker/credential path through
  computed-path subprocess spawns (invisible to import-tracing), so its
  removal is a later per-cluster refactor, not a mechanical delete. A
  reachability tool (`scripts/reachable.mjs`) and a two-tool start-smoke
  (`scripts/start-smoke.mjs`) were built first as the safety net while the
  gate was blind.
