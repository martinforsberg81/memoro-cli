section: Added

- **A rule area can point to its page, and a source area asks no stand.**
  `.mc/areas.json` takes an optional `page` for an area (a repository-relative
  markdown page with its aim, decisions and assets), and an area with an empty
  `questions` and a `page` is a source area: it asks no stand of a goal and is
  never tripped. `mc goal areas` shows each page (`(missing)` when it is not
  in the revision) and a source area as a source. The move out of draft refuses
  a page that is not on origin/main, `mc goal obligation set` refuses a source
  area, the plan review's prompt gives the pages and the source areas, and the
  plan review and the goal review read the page of each area the goal touches.
  A declaration without either form behaves as before.
