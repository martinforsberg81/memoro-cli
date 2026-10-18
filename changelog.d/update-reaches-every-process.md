section: Changed

- The runner writes `runner/UPDATE` itself when origin/main of mc's checkout has moved past its commit and the checkout is clean and fast-forwards; the merger and the repo watcher leave between units of work when the checkout moves and start their successors, so landing a pull request is enough.
- `mc run --update` prints one line per long-lived process — the merger and the repo watcher, their pid, commit and when they move.
- The page's MC line names any process whose commit differs from the checkout's.
