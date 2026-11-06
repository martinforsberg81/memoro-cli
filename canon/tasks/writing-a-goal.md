---
name: writing-a-goal
description: Writing or changing a goal's GOAL.json with the mc goal verbs — new, set, criteria, documents, order by phase. Use before mc goal new, set, criterion add, document add or phase.
---
# Writing a goal with `mc goal`

A goal is written through the verbs; the files are mc's. It is instructions
for a headless build session that has read nothing else, with nobody watching:
can that session build it start to finish, and know when it is done? If not,
it is not a goal yet.

1. `mc goal new <programme>/<goal> --repo memoro|memoro-cli --class
   fast|large --title "…" [--phase <n>] [--stage plan|build]` — the
   skeleton, in `plan` (nothing happens to it there) unless `--stage build`,
   and in phase 1 unless `--phase` says another.
2. `mc goal set <p>/<g> goal|contract|out-of-scope --text "…"` — what the
   work is, what may not change without Martin, what is left out, named.
3. `mc goal criterion add <p>/<g> --criterion "…" --check "…"` per success
   criterion; the runner starts no goal without one.
4. `mc goal document add <p>/<g> --label "…" --path "…"` for each document the
   build session must read.
5. `mc goal show <p>/<g>` renders it as the build session will read it.
6. `mc goal stage <p>/<g> build` once it is ready to be built.

Work that is several pieces in order is several goals, each in the phase after
the one before: a goal starts only when every goal of its programme in a lower
phase is done or dropped. `mc goal phase <p>/<g> <n>` changes the order later;
goals of one phase run side by side. Phase numbers may be renumbered; name
prerequisite goals too. A plan placeholder also holds later phases back.

- **Readiness:** before creating a goal, including a `plan` skeleton, apply
  [goal design](references/goal-design.md): establish the problem, choose the
  solution, and define success criteria and exclusions. Missing investigation
  stays with the proposal. A concrete future goal may wait in `plan` for named
  prerequisites; resolve policy and acceptance before activating build.
- **Criteria:** each states an observable outcome and pass/fail boundary; its `check` gives runnable
  commands, working directory, prerequisites and expected results. For reports, specify reconciliation
  and evidence; a file, keyword or green gate alone does not prove content. No check waits for Martin;
  put policy choices in planning, not acceptance.
- **Evidence:** distinguish measured, historical and missing proof. Record revision, scope and logs;
  partial, skipped or unavailable evidence is not green. Mark criteria met only after the whole check
  holds. Follow writing-tests.md for costs; moving work between clocks is not a saving.
- **Bounded live evidence:** specify total live runs (offline checks excluded), duration/run,
  serial/concurrency limits, build/review/finish allocations, prerequisites and run consumption (failures/timeouts count).
  Reserve any required independent-review run before build; build spends only its allocation. An
  account/binary restores none. With no run left, commission executable offline reconciliation
  (command/procedure, evidence, expected result, limits). Inspected traces are not reproduced;
  missing essential proof fails acceptance and goes to finish/plan within authority, without retry.
- **Test protection:** name protected behaviours, failure consequences, the
  cheapest credible test level and existing tests to reuse. State the evidence
  the build must produce, or why no new automated test is warranted. Follow
  [writing-tests.md](writing-tests.md); do not default every fix to a new test.
- **Class:** `fast` when the goal says exactly what changes, where and in what
  order; `large` only for work that must choose and that you cannot choose
  for. Never a concrete model.
- **Before writing:** investigate yourself — read the code, measure, try it. Name the file behind
  every claim, and only files you opened. Leave out the case for the goal, history, and what code shows.
- **Proposals consumed:** move them to the programme's `proposals/archive/` in the same move,
  first line `Utfall: <the goal>`, and carry into the goal everything it needs from them.
