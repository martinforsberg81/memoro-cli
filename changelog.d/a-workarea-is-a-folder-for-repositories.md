section: Changed

- **The workarea handoff is gone.** `handoff/` — *"where a conversation leaves
  its baton for the next one"* — had three sites and no writer: mc never
  created one, and the only thing that mentioned it was a *read* instruction in
  `mc plan`'s first prompt, which `mc plan` stopped carrying when it became a
  programme's session. Nothing under `~/mc` that holds a checkout has one. It
  leaves `FILING_DIRECTORIES`, which now names the inbox alone — and the list
  itself goes with the inbox, not before it: a filter removed while the thing
  it filters is still being written is a directory surfacing on the page as a
  repository that is not a repository, which is the failure it exists to
  prevent.
- **Documentation that described the decision machinery as current is gone.**
  `mc status`'s *"Which decisions belong to a project"* explained
  `decisionsForProject`, a function `grep` does not find; `mc-plan.md` claimed
  a test asserts a decision file under `plan/<programme>/` reaches the brief,
  and that test went with the concept; `mc-brief.md` said the brief session's
  writes are `~/mc/<area>/decisions/*.md`, when it writes one file and that is
  `~/mc/brief/<date>.md`. `mc worker`'s help line still told a session to
  escalate by writing `../decisions/`, which is now nowhere to write to.
  What is kept is the history written as history — `mc-brief.md` explaining
  what the concept was and why it went — because that is the part a reader
  needs and the part a grep for the word would otherwise resurrect.
- `mc-dormant.md` cited ruling `mc-1` by a path into a workarea. Cited by name
  now, as `docs/project/README.md` requires: no checkout contains that path,
  and nothing keeps the directory it pointed into.
