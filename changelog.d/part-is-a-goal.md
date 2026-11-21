section: Changed

- **A part of an order is a goal, and no session plans.** When a programme is
  ready the runner itself makes one goal for each part of its README.md that
  has none, with no session and no model: the goal is in `build · ready` at
  once, its title is the part's heading, its repositories the order's
  `Repositories:` line and its phase the part's number. The goal file carries
  one new key, `part`, and no text of its own: every session on it is given
  the part as README.md has it at that moment, followed by the order's
  sections outside its parts, and `mc goal show` prints the same under `PART
  <n> — <name>, as README.md has it now`. Such a goal needs no outcome, change
  item, criterion or stand to start, to be handed to review or to land; its
  move to review asks for a clean worktree and a published head. A goal whose
  part has left the order starts no session, and `mc goal list` says so. The
  headless plan session, its prompt and its read checkouts are removed. Before,
  a plan session rewrote every part into a goal of about a thousand words, and
  the rewriting added contradictions that stopped builds.
- **A part waits for the part before it.** A part that holds the line `In
  parallel with the previous part.` starts beside that part instead. `mc
  programs state <programme> ready` writes the record's dependencies from
  that, and the phases of a programme whose goals are parts are never
  renumbered. An order that was ready before finishes the goals it has in
  their old form; a part of it that has no goal is cut once the desk has set
  it ready again.
- **A build session on such a goal reads, decides and hands over.** It writes
  its reading of anything unclear in the log as a line beginning `Read as:`
  and builds on it; its `mc goal defect` is refused. Goals written before keep
  every rule they had.
- **The review of such a goal asks one question.** Does the build do what the
  part says? `REVIEW.md` is the head line and one line, `part: OK` or `part:
  NOT OK — <what the part says that the build does not do, and where>`. No
  criterion, obligation, `untouched`, `seen` or `write-back` line is asked of
  it. The repair loop is unchanged.
- **Documentation is the programme's last goal.** The cut adds one more goal
  after the parts, `<programme>-documentation`, titled Documentation. It waits
  for every part, and its sessions are given a fixed task and the order whole:
  read the order, every goal's log and what landed, and write
  `docs/technical/` so that it describes what now runs. It is built, reviewed
  and landed as any goal, and the programme is archived when it has landed. A
  build session on a part writes no `docs/technical/` page. A programme whose
  goals were all written before keeps its `write-back` lines and gets no such
  goal.
- **The `plan` model list is gone with the session it routed.** `mc model`
  lists, adds to and sets build, review, finish, mend, manager and decision. A
  `models.json` that still holds a `plan` list reads as before; the list is
  ignored and is not written back the next time `mc model` changes the file.
- **A released repair order is not cut by code yet.** Its reconciliation
  compares authored goal contracts, which a goal that is a part does not have.
  The runner says `not cut: repair releases are cut by hand until
  reconciliation reads goals that are parts`.
