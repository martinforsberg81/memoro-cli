section: Fixed

- **Which suites gate `mc deploy` is now main's tip's to say, not the shipped
  commit's.** On 2026-11-15 main's tip had declared `msr-performance` and
  `msr-reliability-closure` `gate: false` (they measure wall-clock time, and the
  server's load decides them), but the tip had no green full run yet, so the
  deploy picked an older green commit — and read the gate set from that
  commit's `.mc/test.json`, where both were still gates. They went red under
  load and refused the deploy. The gate set (`gate`, `gate_why`, which suites
  gate) is now read from `git show origin/main:.mc/test.json`; the suites still
  run from the shipped commit's tree against its local server. A tip gate the
  commit does not have is named *not in this commit* and does not refuse; a
  suite the tip does not declare is not run. `docs/technical/mc-deploy.md` also
  states the rule that a suite that only measures time is never a gate.
