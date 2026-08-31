section: Changed

- **The documentation says where a planning session lives, and that the runner
  cannot reach it.** Six documents still described `mc plan` as the verb that
  makes a project's workarea, which is the coupling that was removed.
  [`docs/technical/mc-plan.md`](../docs/technical/mc-plan.md) is rewritten
  around the programme: what a programme is against a project, the directory
  layout, why `~/mc/plan/` is invisible to `mc run` and `mc status` by
  construction rather than by a naming rule, and the three readings behind the
  programme picker. `docs/project/README.md` § *Who writes what* says the
  planning session works on a programme, has no workarea and makes none, and
  that the `<project>` name it chooses is what the runner will later call that
  project's branch and workarea. `docs/coding-agent-protocol.md` (and its
  byte-identical `canon/` copy) corrects "a workarea is created by `mc plan` or
  `mc work add`" and names both places a decision file can now live.
  `mc-status.md`'s fact table, `mc-run.md`'s "there is no triage" paragraph and
  `mc-helper.md`'s route from a proposal to a plan follow.
