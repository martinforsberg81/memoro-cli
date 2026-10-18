section: Fixed

- **The merger writes an answer given before the round to `merges.json` at
  once.** A batch member merged or closed on GitHub, or whose restack was
  refused, was answered in the register before the round but read `landing`
  in `merges.json` — and so on the page and in `mc merge watch` — until the
  others' round ended (2026-10-10: #13400 and #13397 for 9 minutes). `landJob`
  now tells `serve` each answer as it gives it (`onAnswer`), and `serve`
  dequeues it, marks it red, or sets it `mending` then. A restack red that
  gets its mend starts it as soon as the mend line is free, not when the
  round ends (#13397 waited 100 s).
