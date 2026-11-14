section: Added

- **GOAL.json version 2: numbered parts beside the unchanged version 1.**
  `mc goal new --structure 2` makes a goal whose brief is an aim, an outcome,
  a problem, premises, decisions, changes, latitude, things to preserve,
  obligations, risks, protection and what is out of scope, each item with an id
  (`B1`, `D2`, `C1`) that is never given twice. `mc goal item add|set|remove`,
  `mc goal obligation set|remove` and `--evidence` on `criterion add|set` write
  the parts; `mc goal show`, the brief a session is handed, the desk and jev's
  context show a version 2 goal whole. Nothing that exists changes version, and
  an older mc reads a version 2 file as invalid, so update mc before making one.
