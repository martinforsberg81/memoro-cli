section: Changed

- **A plan is done only when its success criteria are met.** A plan whose
  steps are all done but has a criterion not `met: true` is now `unmet`, with
  the criteria's numbers: the page and `mc status` show it, the runner says it
  once, and nothing archives it, closes its workarea or releases a step
  waiting on it. memoro's `photo-analysis` was archived on 2026-10-11 with
  three criteria unmet, because done was read off the steps alone.
- **The plan's last step does not land with a criterion unmet.** `mc merge`,
  `mc merge --docs` and the runner's own queueing refuse its pull request with
  `unmet-criteria` while the plan in it leaves a criterion `met: false`; the
  session measures, or fails the step naming what it could not measure.
