section: Changed

- **`mc merge`'s documentation says how to land a stack, and what the batch
  form will not do.** A batch requires every pull request to aim at the same
  base, so a stack stops the round at `pr` before anything is measured. The
  step that makes it work is on the forge: retarget every branch at `main`
  first, and the same command is accepted — each head already contains the ones
  below it. *Landing a stack* now says that, and three things measured while
  landing a three-step `memoro-cli` stack on 2026-09-01. A batch is not atomic:
  red on a test that was already red on `main`, it fell back to a round per
  pull request, landed the first and refused the other two. A squashed base
  leaves the branches above it conflicting whatever the caller did between
  rounds, because the round merges the current base into the candidate before
  measuring. And rebase is what gets them in — five rebases, three
  byte-identical in patch, two conflicting on real overlap with what had
  landed and neither on the stacking.
