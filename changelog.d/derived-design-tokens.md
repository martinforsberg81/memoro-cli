section: Changed

- **A memoro merge regenerates the design tokens.** `tokens:build` (the
  token stylesheets and the two theme files) and `tokens:docs`
  (`docs/technical/design-tokens.md`) join memoro's `derived` commands: both
  write from `sdk/tokens/*.json` alone and are clean on main, and steps were
  regenerating them by hand. The SDK corpus results and the card HTML
  digests stay out: memoro re-records those only as a decision that the
  output moved.
