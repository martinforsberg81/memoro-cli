section: Added

- **Gate evidence completion and recovery regressions.** Detached-worker tests
  cover repeated waits, lane waiting, command exit, interruption and child/resource
  release; persistence fault tests cover both sides of receipt creation and a
  failed reuse-cache update. Concurrent callers cannot launch a second worker,
  limited coverage remains limited, and autonomous receipt lookup grants no new
  publication or merge authority.
