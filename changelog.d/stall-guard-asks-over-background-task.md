section: Fixed

- **A step waiting on a background task is asked, not killed.** Since the
  stall guard shipped (2026-09-12) one step session in five ended
  `stalled,failed` — 53 of 289, against 0 of 180 before it. The sessions were
  not hung: a command longer than Bash's ten minutes (memoro's G6 comparison,
  a full `npm test`) ran in the background, the session ended its turn
  "Waiting for background task …", and wrote nothing until the task finished.
  Twenty minutes of that was a kill. `streamSession` now follows claude's
  `background_tasks_changed` events: when the guard fires with a task alive it
  writes the session `quietPrompt` — the silence and each task — and re-arms;
  a session that answers goes on, one that does not is killed at the next
  stall. A second bug sat under it: the `result` line was looked for in the
  first 200 characters, and claude writes its `type` some 2 000 in, so no
  result was ever seen — stdin was never closed by one and the two-minute
  result grace never ran; a finished session sat until the guard killed it.
  The whole line is searched now, and a result that arrives while a
  background task runs leaves stdin open, since claude resumes by itself when
  the task finishes.
