---
name: writing-a-goal
description: Writing or changing a goal's GOAL.json with the mc goal verbs — new, set, items, obligations, criteria, documents, order by phase. Use before mc goal new, set, item, obligation, criterion add, document add or phase.
---
# Writing a goal with `mc goal`

A goal is written through the verbs; the files are mc's. It is instructions for a headless build session that has read nothing else, with nobody watching: can that session build it start to finish,
and know when it is done? If not, it is not a goal yet.

A goal is numbered parts. Each answers one question the build session has, and the review checks the change against the same part: what a goal
names is reviewed, what it does not name is not. [The parts](references/goal-design.md#the-parts) says what each holds.

1. `mc goal new <programme>/<goal> --repo memoro|memoro-cli --class fast|medium|large --title "…" [--phase <n>]` — the skeleton, always in
   `draft` (nothing happens to it there; `--stage build` is refused), and in phase 1 unless `--phase` says another.
2. `mc goal set <p>/<g> aim|outcome|latitude|protection --text "…"` — why it is done, what is true when it is done, what the build chooses, what is tested.
3. `mc goal item add <p>/<g> problem|premise|decision|change|preserve|risk|out-of-scope --text "…"` with the part's flags (`mc goal --help`). It
   prints the item's id (`P3`, `C1`); `item set <id>` changes one and `item remove <id> --reason "…"` takes it out. Cite the id, never a position.
4. `mc goal areas <p>/<g>` shows the areas of the goal's repositories with each page, the questions of a rule area and the goal's stand on it; a
   source area asks no stand. Read the page of each area the goal touches. Take a stand on every rule area: `mc goal obligation set <p>/<g> <repo>/<id> --stand touched|untouched --text "…" [--standard "<repo>/<path>#<section>"]`.
5. `mc goal criterion add <p>/<g> --criterion "…" --check "…" [--evidence "…"]` per success criterion; the runner starts no goal without one.
   `mc goal document add <p>/<g> --label "…" --path "…"` for each document the build session must read.
6. `mc goal show <p>/<g>` renders it as the build session will read it.
   `mc goal stage <p>/<g> build` moves a goal that is complete.

Work that is several pieces in order is several goals in phases. In a programme whose record states its phases a goal starts when every goal of each
phase its own is stated to wait for is done or dropped (`mc programs after`); in every other programme, when every goal in a lower phase is. `mc goal phase
<p>/<g> <n>` changes the order later; goals of one phase run side by side; a `draft` goal holds back the phases that wait for its phase. The cut into goals and
phases is [designing a programme](designing-a-programme.md): a complete brief enters `build` only after its acceptance procedure and setup are verified.

- **Readiness:** before creating a goal, including a `draft` skeleton, apply [goal design](references/goal-design.md): establish the problem,
  choose the solution, and define success criteria and exclusions. Missing investigation stays with the proposal. A goal that waits on others
  waits in `build` in a later phase, not in `draft`; policy and acceptance come first.
- **Required:** `outcome`, at least one `change`, a stand on every rule area, and the criteria. Every other part when it has content.
- **Premises:** a premise is a claim the goal would be wrong without, with its source (file and line, or the command that produced it), its basis
  and the revision it held at. "Every", "only" and "no other" in a criterion, a preserve item or a change point to the premise that holds the
  inventory. Investigate yourself — read the code, measure, try it — and name only files you opened. Leave out the case for the goal, history, and what code shows.
- **Obligations:** ask each question of an area whose condition holds for this change. `touched` says what must hold here and names the
  standard; `untouched` gives the reason, and the review holds the diff against it. Criteria apply the standards, never set new ones.
- **Risks:** how this change can go wrong; each is settled by a criterion, by the protection, or is accepted with its reason.
- **Criteria:** each states an observable outcome and pass/fail boundary; its `check` gives runnable commands, working directory, prerequisites
  and expected results, and can run now, on the runner's host, before merge. For branch comparisons, use `git diff origin/main...HEAD`. A file,
  keyword or green gate alone does not prove content. No check waits for anyone or passes through a reserved act: it exercises the
  mechanism below the reserved command and stops short of the act. Put policy
  choices in planning, not acceptance.
  [Goal design](references/goal-design.md#success-criteria) holds the rules for evidence and for a live check.
- **What users see:** a UI goal states the intended result per viewport and checks it with `mc shot` there. Plan several build iterations:
  compare screenshots with the intent until they agree. It names the tokens, components, icons and assets it reuses and each one it adds.
- **What waits on Martin:** only what [asking-martin](asking-martin.md) names, resolved before build and recorded as a decision item.
- **Test protection:** `protection` names protected behaviours, failure consequences, the cheapest credible test level, existing tests to reuse
  and the fault to replay, and states the evidence the build must produce, or why no new automated test is warranted. Follow [writing-tests.md](writing-tests.md); not every fix needs one.
- **Class:** `fast` when the goal says exactly what changes, where and in what order; `medium` when the solution is chosen, `change` names the
  components, and the build works out their change; `large` only for work that must choose between designs the goal could not choose for.
  Never a concrete model.
- **Out of scope:** each item names its owner: another goal, another programme, or nobody.
- **Proposals consumed:** the programme document names them and the desk has archived them in their area
  ([proposals](proposals.md)); carry into the goal everything it needs from them.
