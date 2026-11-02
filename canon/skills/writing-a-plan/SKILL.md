---
name: writing-a-plan
description: Writing or changing a project's PLAN.json with the mc project verbs — draft, criteria, steps, send. Use before mc project new, step add, criterion add or send.
---
# Writing a plan with `mc project`

A plan is written through the verbs; the files are mc's.

1. `mc project new <programme>/<project> --repo memoro|memoro-cli --goal …
   --contract … --out-of-scope … [--tool codex]` — the draft.
2. `mc project criterion add <project> <text> --check <command>` per
   criterion; `criterion drop <project> <n> --reason "…"` for one nobody can
   measure.
3. `mc project step add <project> <title> --model fast|large --done-when …
   --instruction-file <md> [--after <repo>:<project>]` per step, in order.
4. `mc project <project>` shows the draft and what send would refuse.
5. `mc project send <project>` checks the plan, appends its review step and
   hands it to the runner.

A sent plan changes through `mc project amend`, `criterion edit` and
`step edit` (each verb's `--help` says when it may).
