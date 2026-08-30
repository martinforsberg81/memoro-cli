section: Fixed

- **A round closes what the plan world built, and lists everything else.** The
  closing had a boundary nobody had drawn: it took down any workarea whose
  project was finished, including folders made long before `PLAN.json` existed.
  On its first real evening, 2026-08-30, it removed 22 — and checked afterwards
  against GitHub, every one of them was a `PLAN.md` project, not one had ever
  had a `PLAN.json`, and every last pull request had merged. Nothing was lost.
  They were still not the runner's folders to take (Martin: *"det jag reagerade
  på var stängning av befintliga worktrees som inte skapats enligt detta
  sätt"*).
  The boundary is a fact in git, not a judgement: does
  `git log origin/main -- docs/project/*/<name>/PLAN.json` find anything? Asked
  of history because the plan itself is gone by the time it matters — the
  archive removed it.
  Two more facts landed with it. A **branch main does not already hold** now
  keeps a workarea, whatever its last row says: `git status --porcelain` sees
  uncommitted changes and says nothing about a commit that was never pushed,
  and the close ends in `git branch -D`. And the merged row is the **last
  delivering** one — a `reconcile` opens no pull request and can never end
  `merged`, which passed over 20 finished workareas on that same round because
  a reconcile happened to run last.
  What the four facts pass over is written to
  `~/mc/intake/finished-workareas.md` with its branch's landing status, raised
  by `mc brief` as a section of its own, and removed by nobody but
  `mc work discard <name> --apply`.
