# CLAUDE.md

Repo-owned instruction contract for **Claude Code**. The full, tool-agnostic
content lives at [`docs/coding-agent-protocol.md`](docs/coding-agent-protocol.md) — **read
that first**.

Work here is projects: `PLAN.json` and `STATE.json` under
`~/mc/programs/<programme>/<project>/`, written through `mc project` and
`mc step`, built by `mc run`, landed through `mc merge`. Martin opens an
interactive plan session in `~/mc/programs/<programme>/` with `mc plan`.
A session already there never runs `mc plan`: use `mc project new`,
`mc project step add` and `mc project send`. `MC_ROLE` names a launched
session; SessionStart names the role first, with cwd fallback for a session
opened by hand. A headless plan session is not built yet. The protocol's
*How work is organized* is the account; never edit plan state by hand.

Beside projects, a goal is `GOAL.md` and `LOG.md` and a worktree per repository
under `~/mc/programs/<programme>/goals/<goal>/`: a goal session logs with
`mc goal log` and pushes with `mc publish --no-merge`, and `mc merge` is never
its act (the protocol's *How work is organized*, and `docs/technical/mc-goals.md`).

This file belongs to the repository and to whoever edits it. mc does not
write it, read it, or check it for drift — that machinery is gone. To update
project conventions, edit `docs/coding-agent-protocol.md` and reflect the
change here by hand.

There is no Coding Profile: mc hands a session its role and nothing else
(ruling 24, `docs/project/mc/rulings.md` § 24).

