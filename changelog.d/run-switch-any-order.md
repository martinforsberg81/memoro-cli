section: Changed

- **`mc run start`, `stop` and `--update` work in any order, and from the
  page.** The shell history of 2026-10-10 held `stop`, `start` (refused),
  `--update` (refused), `start` (refused), `stop --force`: sessions killed
  mid-step only to get a runner going again, because a polite stop could not
  be undone and every refusal pointed at a verb that was refused too. Now
  every verb starts from where the runner stands — running, stopping,
  draining, finishing — and `start` on a stopping runner **takes over**: a
  new runner on every lane at once, the old one finishing only the steps it
  holds. `--update` on a stopping runner does the same after the
  fast-forward, with the old runner's flags. The old runner stands down the
  moment `runner.json` names another live pid, and no longer removes a
  `runner.json` that is not its own. A runner older than this is waited for
  rather than taken over, and the answer says so.
- **A stop says how it stands.** `mc run stop` and the page's RUNNER section
  print `stopping since 08:47 (39 min) — waiting on video-window step 1
  (memoro#6, 80 min); 11 lanes done`, the way a drain already did. A second
  stop keeps the first one's time. The log no longer writes `runner exit on
  STOP` once per lane while the runner goes on for an hour: a lane says it
  leaves and what the runner still finishes, and the exit line is written
  once, when the process ends. "the round it is in" is gone from the
  answers — there have been no rounds since 2026-09-08.
- **Orders are seen within thirty seconds.** An idle lane's ten-minute sleep,
  and the chore loop's, is taken in 30 s slices with STOP and UPDATE read
  between them.
- **No second runner in the gap.** `mc run start` writes `runner.json` for the
  child the moment its pid exists, and a handover writes it for the successor
  with the new commit, so a second `start` — or a second `--update` — in the
  second the new process takes to load sees it. A foreground `mc run` removes
  a leftover STOP as `start` does instead of refusing on it.
- **`start`, `stop [--force]`, `update [--force]` at the `mc` prompt.** The
  answer is printed under the page and the page is drawn again. A bare `stop`
  is the runner's; `stop <name>` is still the workarea's. `mc run update` is
  `mc run --update` from the shell too.
