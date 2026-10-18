section: Fixed

- **A dev server whose process runs outside its registered worktree is no longer reused for it.**
  On 2026-10-08 a server registered for a workarea ran in the shared checkout and served its frontend from mid-September, so the workarea's screenshots showed code that no longer existed. `ensureDevServer` now reads the process's working directory (`lsof -d cwd`) and refuses such a server, naming it and `mc dev stop <id>`; `mc dev list` marks it. A cwd that cannot be read is trusted, and `mc dev list --json` is unchanged.
