# CLAUDE.md

Repo-owned instruction contract for **Claude Code**. The full, tool-agnostic
content lives at [`docs/coding-agent-protocol.md`](docs/coding-agent-protocol.md) — **read
that first**.

Work here is projects: a `PLAN.json` under `docs/project/<programme>/<project>/`
on `main`, written by `mc plan`, stepped by `mc run`, landed through
`mc merge`, closed out into `docs/project/project_log.md` and
`docs/technical/`. Open questions become decision files that `mc brief`
answers. The protocol's *How work is organized* is the whole of it — you do
not write plan state by hand, and you do not decide.

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

