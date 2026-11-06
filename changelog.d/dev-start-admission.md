section: Fixed

- **A dev-server restart keeps its slot.** A stale or hung server of this
  worktree is replaced only after its replacement is admitted: admission counts
  its slot as the caller's, so a restart never queues behind another worktree.
  A refused admission leaves the old server running.
- **A dead dev-server start fails at the poll that sees it.** A wrapper that
  exits before it registers is reported at once, with the end of the newest log
  under `.wrangler/dev-server/logs/`, instead of after the whole register window.
- **An admission whose wrapper has gone gives up.** `mc dev admit` for a
  `MC_DEV_OWNER_PID` that is no longer alive returns `owner-gone` on its next
  poll and reserves nothing.
- **`--json` keeps progress off the answer stream only.** Callers that send
  progress to stderr (`mc shot next`) see the slot wait and the slow-start lines
  again.
- **`mc test dev --here --url` starts no static tier.** It prints the app URL
  and holds nothing else.
