section: Changed

- **The manager is a headless pulse, and the interactive manager is gone.**
  The runner now starts the manager itself: a horizon turn creates the next
  programme (or reaches the horizon, or brings a text item to the desk) while
  an open horizon has no open programme, and a curation turn, at most every
  24 hours when origin/main moved, brings the area pages into line and
  publishes with `mc publish`. `mc manager` and `mc brief` without
  `--headless` exit 2 naming `mc martin`; `mc manager --headless --prompt`
  stays. A second failed horizon turn opens a desk item of kind `manager`.
  `mc publish` refuses a manager branch that touches anything outside
  `docs/technical/`, an `## Aim` or `## Decisions` section or a dated
  decision of Martin's. A programme record may name an `area` it repairs
  (`mc programs create --area`, `--purpose`, `--from-proposal`), one open per
  area. The system has a source area page, `docs/technical/areas/system.md`.
