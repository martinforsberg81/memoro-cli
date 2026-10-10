section: Changed

- **A `project_log.md` that carries the same row twice is red at the gate**:
  `project_log.md carries the same row twice: <date> <programme> <project> —
  delete the copy and push`. Rows are compared by date, programme and project,
  on the candidate after the base is merged in, so a copy `merge=union` left
  behind is the branch's to delete. In a batch it falls back to single rounds.
- **The archive never appends a row that is already there**: `appendRow`
  returns the log unchanged when the programme and project have a row.
