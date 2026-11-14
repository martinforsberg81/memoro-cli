section: Added

- **Every interactive Claude session carries Remote Control.** mc starts each interactive Claude session, foreground and background, with `--remote-control <name>`, named after the session, so it is reachable in the Claude app or at claude.ai/code. On the persistent SSH entrance a flagged session no longer attaches the terminal: the entrance prints the session's name, where to open it, and the `claude attach` line for the terminal view, then returns 0. Claude sessions started before this change still attach once, as before. Codex and headless sessions are unchanged.
