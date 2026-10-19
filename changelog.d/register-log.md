section: Added

- **Every register write leaves a line saying which process made it.** The
  register keeps no history, and on 2026-10-12 a hand-typed
  `mc step ready log-page 1` moved a landed step back to `ready`; the runner
  ran it twice, and the only record of who did it was `mc.log`, which keeps no
  parent process and rotates. Now `updateStep` and `overlayPlans` append one
  JSON line per write to `~/mc/runner/log/register.log` — the step, its status
  before and after, and the writer's pid, parent process, run id, argument
  shape, directory and `MC_STEP`. The file rotates at 4 MB and `mc tidy` keeps
  it, so the next move like that is answerable. A log that cannot be written
  never fails the write.
