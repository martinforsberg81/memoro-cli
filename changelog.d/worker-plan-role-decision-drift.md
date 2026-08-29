section: Changed

- **The worker and plan roles no longer say the runner deletes an answered
  decision file.** The same drift already corrected in the brief role: `mc run`
  reads no decision file and runs `ready` plans and nothing else, and
  `retireDecisions` runs from `mc brief --collect` once no plan waits on the
  file. Both overlays now say what actually moves a project back in front of
  the runner — the next session writing the answer into `PLAN.md` and setting
  `status: ready`.
