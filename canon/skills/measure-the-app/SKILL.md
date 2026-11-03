---
name: measure-the-app
description: Seeing and measuring a running mc app (memoro's web app, mc's page) with mc shot — screenshots, layout, computed styles, a flow clicked through. Use before taking a screenshot, measuring an element, or writing a browser script.
---
# Seeing and measuring the app

`mc shot dev <target|/app/path>` serves the worktree you stand in, restarts its
server when the commit moved or a file changed, and prints the branch and
commit it served. It signs in through `/dev/login` (`seeded`; `--account new`,
`--onboarding`). `mc shot dev --list` names targets and viewports.

Two questions, two commands. **How is it now** — what main looks like — is
`mc shot dev --main <target>`: the shared checkout's server, always up and
followed to main while idle, from any worktree. **How does my change look** is
`mc shot dev <target>` from your worktree, which serves your tree.

- `--viewport iphone` carries the safe area. `--measure <css>` prints one JSON
  line per match: rectangle, padding, position, computed colours, scroll state
  and visibility with the ancestors walked.
- `--keep`, then `mc shot next [<id>] --click/--fill/--press/--upload/--eval`,
  steps a flow; errors come back in the same call.
- Never a hand-written Playwright script while a flag does it. A measurement
  `mc shot` cannot take still walks the ancestors for visibility (`display`,
  `visibility`, `opacity`, zero size, `clip-path`), gives every browser call a
  timeout, and states the width both sides of a comparison were taken at.
- **Prove which tree is served before you measure.** A port says nothing about
  the worktree behind it, and a 404 on a file that exists is a stale asset
  manifest. Outside `mc shot`, check before every run:
  `curl -s "$URL/<the file you edited>" | grep -c '<something only your branch has>'`
  — 1 is your tree; 0 means do not measure.
