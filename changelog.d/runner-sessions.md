section: Changed

- **`mc run lanes <n>` is the total number of headless sessions, across every
  repository and kind.** It was `per_repo` lanes on each repository, capped by
  `--total`, so a lane on a repository with nothing to do sat idle while the
  other's work waited. `per_repo` and `--total` are refused with a line
  saying what replaced them, and an old `lanes.json` is read once into the
  total it allowed. A free lane takes the next work of any kind on any
  repository: the project it carries, then a review, a project's build, a
  goal's build, the longest waiting first, and no repository past its share
  of the lanes while another has work (`lane-pick.js`).
- **One build role in two variants.** `canon/roles/step.md` and `goal.md`
  are `build-project.md` and `build-goal.md`, sharing `_build.md`: one branch
  built to the end, never merged with `origin/main` except for a conflict the
  merger reported, and when a session ends. Lane files carry `kind` (`build`,
  `review`) and `variant` (`project`, `goal`); `runs.tsv` rows say
  `build-project`, `review-project`, `build-goal`, `review-goal`, and rows
  written before are still read.
- **The page's runner section is SESSIONS, one row per session with its kind
  first.** `PLAN`, `BUILD` or `REVIEW`, then what it works on — a goal
  `mc/<goal>`, or a project and its step `docx-editor 4/6` — the repository,
  the model and the clock; the heading says `5 of 6 lanes`. It was STEPS,
  which a goal's build and a review are not. The day line counts where each
  kind's sessions left their work — `build 53 (39 built, 3 blocked, 1 failed)
  · review 15 (15 queued)` — instead of counting every runs.tsv row, merge
  rounds and helper turns with them, as steps. `mc --json` carries
  `runner.sessions` (with `kind`, `variant` and `goal`), each lane's
  `session`, and `runner.day.by_kind`; `mc status <name>` names its last runs
  `build` or `review`.
- **`mc goal open` remakes a goal branch with no commits of its own** from
  `origin/main`, so a goal written blocked behind another starts from the
  main it waited for. A branch with commits is never moved.
