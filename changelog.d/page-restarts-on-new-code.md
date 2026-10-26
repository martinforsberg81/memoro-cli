section: Fixed

- **An open `mc` page starts again when the code mc runs from moves.** Node
  reads its modules once, so a page left open while `~/mc/self` fast-forwarded
  went on drawing with the code it started on: on 2026-10-26 a page started the
  morning before showed codex-models as `invalid — steps[2].kind: unknown key`
  a day after the review kind had landed. Every live draw now reads the
  checkout's commit, and a page whose commit has moved runs `mc` again in the
  same terminal, wrapper fd 3 included, the way `mc run --update` hands the
  runner over.
