section: Added

- **`mc goal criterion set` rewrites a criterion by its number.** `--criterion` and/or `--check` replace its text, the criterion is unmet again, and the LOG.md entry names the old and new text; the stage and status stay. A build or review session cannot rewrite acceptance, so a ready decision no longer leaves GOAL.json holding the old criterion.
- **`criterion add` and `criterion set` warn about a test file their check names that is not on origin/main.** One warning per path, on stderr, naming the goal's repositories; the write and the exit status are unchanged, and a git failure says nothing.
