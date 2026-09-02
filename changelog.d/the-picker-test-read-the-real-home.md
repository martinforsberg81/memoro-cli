section: Fixed

- **`mc plan`'s picker test read the user's real `~/mc/plan/`.** It passed
  `{ MC_HOME: '/nowhere' }`, which reads as isolation and is not:
  `programmeRows` asks `openPlanAreas`, which resolves `MC_WORK_ROOT` and falls
  back to `homedir()/mc` when the object it was handed carries none. The
  assertion held only while that directory was empty, so it went red the first
  time somebody ran `mc plan` on the machine — on a change that had nothing to
  do with it. `tests/_isolate-home.mjs` cannot catch this class: it points
  `process.env` at a throwaway directory, and a caller passing its own env
  object never looks there. The literal now carries `MC_WORK_ROOT` and a
  temporary directory of its own.
