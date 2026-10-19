## Writing a PLAN.json

A plan is instructions for a headless session that has read nothing else, with
nobody watching. Every step must pass one test: can that session build it
start to finish, and know when it is done? If not, it is not a step
(ruling 19).

- **Where:** plans live in mc, not in a repository (ruling 48):
  `~/mc/programs/<programme>/<project>/PLAN.json`, with a top-level `"repo":
  "memoro"` or `"memoro-cli"` naming where the steps run. `<project>` becomes
  the runner's branch and workarea; create neither. Write it to a temporary
  file beside it, validate, then `mv` it into place: the runner reads the
  directory, so a plan whose first unfinished step is `ready` is run as soon
  as it is there, and moving it in is the handover. No branch, no pull request.
- **Shape:** `src/mc/plan-schema.js`; what each field is for:
  `docs/project/README.md` § *What a PLAN.json is*. Read them; do not guess.
- **Before writing:** do every investigation yourself — read the code,
  measure, try it — so each step stands on an answer. No step whose content
  depends on what an earlier step finds: the plan ends at that earlier step.
- **Nothing in a plan is Martin's:** no step, `done_when`, criterion or
  `check` that waits on him. No "show Martin", "Martin's check", "at his
  terminal", "by hand", "decide whether", "evaluate", "propose", and no
  review step — there is no such step yet. Anything he must see or decide is
  done in session, before the plan lands; he tests once the project is done.
  - **Every `check` is the step's to run.** A live check on this machine —
    a service stopped and started, a build, an install on the paired phone,
    a wait for the runner's next chore pass — is commands the last step
    runs, not a hand check. Write them as commands.
  - **A check the last step's own branch cannot reach is not a criterion.**
    The merge door refuses the last step until every criterion is `met` in the
    register, so a check that needs this plan landed first (the runner updated,
    the page redrawn from main) never passes. Measure it from the branch
    (`node src/mc-cli.js …`), or leave it out.
  - **Work outside this plan comes first.** A criterion that needs another
    project's code on main is not written until that code is on main; a
    person's act (a sign-in, a production migration, a store submission) is
    named in `out_of_scope` and is never a criterion.
- **Each step:** `instruction` as long as the work needs — interface, order,
  edge cases, the trap. `done_when`: one checkable sentence. Name the file
  behind every claim, and only files you opened.
- **Model per step (ruling 42):** every step names `runner.model`. Haiku is
  the first choice: `{ "model": "haiku", "effort": "high" }` for a step
  whose `instruction` says exactly what changes, where and in what order,
  and whose `done_when` passes or fails on its own — a test, a grep, an
  unchanged digest. `opus` only for a step that needs design or judgement no
  instruction can settle beforehand, and only once you have tried to split
  it: decide here, and let Haiku steps carry it out. Many narrow Haiku steps
  beat one broad Opus step.
  - Never put `model` in the plan's own `runner`: it makes every step that
    model. The model is named on each step, never left to the default.
  - **Haiku** when you can name the files, the functions, the order and the
    tests: a bug whose cause you found, a function whose signature and cases
    you wrote down, wiring a finished function into its call site, a flag or
    message, a doc paragraph, a test the instruction lists case by case.
  - **Opus** only when the step itself must choose, and you cannot choose
    for it: a layout or visual result judged against `mc shot`, a change
    spread across many files whose shape the code only shows while it is
    being made, a concurrency or ordering change where every edge case
    cannot be listed, a merge that is expected to conflict.
  - Unsure? Write it as Haiku. If you cannot write the instruction precisely
    enough for Haiku, the investigation is not done: do it here, not in an
    Opus step.
- **Overall:** `goal`; `contract` (what may not change without Martin);
  `out_of_scope`, named; `success_criteria` with a `check` — for anything
  with a surface, measured in the running app. All frozen: a step session
  records a met criterion with mc project criterion met, never in the file.
- **Leave out:** the case for the plan, history, what the code already shows.
- **Validate before moving it in:**
  `node --input-type=module -e "import {readPlanText} from '$HOME/memoro-cli/src/mc/plan-schema.js'; import {readFileSync} from 'node:fs'; console.log(readPlanText(readFileSync(process.argv[1],'utf8')).problems)" <PLAN.json>`
  must print `[]`. ``mc status <project>`` shows it.
- **Proposals consumed:** move them to `~/mc/proposals/archive/` in the same
  move, name them in the PR body, and carry into the plan everything it needs
  from them — nobody reads the archive (ruling 22).
- **Decisions:** cite by name, never by path. Record the ruling in
  `docs/project/<programme>/rulings.md`: the question, Martin's answer quoted,
  the plan that carries it.
