section: Changed

- **One home per rule: roles say the role, ten task skills say the task.**
  `canon/roles/_common.md` and the role files held gate, publish and merge,
  conflict, git, proposal, process, scratch, `mc shot`, dev-server and
  asking-Martin rules side by side with `AGENTS.md`, `CLAUDE.md` and the
  381-line `docs/coding-agent-protocol.md`. Each rule is now one
  `canon/skills/<task>/SKILL.md`, installed as `mc-<task>`, and each role
  names its skills with `@skill`. `AGENTS.md` and `CLAUDE.md` are a few lines
  pointing at the skills; the protocol is gone, its facts about the code in
  `docs/technical/mc-codebase.md`.
