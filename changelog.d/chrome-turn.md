section: Added

- **`mc hook pre-tool` turns Claude in Chrome against a local dev server to
  `mc shot next`.** A `navigate` or `tabs_create_mcp` to `127.0.0.1`,
  `localhost` or `[::1]`, or a `browser_batch` holding one, is refused
  (`chrome-dev`) with `mc shot dev <path> --keep` and `mc shot next …` as the
  answer; a real site, a published artifact and an open tab pass, and
  `#MC_HOOK_ALLOW=1` on the URL lets a call through. The matcher in
  `~/.claude/settings.json` becomes
  `Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*`, so
  `mc hook install --check` reports drift until `mc hook install` runs again.
  The session-start toolbox gains a `step a flow` line.
