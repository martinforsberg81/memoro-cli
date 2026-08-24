section: Added

- **`mc suite run "<command>"` — take the suite right, run the command, give
  the right back when it ends (D-0176).** `claim` + a separate command is two
  steps with a human decision between them, and the decision was measured
  being skipped three times in one day: a track chained
  `mc suite claim; npm test` with `;` and never read the refusal (printed,
  exit 1, stderr — a check that ran and whose result nobody looked at); an
  interrupt between the steps left the lease standing for PM's 2h25m
  (D-0167); a command timeout killed a suite mid-run and left the lease
  again. The one-step form: refused means **nothing runs** and the exit is
  the refusal's, with the same words as a refused claim; the lease is
  released on success, on failure, and on SIGINT/SIGTERM, where the
  command's whole process group is ended first; a right claimed by hand
  beforehand stays held afterwards — `run` gives back only what it took.
  `claim`/`release` stay for the gate round, which holds the right across
  several commands. Measured live: SIGTERM two seconds into a run killed
  the child and released the lease, and a run against a right PM held
  printed the refusal, ran nothing, and woke PM.
