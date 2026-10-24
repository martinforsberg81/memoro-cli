section: Added

- **`mc shot` runs JavaScript, uploads, presses keys, waits longer, and says
  every error in the same call.** `--eval <js>` / `--eval-file <path>`,
  `--upload <css>=<file>` and `--press <key>` join the acting flags in argv
  order; `--timeout <s>` (1–120) bounds each wait and action instead of the
  fixed 10 s. After the path come `error  <kind>  <text>` lines for every page,
  console, request, server and dialog error, `eval <n>` lines with each value,
  and a `failed  step <n> …` line when a step failed (pictured as the page
  stood, exit 1). Before, a session left `mc shot` for a browser tool whenever
  it needed any of these, and paid one model turn per action (measured
  2026-10-24, docs/technical/mc-shot.md § What comes back).
