section: Added

- **After a green merge, the round freshens the open branches it just made
  dirty (A6).** Measured 2026-08-23: one branch was rebased twice in forty
  minutes because main moved under it — ~12 minutes of a track's time, none
  of it value — and three of the day's PRs touched the same hotspot file.
  While the lease is still held, every open PR branch behind the base gets
  the base merged *into* it (never a rebase: the convention since #363→#364
  is merge-main-in, no force-push, and rewriting somebody else's branch is
  history rewriting in their work — decided with the PM 2026-08-23) and a
  plain push, with a line in the owning area's inbox saying exactly what
  happened; no knock — a moved branch can wait for the owner's next turn.
  The hard rules: a conflict touches nothing (aborted, branch and files
  named; conflicts only under `artifacts/` are said as regenerate-never-
  resolve and still not resolved); the declared `affected` command runs
  first when the gate table declares one, and red means no push; no
  declaration means no run, said plainly, never a guessed script name; a
  branch somebody is working in right now is skipped. A freshen failure
  never un-merges anything and never fails the round. And inside a batch,
  the same mechanic runs **between the landings**: each squash-merge makes
  the next pull request in the batch unmergeable (measured on the first
  live batch: five verified together, one landed, four refused), so the
  next branch gets the just-made main merged in and pushed before its turn.
