section: Changed

- **PROGRAMMES draws only the programmes with work on them; `mc programs list`
  names them all.** On 2026-11-02 the section drew 41 programme headings and
  27 said `no project yet`. A programme is now *active* with at least one
  project or goal, of any status, and *dormant* otherwise. The heading reads
  `14 active · 27 dormant · 26 projects` and the status rollup; the dormant
  programmes are one grey line directly under it —
  `27 dormant · 5 with a plan session · mc programs list` — and `a` at the
  menu draws every programme as before. A programme whose only work is goals
  says `1 goal` rather than `no project yet · 1 goal`. `mc --json` keeps every
  programme, each with `dormant`, and the section gains `active` and
  `dormant`. The new `mc programs list [--json]` is every programme, one line
  each by name, read through the page's own collector (`readProgrammes`).
