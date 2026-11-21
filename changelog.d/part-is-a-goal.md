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
- **Each part says what it waits for.** A part carries one line, `Waits for:
  nothing.` or `Waits for: Part 1, Part 3.`. `mc programs state <programme>
  ready` writes the record's dependencies from those lines and refuses an
  order where a line is missing, names a part the order does not have, or
  waits in a circle. `mc programs after` is refused for such an order, and the
  phases of a programme whose goals are parts are never renumbered. An order
  that was ready before finishes the goals it has in their old form; a part of
  it that has no goal is cut once the desk has added the lines and set it
  ready again.
- **A build session on such a goal reads, decides and hands over.** It writes
  its reading of anything unclear in the log as a line beginning `Read as:`
  and builds on it; its `mc goal defect` is refused. Goals written before keep
  every rule they had.
- **A released repair order is not cut by code yet.** Its reconciliation
  compares authored goal contracts, which a goal that is a part does not have.
  The runner says `not cut: repair releases are cut by hand until
  reconciliation reads goals that are parts`.
