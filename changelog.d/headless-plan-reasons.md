section: Changed

- Headless planning uses MC_ROLE=plan with finish, blocked and next_step reasons.
  Blocked goals receive planning recovery and can retry the same stage; Martin
  marks goals waiting for a person. Completed programmes receive one next-step
  decision, persisted across runner restarts and archiving. Other programme
  wakeups remain mc manager's responsibility.
