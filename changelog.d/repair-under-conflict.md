A pull request held because it conflicts with `main` now gets the repair
session it is owed. The repair used to be refused whenever a merge was in
progress in the worktree — which is the state that hold always produces, so
the most common hold there is could never be repaired.
