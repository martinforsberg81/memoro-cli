section: Changed

- **A goal is GOAL.json, with criteria as data.** `GOAL.md` is replaced by
  `GOAL.json` — status, repositories, class, after, pull requests, title, goal,
  contract, out of scope, success criteria (`criterion`, `check`, `met`) and
  documents — validated by the same functions as PLAN.json's criteria and
  documents. It is written only by verbs: `mc goal set`, `mc goal document
  add`, `mc goal criterion add|met|unmet`; an invalid write is refused.
- **Done means the criteria hold.** A session other than plan cannot set a
  goal `review` while a criterion is unmet (named by number), the runner
  starts no session on a goal with no criterion, and the merger answers red
  on a goal's pull request while one is unmet.
- **Seen.** `mc goal show` renders each criterion with ✓/✗ and its check, and
  that rendering is the brief of a goal's build, review and plan session;
  `mc goal list` and the page's goal rows say `criteria <met>/<all>`.
- **`mc goal convert [<programme>]`** turns the GOAL.md files outside
  `goals/.archive/` into GOAL.json.
- LOG.md entries are written `Done:`, `Comment:` and `Next:`; logs with the
  Swedish labels still read.
