## Writing a PLAN.json

A plan is instructions for a headless session that has read nothing else, with
nobody watching. Every step must pass one test: can that session build it
start to finish, and know when it is done? If not, it is not a step
(ruling 19).

- **Where:** only with `mc project` verbs, never by editing a file (ruling 48);
  how: skill `mc-writing-a-plan`. No branch, no pull request.
- **Shape:** `src/mc/plan-schema.js` and `docs/project/README.md` § *What a
  PLAN.json is*. Read them; do not guess.
- **Before writing:** investigate yourself — read the code, measure, try it.
  No step whose content depends on what an earlier step finds: the plan ends
  at that earlier step.
- **Nothing in a plan is Martin's:** no step, `done_when`, criterion or
  `check` that waits on him — no "show Martin", "Martin's check", "by hand",
  "decide whether", "evaluate", "propose", and no review step (`mc project
  send` adds it, last; it measures the criteria and lands the project).
  What he must see or decide is done in session, before the plan lands.
  - Every `check` is commands the review runs, a live check on this machine
    included.
  - A check the review's own branch cannot reach (needs this plan landed or
    deployed) is not a criterion: measure it from the branch
    (`node src/mc-cli.js …`) or leave it out.
  - A criterion that needs another project's code waits until that code is
    on main; a person's act goes in `out_of_scope`.
- **Each step:** `instruction` as long as the work needs — interface, order,
  edge cases, the trap. `done_when`: one checkable sentence. Name the file
  behind every claim, and only files you opened.
- **Model per step (ruling 59, ruling 42):** every step names a work class.
  - **`fast`**: the `instruction` says exactly what changes, where and in what
    order, and `done_when` passes or fails on its own. Many narrow `fast`
    steps beat one broad `large` step. Unsure? `fast` — and if you cannot
    write it precisely enough, the investigation is not done.
  - **`large`**: only a step that must choose and that you cannot choose for:
    a visual result judged against `mc shot`, a change whose shape shows only
    while it is made, an ordering change whose edge cases cannot be listed, an
    expected conflict. Try to split it first.
  - A step never names a concrete model. `mc project step add`, `step edit`,
    `send` and `amend` refuse `haiku` and `opus` on claude, `gpt-6.1-sol` and
    `gpt-6-luna` on codex. Never put `model` in the plan's `runner`.
  - Review is not a class a step names: `mc project send` adds the review
    step, on the model set with `mc model set review`.
  - On codex, `effort` reaches the session as
    `-c model_reasoning_effort=<level>` and a model name goes to `codex exec -m`.
- **Overall:** `goal`; `contract` (what may not change without Martin);
  `out_of_scope`, named; `success_criteria` with a `check` — anything with a
  surface measured in the running app. All frozen: a build session records a
  met criterion with `mc project criterion met`, never in the file.
- **Leave out:** the case for the plan, history, what the code already shows.
- **Validate:** `mc project send` is the validation; it refuses and says why.
- **Proposals consumed:** move them to `~/mc/proposals/archive/` in the same
  move, name them in your account, and carry into the plan everything it
  needs from them — nobody reads the archive (ruling 22).
- **Decisions:** cite by name, never by path. Record the ruling in
  `docs/project/<programme>/rulings.md`: the question, Martin's answer quoted,
  the plan that carries it.
