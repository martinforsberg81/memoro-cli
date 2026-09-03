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

This file belongs to the repository and to whoever edits it. mc does not
write it, read it, or check it for drift — that machinery is gone. To update
project conventions, edit `docs/coding-agent-protocol.md` and reflect the
change here by hand.

It is not a Coding Profile mirror. Work-method changes are the user's, live in
Memoro, and reach a new conversation as a launch argument. mc reads the
profile and hands it over; it has no verb for editing one (`mc coding-profile`
went with mc-cut), so it is edited in Memoro.

