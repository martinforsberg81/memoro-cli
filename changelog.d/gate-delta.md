section: Changed

- **`mc merge` reuses a session's green `mc gate` after main moved, and runs
  only what main's movement reaches (ruling 47).** The exact-tree reuse of
  ruling 44 hit about 11 of 513 memoro rounds, because the candidate has the
  current main merged in. `mc gate` now also records the base it measured from
  and the selection by name; a round whose exact match misses looks up the
  green for the pull request's own head tree, asks the declared selector what
  `git diff <green.base> <merged base>` (and the derived commit) reaches via
  `--changed-path`, and runs only the selected files and command gates in both
  — plus any the green never measured. Enabled per repository by the new
  declaration field `select_changed_path` (on for memoro). Any failure measures
  the whole selection as before. `reused` (`mode: exact | delta`) is now in the
  `gate-rounds.jsonl` line.
