section: Changed

- **A build that is stuck on main's red waits for the repair.** A session without progress is not counted while a main-red repair of one of its goal's repositories is queued, running or published, and the goal is not offered again until that repair has ended. Before, three such sessions set the goal Martin while main's repair was still running (network/landing-surface, 2026-11-15). The build page also says a red that main has too is logged and left, not asked about.
