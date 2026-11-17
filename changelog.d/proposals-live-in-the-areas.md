section: Changed

- **Proposals live in the areas, not in programmes.** A programme is an order:
  temporary, archived when done (Martin, 2026-11-17). So a proposal now waits in
  the area page it concerns, `~/mc/areas/<repo>/<area>/proposals/` (an area is a
  page a repository declares in `.mc/areas.json`, keyed `memoro-cli/system`,
  `memoro/trust`, …), and a decided one in its `archive/` under an `Utfall:`
  line. There is no ownerless place: a finding with no clear area goes to
  `memoro-cli/system` when mc would change and `memoro/delivery` when memoro
  would change. The intake turn, the desk's Where a new thing goes, the
  manager's curation prompt, the review's required proposal, the deploy mend,
  `mc proposals` (counts by area), the page's Proposals row and pipeline, tidy
  and the gate's red-on-main note all read or name the areas; `~/mc/proposals/`
  and a programme's `proposals/` are read by nothing. `mc programs create` makes
  no `proposals/`, `--from-proposal` takes a file in an area's `proposals/` and
  archives it there as `Utfall: ordered in programme <name>`, and the runner's
  archive moves a legacy programme's waiting proposals to the area its record
  names, else `memoro-cli/system`.
