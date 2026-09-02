section: Changed

- **A round of `mc run` asks GitHub what is open before it acts.** The
  runner looked in two places — `origin/main` for the queue and the worktree
  for the plan — and asked about pull requests only *after* the session, so a
  step whose work was already sitting in an open pull request still read
  `ready` everywhere the runner looked. On 2026-09-02T04:33 that started a
  120-minute Opus session to rebuild `action-window` step 4 while step 4's
  work was open as #11241. Now `queue()` asks each repository once, beside
  the fetch it already pays for, and an open pull request on a project ends
  that project's round with a line naming it: `action-window: #11246 is open
  (…) — not starting a step`. The one rule also covers the two cases nothing
  else did — a session that timed out with commits pushed and no pull
  request, and a step that ended `plan-trespass` — because both leave a
  branch carrying unlanded work. A draft counts as open, and a repository
  GitHub could not be asked starts nothing that round rather than starting
  blind.
- **A workarea standing on a branch that has already landed is moved before
  a session starts.** `action-window` stood on `action-window`, merged as
  #11177 and deleted on the remote; had its 04:33 session finished, the
  push-guard (D-0164) would have refused the push after ninety minutes of
  work — the guard asks the right question at the wrong end. The round now
  asks it first, of content rather than of commit counts (the runner
  squash-merges), and checks the workarea out on `<name>-<n>` from
  `origin/main`. Measured the same day: 44 of the workareas under `~/mc`
  stood on a landed branch. A branch that has *not* landed is left exactly
  where it is.
- **The board says which pull request a stopped project is waiting on.**
  `mc status` matched `headRefName === <name>`, so `action-window` showed an
  empty PR column while three of its branches had one open, and `mc status
  <name>` asked `gh pr list --head <name>` and printed "none on this
  branch". Both now read a project's whole family of branches — `<name>` and
  `<name>-<suffix>`, longest name wins, so `mc-cut-2` is `mc-cut`'s and not
  `mc`'s (project-prs.js).
