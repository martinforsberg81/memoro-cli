section: Changed

- **The documentation follows.** Six documents described `mc plan` as the verb
  that makes a project's workarea, which is the coupling that was removed.
  [`docs/technical/mc-plan.md`](../docs/technical/mc-plan.md) is rewritten
  around what the verb now is — a session in a directory, told which programme
  it is for — and carries the prompt in full, why `~/mc/plan/` is invisible to
  `mc run` and `mc status` by construction rather than by a naming rule, and
  the three readings behind the programme picker. `docs/project/README.md` says
  a planning session opens on a programme and has no workarea, and that what
  comes out of it is worked out in the session rather than decided by the
  command that opens it. `docs/coding-agent-protocol.md` (and its
  byte-identical `canon/` copy) corrects "a workarea is created by `mc plan` or
  `mc work add`" and names both places a decision file can live.
  `mc-status.md`'s fact table, `mc-run.md`'s "there is no triage" paragraph and
  `mc-helper.md`'s route from a proposal to a plan follow. "A plan PR lands
  this way" is gone from `mc merge --docs`'s help and matrix row: whether a
  plan reaches `main` through a pull request at all is not mc's to decide.
