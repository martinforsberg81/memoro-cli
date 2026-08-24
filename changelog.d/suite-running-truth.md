section: Fixed

- **"Running under the suite right" is measured, and counts the runner, not
  the shell.** Two faults in one row. A gate round refused on the suite
  right told the holder "nothing running under it" as a *default* — the
  refusal never asked — while the holder's full suite was five minutes in;
  PM judged two sessions on that row (2026-08-23). And a `zsh -c` wrapper,
  whose command line carries the `node --test` it started, counted as a
  second suite and stayed on the board after node had exited. Now the gate
  measures `suiteRuns()` before it tells the holder, and `isSuiteCommand`
  excludes shell wrappers (`zsh|bash|sh … -c`).
