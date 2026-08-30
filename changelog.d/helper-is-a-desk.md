section: Changed

- **`mc helper` is the desk you walk up to; `mc helper --intake` is the eye
  on production.** The bare verb used to collect the day's digest and then
  run a headless turn over it — 80 seconds of terminal for something the
  runner already does once a day. It now opens a fresh foreground session in
  `~/mc/helper/`, its own room beside `~/mc/brief/`, wearing a new `helper`
  role on Sonnet whose whole job is to take Martin's report of a bug or
  something that should be better and write it into
  `~/mc/intake/proposals/<date>-<slug>.md` — the same shape `mc brief
  --collect` already parses. It reads no digest, lists or edits no proposal
  that is already waiting, and fixes nothing itself: the report becomes a
  proposal, and the work happens later through `mc brief` or `mc plan`.

  Everything the bare verb used to do is `mc helper --intake`, unchanged,
  with `--collect` still stopping after the file and `--since`/`--limit`/
  `--threshold` still its flags — on the bare verb they are now refused by
  name rather than ignored. `mc run`'s daily helper is untouched; it calls
  the modules, not the verb. The headless turn's role moved to
  `canon/roles/intake.md` under the name `intake`, because one name for two
  different jobs is how a role file ends up trying to be both.
