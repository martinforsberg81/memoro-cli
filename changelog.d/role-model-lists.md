section: Changed

- **Only a build follows the goal's class; every other unattended role has
  its own model list.** `~/mc/runner/models.json` gains `finish`, `mend`,
  `plan` and `manager` lists beside `fast`, `large` and `review`. Defaults:
  review `claude:opus:medium`, `codex:gpt-6.1-sol:medium`; finish
  `claude:opus:high`, `codex:gpt-6.1-sol:high`; mend `claude:sonnet:medium`,
  `codex:gpt-6.1-sol:medium`; plan `claude:opus:high`,
  `codex:gpt-6.1-sol:high`; manager `claude:opus:medium`,
  `codex:gpt-6.1-sol:medium`. A file without the new lists reads their
  defaults. `mc model add|remove` take every list and `mc model set` takes
  every role list. Before this, a fast goal's finish and mend ran on haiku.
