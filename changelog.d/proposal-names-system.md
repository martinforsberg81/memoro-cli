section: Changed

- **A proposal's filename names its system.** Nothing outside a proposal's
  text said which system it was about, so 104 files on 2026-10-18 carried a
  prose `System:` line in about fifty spellings — 4 carried none — and sorting
  them took an agent. A new proposal is now
  `~/mc/proposals/<date>-<mc|memoro>-<slug>.md`: `mc` is memoro-cli, `memoro`
  is the deployed service. mc reads only the name, never the file. An intake
  turn that writes a proposal whose name carries no system is told so on its
  line — `proposal <file> names no system (mc|memoro)` — and the file is left
  as it is. The page's BRIEF line splits the count by system, for example
  `2 proposals · mc 1 · untagged 1`. Existing proposals are not renamed.
