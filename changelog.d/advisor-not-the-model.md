section: Changed

- **An advisor that is the session's own model is no advisor.** A plan or
  step on `opus` ran `opus` advised by `opus`; `sessionSettings` now returns
  no advisor when the two resolve to the same name (Martin, 2026-09-12: "Om
  step har opus => advisor = null, inte opus+opus."). Ruling 18's addendum.
- **A step is the build, never the investigation** (ruling 19). The role
  text and `docs/project/README.md` say that measurement, exploration, test
  runs and "find out whether" are the planning session's, done before the
  plan is written, and that a step whose content depends on an earlier step's
  finding is not written. `_common.md` stops asking for a `Grep` tool this
  claude build does not have, asks for one Bash command per batch of
  searches, and sends repository-wide reading to an `Explore` agent.
