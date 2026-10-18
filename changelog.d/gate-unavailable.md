section: Fixed

- `mc merge`: a command gate the selector declares `allowUnavailable`, exiting with its `unavailableExitCode` (memoro's `sql:reference:postgres` without Docker, exit 69), is reported unavailable and no longer turns the round red.
