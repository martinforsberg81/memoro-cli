section: Added

- **Antigravity CLI (`agy`) runs unattended sessions.** Build, review, plan
  review, finish, mend, plan, manager, intake and decision sessions can run on
  agy, its output, errors and cost read from its stream-json, its plan quota
  read from `/usage`. The default review list is now agy's Gemini 4 Argon,
  then claude, then codex, and review takes its first candidate whenever it
  can run. Every unattended caller now records a plan refusal it reads, and the
  helper turn is not ok when its session failed. Interactive `mc plan`,
  `mc martin` and the rest refuse agy with exit 2.
