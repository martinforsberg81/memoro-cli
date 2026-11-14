section: Fixed

- **Desk item writes exclude each other, and a decision can close an item the
  sync closed first.** The sync read every item before writing and nothing
  held a lock, so a close by the deciding session could be overwritten by a
  sync that read the item earlier, and a sync that closed an item by source
  made the later `close --by decision|martin|default` fail with "closed". Now
  every write of an item and of the store marker is a read-modify-write under
  the strict runner lock, the sync runs in one hold, and a lock that cannot be
  had writes nothing and ends the verb, `mc martin items` and the opening with
  exit 1. An item the source closed after it was prepared or briefed takes the
  close, which keeps the source outcome as `outcome.replaced`.
