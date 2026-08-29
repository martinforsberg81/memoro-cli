section: Added

- **A plan that reaches `done` is archived by `mc run`, in the round it
  reads it.** The runner answered a done plan with a skip line and nothing
  else, so `docs/project/` kept every project it had ever finished — ten
  such directories on 2026-08-29, and `docs/plans/`, the directory it
  replaced, had reached 656 files the same way. Now the round begins by
  taking away what is finished: for each repository, one PR that removes
  `docs/project/<programme>/<project>/` for every plan whose status is
  `done` and leaves a row in that repository's `docs/project/project_log.md`
  behind it — the row a close-out step already wrote is kept as it is, and
  one written from the plan otherwise (`next:` as the summary, the
  `docs/technical/` path it names as the doc, the PRs the runner merged for
  it as the pointer). A project archived with no note is recorded in
  `~/mc/intake/undocumented-closures.md` and archived all the same. Nothing
  new to type: `done` is the whole trigger. The history is the record —
  `git log --all -- <path>` still answers every question the removed
  directory could.
