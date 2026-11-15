section: Added

- **A programme can run its phases side by side.** A programme made with
  `mc programs create` has `"phases": {"order": "stated"}` in its record: a
  phase with no stated dependency is open at once, and a phase that waits for
  others opens when every goal of each phase it names is done or dropped.
  `mc programs after <programme> <phase> <phase>…` states what a phase waits
  for (`--none` removes it), refusing a cycle. The runner, `mc goal list`, the
  page, tidy and the desk's opening ask one rule for whether a phase is open;
  renumbering moves the stated dependencies with their phases; and the next
  draft is planned per phase, one plan session at a time. A record that does
  not validate holds every phase of its programme and is said once. A
  programme without a record, or whose record has no `phases`, is sequential as
  before.
