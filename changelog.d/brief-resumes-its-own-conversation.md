section: Fixed

- **`mc brief` stands in `~/mc/brief/`, and resumes the brief.** It stood in
  the work root and resumed "the most recent conversation here" — and here
  counts every directory below, so a planning session in `~/mc/plan/staff/`
  that had been used since was the one `mc brief` opened. The brief now has
  its own room, as `mc helper` has `~/mc/helper/`; the first `mc brief`
  after this starts a fresh session there.
