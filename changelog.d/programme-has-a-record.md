section: Added

- **A programme can have a record: `mc programs create`, `record` and `show`.**
  `PROGRAMME.json` in a programme's directory says which horizon it serves, the
  sentence that says when it is done and whether it is open. `mc programs create
  <programme> --end "…" [--horizon <slug>]` makes a programme with its record, a
  page from a new template and the empty folders; `record` gives an existing
  directory its record; `show` prints it. A person, the interactive Martin role
  and the manager may write; every other role is refused. The list and the page
  show a recorded programme before its first goal, and a session's hand is kept
  off the file as it is off GOAL.json. A programme without a record is unchanged.
