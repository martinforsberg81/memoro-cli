section: Changed

- **A session has one way to ask: `mc ask`.** jev is asked first; when it does
  not settle the question, a fresh read-only reader session (role `ask-reader`,
  the `decision` model list, up to 10 minutes) reads it inside the same call and
  answers with one of four: continue with an option, a goal defect (recorded as
  `mc goal defect` records it), a text of Martin's that would change (a desk
  item, while the asker continues inside the wording that stands), or unread
  (the session's recommendation, recorded as unread). Only a reserved act and a
  defect make a goal wait on Martin. `--kind` is accepted and ignored, with one
  stderr line. `mc goal martin` is gone: it exits 2 and prints the `mc ask` call
  to make. Every answer is a ledger row that says who answered
  (`answered_by`: `jev`, `reader`, `session` or `martin`), the desk opens an item
  for one that differs from the recommendation or was not read, and a reader's
  run counts under the desk's daily ceiling. Old rows are read as before.
