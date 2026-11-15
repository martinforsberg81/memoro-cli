section: Fixed

- **The check after a deploy reads which suites gate from main's tip**, as
  `mc deploy` does (#1563), and no longer from the deployed commit.
