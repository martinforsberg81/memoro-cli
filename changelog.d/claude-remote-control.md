section: Added

- **Every interactive Claude session carries Remote Control.** mc starts each interactive Claude session, foreground and background, with `--remote-control <name>`, named after the session, so it is reachable in the Claude app or at claude.ai/code. Without `--bg` nothing else changes: the terminal attaches as before.
- **`--bg` leaves a Claude session running for the app.** `mc plan`, `mc manager`, `mc martin` and `mc helper` take `--bg`. On the persistent SSH entrance, or through a configured server, start and join then run no `claude attach`: they print the session's name with where to open it, and the terminal view line, and return 0. Off that path, or for a Codex launch, `--bg` is refused before anything starts. Codex and headless sessions are unchanged.
