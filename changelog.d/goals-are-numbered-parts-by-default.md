section: Changed

- **`mc goal new` writes a goal in numbered parts unless it is given
  `--structure 1`.** Version 2 was only made on request; it is now what `new`
  writes, and version 1 is what `--structure 1` and the converters write. Every
  version 1 goal is read, written and shown as before. The learning role may
  now use `item add|set|remove` and `obligation set|remove` on a goal it
  created in its session, and `mc goal show` and the logs spell an item's
  fields as the flags do (`upheld-by`, `settled-by`). The canon teaches the
  parts: a new `writing-a-goal` page, the goal-design reference and the roles.
