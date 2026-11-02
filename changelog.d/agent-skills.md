section: Added

- **Task skills: mc installs `canon/skills/` for Claude Code and Codex.** A role
  reached only sessions mc launched; a session opened by hand saw only its
  repository's `AGENTS.md`. `canon/skills/<name>/SKILL.md` is now installed as
  `mc-<name>` in `~/.claude/skills/` and `~/.agents/skills/`, and a programme's
  `~/mc/programs/<programme>/SKILL.md` as `mc-programme-<programme>`. The sync
  runs at every session start (`mc hook session-start`), in `mc hook install`
  and as `mc skills sync`: it rewrites a changed install, removes a stale
  `mc-*` one and touches nothing without the prefix. A role line
  `@skill <name>` becomes a pointer to the installed skill, and `mc roles check`
  names skill drift. The first skill is `publish-and-merge`.
