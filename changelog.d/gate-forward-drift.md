section: Fixed

- **A gate round no longer throws its verdict away because main moved
  forward.** `mc merge` re-read `origin/<base>` after the suites and refused on
  any change at all, so with several sessions landing all day the ground was
  never still: measured over the 166 rounds in `gate-rounds.jsonl` on
  2026-08-29, eight refused with `drift` — and **every one of the eight was a
  plain fast-forward, exactly one commit ahead**. Not one was a rewrite. A
  round costs 3.7 minutes at the median and 101 at the worst, so each refusal
  bought another identical measurement arriving just as late. The check now
  asks the question it meant: a base that was rewritten or diverged is still
  drift, a forward move over a file this change also touches is still drift and
  names the files, and a forward move anywhere else is not — the verdict is
  differential, and it still answers the question it was asked. A red verdict
  never reaches this check; nothing here can land one.
