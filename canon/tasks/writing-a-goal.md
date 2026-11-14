---
name: writing-a-goal
description: Writing or changing a goal's GOAL.json with the mc goal verbs — new, set, criteria, documents, order by phase. Use before mc goal new, set, criterion add, document add or phase.
---
# Writing a goal with `mc goal`

A goal is written through the verbs; the files are mc's. It is instructions for a headless build session that has read nothing else, with nobody watching: can that session build it start to finish,
and know when it is done? If not, it is not a goal yet.

1. `mc goal new <programme>/<goal> --repo memoro|memoro-cli --class
   fast|medium|large --title "…" [--phase <n>] [--stage draft|build]` — the
   skeleton, in `draft` (nothing happens to it there) unless `--stage build`,
   and in phase 1 unless `--phase` says another.
2. `mc goal set <p>/<g> goal|contract|out-of-scope --text "…"` — what the
   work is, what may not change without Martin, what is left out, named.
3. `mc goal criterion add <p>/<g> --criterion "…" --check "…"` per success
   criterion; the runner starts no goal without one.
4. `mc goal document add <p>/<g> --label "…" --path "…"` for each document the
   build session must read.
5. `mc goal show <p>/<g>` renders it as the build session will read it.
6. `mc goal stage <p>/<g> build` once it is ready to be built.

Work that is several pieces in order is several goals, each in the phase after the one before: a
goal starts only when every goal of its programme in a lower phase is done or dropped. `mc goal
phase <p>/<g> <n>` changes the order later; goals of one phase run side by side; phases may be
renumbered; a `draft` goal holds later phases back too. The cut into goals and phases is
[designing a programme](designing-a-programme.md): a finished brief stands in `build` in its phase.

- **Readiness:** before creating a goal, including a `draft` skeleton, apply [goal
  design](references/goal-design.md): establish the problem, choose the solution, and define
  success criteria and exclusions. Missing investigation stays with the proposal. A goal that waits
  on others waits in `build` in a later phase, not in `draft`; policy and acceptance come first.
- **Criteria:** each states an observable outcome and pass/fail boundary; its `check` gives runnable
  commands, working directory, prerequisites and expected results. For branch comparisons, use
  `git diff origin/main...HEAD`; for reports, specify reconciliation and evidence. A file, keyword
  or green gate alone does not prove content. No check waits for Martin; put policy choices in
  planning, not acceptance.
- **Evidence:** distinguish measured, historical and missing proof. Record revision, scope and logs;
  partial, skipped or unavailable evidence is not green. Mark criteria met only after the whole check
  holds. Follow writing-tests.md for costs; moving work between clocks is not a saving.
- **Live evidence:** a live check (app, browser) gives its command and prerequisites; read the
  ceiling from evidence: the verdict's wall time is under N s, not enforced by a wrapper. Do not
  set a run count, stage allocation, reserved run or load condition: a check that holds only on a quiet
  machine is a defect to repair. Rerun after a change or diagnosis; failure is evidence, not budget.
- **What users see:** a UI goal states the intended result per viewport and checks it with `mc shot`
  there. Plan several build iterations: compare screenshots with the intent until they agree.
- **Standards:** list the `docs/technical/` documents it holds to; criteria apply them, never set new.
- **What waits on Martin:** only what [asking-martin](asking-martin.md) names, resolved before build.
- **Test protection:** name protected behaviours, failure consequences, the cheapest credible test
  level and existing tests to reuse. State the evidence the build must produce, or why no new
  automated test is warranted. Follow [writing-tests.md](writing-tests.md); not every fix needs one.
- **Class:** `fast` when the goal says exactly what changes, where and in what order; `medium`
  when the solution is chosen and the brief names the components it touches, and the build works
  out the change across them; `large` only for work that must choose between designs the brief
  could not choose for. Never a concrete model.
- **Before writing:** investigate yourself — read the code, measure, try it. Name the file behind
  every claim, and only files you opened. A brief that says a state is set wrongly names the caller
  that sets it today and the stage it runs in; its fixture uses that stage. Leave out the case for
  the goal, history, and what code shows.
- **Proposals consumed:** move them to the programme's `proposals/archive/` in the same move,
  first line `Utfall: <the goal>`, and carry into the goal everything it needs from them.
