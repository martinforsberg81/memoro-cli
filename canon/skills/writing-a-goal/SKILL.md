---
name: writing-a-goal
description: Writing or changing a goal's GOAL.json with the mc goal verbs — new, set, criteria, documents, order with after. Use before mc goal new, set, criterion add, document add or after.
---
# Writing a goal with `mc goal`

A goal is written through the verbs; the files are mc's. It is instructions
for a headless build session that has read nothing else, with nobody watching:
can that session build it start to finish, and know when it is done? If not,
it is not a goal yet.

1. `mc goal new <programme>/<goal> --repo memoro|memoro-cli --class
   fast|large --title "…" [--after <p>/<g>]` — the skeleton, waiting until
   what it is after has landed.
2. `mc goal set <p>/<g> goal|contract|out-of-scope --text "…"` — what the
   work is, what may not change without Martin, what is left out, named.
3. `mc goal criterion add <p>/<g> --criterion "…" --check "…"` per success
   criterion; the runner starts no goal without one.
4. `mc goal document add <p>/<g> --label "…" --path "…"` for each document the
   build session must read.
5. `mc goal show <p>/<g>` renders it as the build session will read it.

Work that is several pieces in order is several goals: each `--after` the one
before (`mc goal after` changes the order later).

- **Nothing in a goal is Martin's:** no criterion or `check` that waits on
  him — no "show Martin", "by hand", "decide whether", "evaluate". What he
  must see or decide is done in a session, before the goal is written. Every
  `check` is commands a session runs on this machine, from the goal's branch.
- **Class:** `fast` when the goal says exactly what changes, where and in what
  order; `large` only for work that must choose and that you cannot choose
  for. Never a concrete model.
- **Before writing:** investigate yourself — read the code, measure, try it.
  Name the file behind every claim, and only files you opened. Leave out the
  case for the goal, history, and what the code already shows.
- **Proposals consumed:** move them to the programme's `proposals/archive/`
  in the same move, first line `Utfall: <the goal>`, and carry into the goal
  everything it needs from them.
