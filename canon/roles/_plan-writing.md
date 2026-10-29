## Writing a PLAN.json

A plan is instructions for a headless session that has read nothing else, with
nobody watching. Every step must pass one test: can that session build it
start to finish, and know when it is done? If not, it is not a step
(ruling 19).

- **Where:** a plan is written with `mc project` verbs, never by editing a
  file (ruling 48): `mc project new <programme>/<project> --repo memoro|memoro-cli
  --goal … --contract … --out-of-scope … [--tool codex]`, then `mc project criterion add` per
  criterion (`mc project criterion drop <project> <n> --reason "…"` takes one
  out that nobody can measure), `mc project step add` per step (`--model`: `fast`
  or `large` for an ordinary step, or a concrete model below; `--done-when`,
  `--instruction-file <md>` with the step's paragraphs,
  `--after <repo>:<project>` for a dependency), then `mc project send
  <project>`, which checks the whole plan and hands it to the runner.
  `mc project <project>` shows a draft and what send would refuse. No branch,
  no pull request.
- **Shape:** `src/mc/plan-schema.js`; what each field is for:
  `docs/project/README.md` § *What a PLAN.json is*. Read them; do not guess.
- **Before writing:** do every investigation yourself — read the code,
  measure, try it — so each step stands on an answer. No step whose content
  depends on what an earlier step finds: the plan ends at that earlier step.
- **Nothing in a plan is Martin's:** no step, `done_when`, criterion or
  `check` that waits on him. No "show Martin", "Martin's check", "at his
  terminal", "by hand", "decide whether", "evaluate", "propose", and no
  review step: `mc project send` adds one, last, and it measures the criteria and lands the project. Anything he must see or decide is
  done in session, before the plan lands; he tests once the project is done.
  - **Every `check` is the step's to run.** A live check on this machine —
    a service stopped and started, a build, an install on the paired phone,
    a wait for the runner's next chore pass — is commands the review runs, not a hand check. Write them as commands.
  - **A check the review step's own branch cannot reach is not a criterion.**
    The merge door refuses the review step until every criterion is `met` in the
    register, so a check that needs this plan landed first (the runner updated,
    the page redrawn from main) never passes. Measure it from the branch
    (`node src/mc-cli.js …`), or leave it out. `mc project criterion add` and
    `mc project send` refuse a check that says "after the deploy", "in
    production", "not a step's" or names Martin; A plan lands once, at its
    review, so nothing in it can wait for its own deploy: a check that needs
    production is left out of the plan.
  - **Work outside this plan comes first.** A criterion that needs another
    project's code on main is not written until that code is on main; a
    person's act (a sign-in, a production migration, a store submission) is
    named in `out_of_scope` and is never a criterion.
- **Each step:** `instruction` as long as the work needs — interface, order,
  edge cases, the trap. `done_when`: one checkable sentence. Name the file
  behind every claim, and only files you opened.
- **Model per step (ruling 59, ruling 42):** every step names a `--model`. An
  ordinary implementation step names a **work class**, `fast` or `large`, not a
  provider's model. A class says how much judgement the step needs; it does not
  claim that two providers' models are equal in quality. When the step starts,
  mc resolves the class to a candidate from its catalog (`mc model list`) and
  from the subscription capacity it has observed. The candidate's tool, model
  and effort are the session's. Only included subscriptions are candidates, so a
  class step never spends a credit, and a session that has started is never
  switched to another provider.
  - **`fast`** for a step whose `instruction` says exactly what changes, where
    and in what order, and whose `done_when` passes or fails on its own — a
    test, a grep, an unchanged digest. Many narrow `fast` steps beat one broad
    `large` step.
  - **`large`** only for a step that must choose, and that you cannot choose for
    it: a layout or visual result judged against `mc shot`, a change spread
    across many files whose shape the code only shows while it is being made, a
    concurrency or ordering change where every edge case cannot be listed, a
    merge that is expected to conflict. Try to split it first: decide here, and
    let `fast` steps carry it out.
  - Unsure? Write it `fast`. If you cannot write the instruction precisely
    enough for a `fast` step, the investigation is not done: do it here, not in
    a `large` step.
  - **Concrete models still work.** A step may name a model instead of a class:
    `haiku` and `opus` on claude, `gpt-6.1-sol` and `gpt-6-luna` on codex. It
    runs on that model as it always has. A sent plan keeps its meaning: a catalog
    edit never rewrites it, and `mc plan` remains the tool Martin chooses when
    starting a plan.
  - **Review is not a class a step names.** `mc project send` adds the review
    step last. It runs the one review model Martin configures with
    `mc model set review` (Claude Opus at high effort at launch), on either tool,
    and it does not inherit the implementation step's provider. `mc project step
    add` refuses `review`.
  - Never put `model` in the plan's own `runner`: it makes every step that
    model. The model is named on each step, never left to the default.
- **Codex.** `gpt-6.1-sol` and `gpt-6-luna` are Codex's models, not stand-ins
  for `haiku` or `opus`. A concrete Codex name goes on a `--tool codex` plan, and
  a Claude name is refused there. A class names no tool, so the plan's
  `runner.tool` does not apply to it. `effort` takes the same five levels on
  both tools; on codex it reaches the session as `-c model_reasoning_effort=<level>`.
  The name goes to `codex exec -m`, and which names exist is for the installed,
  signed-in codex CLI to decide, not mc.
- **Overall:** `goal`; `contract` (what may not change without Martin);
  `out_of_scope`, named; `success_criteria` with a `check` — for anything
  with a surface, measured in the running app. All frozen: a step session
  records a met criterion with mc project criterion met, never in the file.
- **Leave out:** the case for the plan, history, what the code already shows.
- **Validate:** `mc project send` is the validation; it refuses and says why.
- **Proposals consumed:** move them to `~/mc/proposals/archive/` in the same
  move, name them in the PR body, and carry into the plan everything it needs
  from them — nobody reads the archive (ruling 22).
- **Decisions:** cite by name, never by path. Record the ruling in
  `docs/project/<programme>/rulings.md`: the question, Martin's answer quoted,
  the plan that carries it.
