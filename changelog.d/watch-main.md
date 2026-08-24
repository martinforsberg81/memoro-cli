section: Added

- **The main-watch: is the base branch green, and when did it go red?**
  Ordered twice (D-0190, then D-0199) and built neither time; the
  pm-helper's sweep named it the clearest gap in the batch. Nothing
  measured whether main was green — it was found as a side effect of some
  other round measuring the baseline, and main was red for seven hours of
  one landing and again the next day, discovered only when the next merge
  tried to measure against it while two finished deliveries waited
  (2026-08-24). `mc watch main start --repo <name>` measures the base
  branch **per SHA**: a pass where `origin/main` has not moved costs one
  `git fetch` and no suite, because main only changes when a landing
  lands. A moved main already measured green by the gate's baseline cache
  (every green merge records it, keyed on commit+lockfile+command) is
  green for free; only a landing that bypassed the gate — a github merge,
  a squash whose tree no longer matches — is actually run, in a detached
  worktree under the suite right. It knocks pm on the **transition**, not
  the state: the moment main goes red (or a red main gains a new red
  name), naming the new red and listing the landings in the interval
  (`<last measured>..<now>`, first-parent). A measurement it could not
  take advances nothing, so the next pass retries. The third leg of the
  loop, the same daemon form as `mc watch pm` and `mc watch sessions`,
  and its own knocks are excused from PM's inbox count like the other
  watchers' (watch-senders.js).
