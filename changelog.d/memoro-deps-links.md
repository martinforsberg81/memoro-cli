section: Changed

- **Dependencies are attached again before each step and each `mc plan`.** A workarea is reused step after step, and `origin/main` is merged into it before each one, so a lockfile that moved on main left the attachment made when the workarea was created out of date. The runner now re-attaches a fresh step's checkout after that merge — not a resumed session, and not a merge with conflicts, which runs `npm run deps:ensure` itself — and `mc plan` re-attaches a planning checkout that already stands. A failure is said in the log and never blocks a step or a plan.
