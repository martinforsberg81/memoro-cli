section: Changed

- **A red that passes alone on the base and the candidate is measured
  again, not blamed on the pull request.** A red round whose files passed on
  the base used to say "this change broke them" from that one quiet run;
  #891 (a role text) and #872 (docs only) were blamed that way and went green
  unchanged. Now the same files also run alone on the candidate: red there is
  the change's red as before, green there stops the round `red-under-load`.
  A file whose tests were cancelled and none failed (a `before` hook that ran
  out of time) is `red-under-load` without a re-run. The merger measures a
  `red-under-load` once more, and answers a second one red with the reason
  that the files passed alone on base and head.
