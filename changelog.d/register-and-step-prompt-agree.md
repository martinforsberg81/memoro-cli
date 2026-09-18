section: Fixed

- **The step prompt and the register now agree about the plan file.** Ruling
  21 moved a step's state into the register on 2026-09-12, and `stepPrompt`,
  the step, worker and brief roles and the protocol went on telling sessions
  to write `status`, `pr`, `blocked_by` and `comments` into `PLAN.json`, where
  nothing reads them after the seed. memoro #11723 blocked itself in the file
  and showed `ready` for six days; #11734 wrote its hand-over into the file's
  `comments` and the next reader had nothing. They now say: state goes through
  `mc step`, the hand-over goes in the pull request and as `mc step note "…"`
  (new — one paragraph onto the step's comments), `mc merge` writes `done`,
  and `met` on a criterion is the one edit a session makes to the file.
- **`mc step blocked` can name a project, and refuses a name that is not
  one.** Both arms of the `--on` ternary were `'decision'`, and the name went
  in unchecked, so `--on project:sql-w1-universe-closure` wrote a blocker the
  plan schema refuses and the page called the whole plan unparseable. `--on
  <decision>` and `--on-project <project>` (checked against the plans on main)
  now, both held to the schema's name pattern, and `patchStep` refuses the
  same for any writer.
- **The register follows a step, not a slot.** `reconcileEntry` matched by
  index, so inserting or reordering steps in a plan re-labelled the state of
  every step behind the edit. Entries now carry a `key` — the label a title
  opens with (`W4.1.2`), else the title — and are matched by it; an entry
  written before keys takes them by index, a plan whose keys repeat is matched
  by index as before, and a `running` step that would move stays put until its
  session ends, because the session knows itself by index.
- **A landed pull request's `## Remainder` is on the step.** A pull request
  that lands is a `done` step; what its body says it left is now kept in
  `landed.remainder` and as a comment on the step, and `mc merge` says so.
