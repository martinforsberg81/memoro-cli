section: Changed

- **The wake notice names the inbox by path, not by the word (D-0163).**
  `mc: new in inbox/ from pm - read it now` was unambiguous for every session
  until one came up with Gmail attached: it read "inbox" as e-mail, asked for
  `/mcp`, and sat for twenty minutes on the morning's most important order
  while the file lay unread in `inbox/`. No mechanism could catch it — the
  delivery reported true and the session answered sensibly; reading the
  wrong inbox looks exactly like reading the right one. The typed notice now
  carries the path `mc work send` already prints on delivery
  (`mc: new in ~/mc/pm/inbox/ from alpha - read it now`), home shortened to
  `~` so it fits a pane and stays ASCII for the box comparisons. A queued
  wake keeps the path with the entry; an entry queued before this reads it
  from the area. With no area known the old `inbox/` stands.
