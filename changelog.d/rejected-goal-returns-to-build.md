section: Changed

- **A rejected goal returns to build and is reviewed again narrowly.** A review
  now writes REVIEW.md in a fixed form — a `head:` line per repository, then
  `<id>: OK` or `<id>: NOT OK — <what and where>` for each criterion, preserve
  item, touched obligation, tripped untouched area and the fixed items — and
  `mc goal stage merge|build` checks the lines before it moves. All OK queues the
  merge; a NOT OK line moves the goal from review back to build, where a repair
  build session takes the NOT OK items. The second review is narrow: its prompt
  names the first review's heads and failed items, and the lines it did not
  rejudge are carried as `OK — carried from round <n>`. The third rejection
  stays in review and sets Martin. An untouched area the diff changed is
  listed in the review prompt and needs its own line. The finish role and the
  finish stage as a destination are gone: `mc goal stage finish` is refused,
  and a goal found in `finish · ready` is returned to build by the runner.
  Three build sessions without a word, and a review with no open pull request
  the second time, set Martin instead of moving the stage.
