section: Changed

- **The page lists projects, not workareas.** `WORK` was one row per folder
  under `~/mc`; `PROJECTS` is one row per `PLAN.json` on `origin/main`, grouped
  by repository and sorted repo, then programme, then project. Measured
  2026-08-30 the old section drew 81 rows, of which 24 had a plan and 57 did
  not — so the longest part of the page was mostly work nobody was doing, the
  27 real projects were scattered through it, and two were missing altogether
  because no folder happened to exist for them. A project is what the work is:
  it lives in the plan, it is what the runner steps and what `mc status` opens,
  and it exists whether or not a folder does.
  Each row carries where the plan stands, **how many of its steps are done**,
  `next`, the open PR and a live mark; the steps come off the plan the cache
  already holds, so the count is free. The workareas no project explains keep a
  heading of their own underneath — the first twelve by name, the rest as a
  count pointing at `~/mc/intake/unplanned-workareas.md`, because nothing
  removes them and fifty-seven rows would be the page again. The menu's numbers
  run through both lists as before, and a project with no workarea is a row
  like any other: opening it by number is what creates the folder.
  The row's columns are sized to the terminal rather than to fixed widths — a
  first draft spent 41 columns on the name and 17 on the status, which is wider
  than the page's own 60-column floor.
