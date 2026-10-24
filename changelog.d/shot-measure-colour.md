section: Added

- **`mc shot --measure` reports each match's colours.** `background_color` and
  `color` are the computed values, as CSS reports them, so a layout's colour
  can be measured as well as its box. `--compare` sets them against the other
  tree's only when both trees report them: a ref built before the capture
  script reports colours shows no colour differences, not one for every element.
