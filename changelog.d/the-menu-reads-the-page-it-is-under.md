section: Fixed

- **Bare `mc` at a terminal threw at the prompt.** #530 renamed the page's
  `projects` section to `programmes` and regrouped it; the menu underneath kept
  reading `data.projects.repos` and died with a `TypeError` the moment somebody
  pressed return. Every test was green, because the only one that drove the
  menu did so against a `DATA` object written out by hand — written to match
  the menu, so it went on agreeing with it after the page stopped. That fixture
  is now built by `programmesSection` itself: rename a key and the test fails
  on the next run, which is the whole reason to have it.
