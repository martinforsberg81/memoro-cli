section: Removed

- **The repair path is gone** (ruling 21). No `repair` session, no
  `canon/roles/repair.md`, no `~/mc/runner/held.json`, no merge lane in the
  runner, no `held-after-repair` block and no `repair` default in
  `SESSION_DEFAULTS`. A step session lands its own pull request and fixes its
  own red; a step that did not land is `failed` in the register, drawn where
  every other plan state is, and listed by the brief under *Failed steps* with
  its pull request and the session's last word. `merges.json` holds only the
  `mc merge` calls waiting for their turn at the gate. `landProject`,
  `replayOnto`, `stackOrder` and `landingNote` went with the runner's own
  landing, which nothing calls any more.
