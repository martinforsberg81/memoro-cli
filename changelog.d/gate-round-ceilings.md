section: Fixed

- **Bound gate rounds by repository.** A stuck suite used to hold a merge lane indefinitely; rounds now stop red at the declared hard ceiling, name the selected/slowest test files, and release the lane for the next job. The page also treats a live merger PID stored on a queued job as live when `merger.json` is missing.
