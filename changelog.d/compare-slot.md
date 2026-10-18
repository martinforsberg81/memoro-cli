section: Fixed

- **`mc shot dev --compare` stops its own superseded compare server instead of waiting for it.** A compare tree is per commit, so after main moved the previous compare server held one of the two slots and the ref side waited up to 15 minutes. Now a compare server of an older commit of the same worktree name, unused for 15 minutes, is stopped through its own stop command; the ref side waits at most 60 s; and a refusal names the running compare servers, any of which `--compare <sha>` reuses with its tree and its database.
