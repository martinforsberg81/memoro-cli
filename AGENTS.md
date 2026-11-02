# AGENTS.md

Repo-owned instruction contract for **Codex CLI**. The full, tool-agnostic
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

This file belongs to the repository and to whoever edits it. mc does not
write it, read it, or check it for drift — that machinery is gone. To update
project conventions, edit `docs/coding-agent-protocol.md` and reflect the
change here by hand.

It is not a Coding Profile mirror. Work-method changes are the user's, live in
Memoro, and reach a new conversation as a launch argument. mc reads the
profile and hands it over; it has no verb for editing one (`mc coding-profile`
went with mc-cut), so it is edited in Memoro.

