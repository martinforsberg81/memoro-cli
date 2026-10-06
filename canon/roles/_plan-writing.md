## Writing a PLAN.json

A plan is instructions for a headless session that has read nothing else, with
nobody watching. Every step must pass one test: can that session build it
start to finish, and know when it is done? If not, it is not a step
(ruling 19).

- **Where:** `docs/project/<programme>/<project>/PLAN.json` in the repository
  the work is in. `<project>` becomes the runner's branch and workarea; create
  neither. A plan on `main` whose first unfinished step is `ready` is run —
  landing it is the handover.
- **Shape:** `src/mc/plan-schema.js`; what each field is for:
  `docs/project/README.md` § *What a PLAN.json is*. Read them; do not guess.
- **Before writing:** do every investigation yourself — read the code,
  measure, try it — so each step stands on an answer. No step whose content
  depends on what an earlier step finds: the plan ends at that earlier step.
- **No review in a plan:** no "show Martin", "decide whether", "evaluate",
  "propose". Anything he must see is done in session first.
- **Each step:** `instruction` as long as the work needs — interface, order,
  edge cases, the trap. `done_when`: one checkable sentence. Name the file
  behind every claim, and only files you opened.
- **Overall:** `goal`; `contract` (what may not change without Martin);
  `out_of_scope`, named; `success_criteria` with a `check` — for anything
  with a surface, measured in the running app. All frozen: a step session
  writes only `met`.
- **Leave out:** the case for the plan, history, what the code already shows.
- **Validate before pushing:**
  `node --input-type=module -e "import {readPlanText} from '$HOME/memoro-cli/src/mc/plan-schema.js'; import {readFileSync} from 'node:fs'; console.log(readPlanText(readFileSync(process.argv[1],'utf8')).problems)" <PLAN.json>`
  must print `[]`. Land with `mc merge <repo> <pr> --docs`; `mc status
  <project>` shows it from `main`.
- **Proposals consumed:** move them to `~/mc/proposals/archive/` in the same
  move, name them in the PR body, and carry into the plan everything it needs
  from them — nobody reads the archive (ruling 22).
- **Decisions:** cite by name, never by path. Record the ruling in
  `docs/project/<programme>/rulings.md`: the question, Martin's answer quoted,
  the plan that carries it.
