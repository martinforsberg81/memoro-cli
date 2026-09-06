section: Changed

- **The page's QUEUE is NEXT: the order the runner would actually take.** It
  read `~/mc/queue.md` and nothing else, so with that file empty the section
  said *"empty — mc brief queues the next thing"* and the brand row said
  `0 of 0 queued` — while the runner walked 44 projects and had two steps in
  flight (measured 2026-09-06). `queue.md` is Martin's *these first* and it
  empties itself; it was never the queue. NEXT draws `assembleQueue`'s order,
  the runner's own function: the file's names that have a non-legacy plan on
  `origin/main`, then every other such plan alphabetically. The heading says how
  many came from the file, so an empty one reads *the order is alphabetical*.
  It is one block per lane rather than one list, because `mc run` drives one
  lane per repository at the same time and the head of each lane starts now:
  three deep per lane, the rest of that lane a count, and each row the project,
  `step n/m` in the kind's own colour, and the step's own title. `planSummary`
  now carries the step's number, how many there are, and its title as fields, so
  nothing parses `2/5` back out of the `next` sentence — and `plans.json` entries
  carry the shape they were written in, so a cached record from before those
  fields is a miss rather than half a row. The brand row counts what is true of
  the work: steps in flight, plans ready, plans blocked. `mc --json` renames
  `queue` to `next` and carries the lanes whole.
