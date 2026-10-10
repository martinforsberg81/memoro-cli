section: Changed

- **A deploy waits for the gate round in flight, then builds alone** (ruling
  32). The deployer lets the round already running finish and says so in
  `deploy.log`; the merger starts no round while a deploy's row says
  `running`, and the queue goes on after it. Beside a merge round the bundle
  had swapped for 26 minutes on an 8 GB machine.
- Sessions call `mc merge` once and do not poll it (`_session-work.md`).
