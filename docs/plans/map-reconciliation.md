# Map Reconciliation Guard

**Status:** active · 2026-06-06 · serves G1, G3

Reading `MEMORO.md` at session start does not make an LLM remember to update it.
The product needs a reconciliation loop: deterministic prompts and status hints
that force the question at the right time without silently editing the map.

## Product rule

`MEMORO.md` is read-only by default. After non-trivial work, the session must
decide whether the map changed. If yes, it proposes a concrete patch and asks the
user before writing.

## Map discipline

Keep the map brutal:

- max 10-14 active nodes
- `active · now` should be rare and meaningful
- every active node needs a track: plan file, branch/worktree, PR, or next action
- shipped/archived-recently should hold recent exits so stale active nodes do not
  linger

## mc tripwires

Start with hints, not a command family:

- `mc status <name>` can show `map: likely-stale` when a session has shipped work
  or new plan files but `MEMORO.md` did not move.
- `mc end <name>` can warn when a dirty/shipped session did not reconcile the map.
- `mc list --rich`/tree views can surface project sessions without a map node.

## Session Prompt Affordance

A lightweight in-session slash command is in scope if it only hands the LLM a
well-written reconciliation prompt. For example, `/mc map` can tell the current
session to inspect recent commits, plans, release notes, and `MEMORO.md`, then
draft a concrete patch for user approval.

This is deliberately not a map CRUD API:

- no silent writes
- no `mc map set-status` / `mc map add-node` command family
- no auto-generated roadmap text bypassing coordinator review
- the LLM drafts the patch, the user approves it, then the file is edited and
  committed as cross-session project state
