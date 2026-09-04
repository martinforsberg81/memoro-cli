section: Changed

- **The runner's three tables moved out of `~/mc/intake/` and into
  `~/mc/runner/`.** `undocumented-closures.md`, `unplanned-workareas.md` and
  `unreadable-plans.md` are what `mc run` writes about its own rounds, and
  `mc brief --collect` is their only reader — but they were sitting in the
  inbox, which is about to be drained one file per turn. Two of the three are
  rewritten whole every round, so a turn that read one and archived it would
  find it back the next round, and the round after, forever. They now sit
  beside `held.json`, `runner.json` and `log/`, and the path is spelled once in
  `src/mc/paths.js` — `runnerTablePath` for the runner that writes it,
  `runnerTableLabel` for the brief that names it to a person, so the two cannot
  drift. The three files on disk were moved by hand; a migration path for three
  files that are rewritten every round is more code than it saves.
