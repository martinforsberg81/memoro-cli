section: Changed

- **A role's overlay now reaches codex too.** It was Claude-only: codex
  conversations in a role's area were handed the Coding Profile and nothing
  of the role, because overlay delivery for codex was marked "not yet
  designed". There was nothing left to design — `profileArgs` has carried
  markdown to codex through `-c instructions=` since the profile moved off
  disk, and that channel was verified to layer over codex's base
  instructions rather than replace them. `instructionsFor` now assembles the
  same body for both tools, so `mc plan <name> --codex` starts a session
  that can read its own role, and no `AGENTS.md` is written to say it.
