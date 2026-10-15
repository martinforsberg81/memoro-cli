section: Changed

- **`mc shot` reads its dev accounts and onboarding states from memoro's
  `.mc/shot.json` `accounts` table.** `--account <name>` is one the table
  declares (seeded by default), `--onboarding` asks for its `fresh` state, and a
  target may declare `"onboarding": "fresh"` itself. Before, mc knew `seeded` and
  `new` and built `reseed=1`/`ready=1` itself; without a table (an older memoro)
  it still does. `--scroll @end` and `--scroll @top` with no selector scroll the
  surface's declared scroller, which memoro resolves.
