section: Removed

- **The coordinator role, and the packaged-canon reader that shipped it.** mc
  carried a second way of working alongside the verbs: `/be-coordinator`, an
  `agent-coordination` skill defining coordinator and implementation-session
  roles, a handoff contract, and a review checklist. It named a GitHub surface
  that no longer exists (`mc github pr list`) and a coordination ritual that
  `mc plan` and `mc run` had already replaced.
  Its delivery machinery goes with it. The three flat files under `canon/`
  shipped as a checked-in copy of their authoring homes, resolved by
  `readPackageCanon` and guarded against drift by `canon-drift.test.js`. Both
  consumers that made the copy worth keeping — `buildRole`'s package-canon
  awareness and `mc adapter materialise` — were already gone, so the reader was
  exercised only by its own tests. `canonRoot()` stays: `canon/roles/` is real,
  and `roles.js` reads it.
  Also out: `grounding.includeCoordinatorRole`, a config key with no reader.
  `canon/` now holds the verbs' roles and nothing else.

section: Fixed

- **A test that had been red on main since #272 is gone with its subject.**
  `readPackageCanon › reads all three packaged canon files from the real
  package` asserted the heading `Coordinator ↔ Agent coordination`;
  `canon/agent-coordination.md` was retitled `Coordinator ↔ implementation
  sessions` in #272 and the assertion never followed. Since the 2026-08-31
  ruling took the baseline off the merge round, a standing red that a change
  happens to reach refuses that change — this one blocked every pull request
  touching `canon/`. Its two names leave `.mc/red-ratchet.json`, 31 → 29.
