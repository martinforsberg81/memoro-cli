section: Fixed

- **A spent workspace API limit hands the step to the plan, not a sleep.**
  2026-10-17 every credits session died in three seconds on `API Error: 400
  You have reached your specified workspace API usage limits. You will regain
  access on 2026-11-01 at 00:00 UTC.` `apiInterruption` read it as a quota,
  because its `usage limit` matches the quota test, so the step credit was
  never marked unusable: the lane slept thirty minutes, five times, and the
  step failed. It is a credit refusal now. The credit is unusable until the
  date the refusal names, and the step goes to the plan at once.
