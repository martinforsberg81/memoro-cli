section: Fixed

- **Release runner lanes at merge handoff and show direct merges.** Review
  and finish sessions end after all goal PRs enter the merger's queue. Goals
  retain stage merge with PRs labelled in queue or merging. The merge panel
  shows every waiting PR and excludes the active merge, including direct
  goal merges without a gate round.
