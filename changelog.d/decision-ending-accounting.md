section: Fixed

- **A provider interruption no longer counts against a decision item.** A
  decision session that ended on a usage limit, a lost login or an unreachable
  API was counted as a failed ending, so two such endings sent the item to
  Martin as a mechanical "could not settle" brief, and a due product brief was
  overwritten, for an outage nothing about the item caused. Those endings now
  write nothing to the item or its goal and spend no attempt; the item is taken
  again when the provider answers. A login ending counts as before unless the
  refusal of the provider named it, and a server error counts as before. The
  limit is also two failures in the item's current state: a failure while
  prepared no longer spends the one attempt of a brief that later falls due.
