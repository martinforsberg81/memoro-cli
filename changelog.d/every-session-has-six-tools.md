section: Changed

- **Every session mc launches has the same six tools.** Foreground and tmux
  sessions took Claude's default set and every user-level MCP server, while
  headless ones had `Bash,Read,Edit,Write,Grep,Glob` and no MCP. They now share
  that allowlist, resumed sessions too: 7 659 tokens on the first request
  against 21 491 with the default set (claude 2.1.316).
