### Fixed
- The check after a deploy reads which suites gate from origin/main's tip, as
  `mc deploy` does (#1563), and no longer reads them from the deployed commit.
