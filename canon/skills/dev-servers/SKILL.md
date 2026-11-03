---
name: dev-servers
description: Starting, finding and using a dev server for an mc repository (memoro, memoro-cli) on Martin's 8 GB machine. Use before npm run dev, opening a local URL, or starting any server or browser.
---
# Dev servers

Dev servers start only through mc: `mc shot dev` and `mc test dev` start one,
and mc admits at most four app servers on the machine (`mc dev admit`).
`npm run dev` is for a person at a terminal.

- A URL for this worktree: `mc test dev --here --url`.
- A wait for a slot is a queue, served in order (a gate round first after two
  minutes); the waiting line says your place. Who holds the servers and who
  waits: `mc dev status`.
- What runs where: `mc dev list`, `mc prs`, `mc status <name>`.
- One browser at a time.
- Stopping one: skill `mc-processes`.
- Start one only when the work asks for something seen or measured.
