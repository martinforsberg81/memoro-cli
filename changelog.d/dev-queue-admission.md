section: Changed

- **A wait for a dev server is served in order.** `mc shot dev`, `mc test dev`
  and `mc dev admit --wait` take a ticket in `~/.memoro/mc/dev-queue.json`, and
  only the ticket at the head is admitted when a slot is free — first come,
  first served, except that a gate round that has waited two minutes goes ahead
  of the rest (never ahead of an earlier gate round, and never by stopping a
  server). Until now whoever looked first after a holder left won, so a later
  request could overtake one that had waited fifteen minutes. The waiting line
  names the place (`place 2 of 3`) and when mc last used each holder;
  `mc dev admit --json` adds `place` and `queue` to a refusal. A waiter that
  dies is swept from the queue, and a restart of a worktree's own server is
  not queued.
- **`mc dev status`** shows the app servers, the queue in order, the cap and
  free memory.
