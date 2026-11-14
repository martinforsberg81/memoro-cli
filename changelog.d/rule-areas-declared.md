section: Added

- **Repositories declare rule areas, and `mc goal areas` shows them.**
  `.mc/areas.json` on a repository's `main` names its areas — each with an id,
  what it covers, its standards, the paths where it lives and the questions to
  ask of a change. `mc goal areas <repo>` prints a repository's declaration,
  `mc goal areas <programme>/<goal>` the declarations of a goal's repositories
  with the goal's stand for each area, and `--at <rev>` reads another revision.
  `mc goal obligation set` now takes an area written `<repo>/<id>` and refuses
  one the goal's repositories do not declare, naming the ones they do; a goal
  none of whose repositories declare areas takes any word, as before. Nothing
  requires a stand yet and no brief changes. memoro and memoro-cli declare
  their areas.
