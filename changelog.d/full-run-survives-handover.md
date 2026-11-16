section: Fixed

- **A runner update no longer ends a full run the runner is measuring.** Every
  update ended the suite in flight (1355–2133 s of measurement) and wrote it
  `stopped at gone`, so a full run on a repository that moves often could
  never finish. The runner that hands over now finishes the run like a
  session, takes nothing new, and exits when it has ended; the next runner
  follows its claim and starts no second run. A run that only waits for another
  or follows it is dropped at once. STOP still ends everything. The handover
  line, the ten-minute drain line and the page name the full run (repository,
  commit, since when) instead of saying the runner finishes 0 sessions.
