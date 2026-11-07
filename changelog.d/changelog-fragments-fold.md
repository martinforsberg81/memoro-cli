section: Fixed

- **Changelog fragments all fold.** Sixteen fragments had no `section:` first line, or a body that did not start with a `- ` entry, so `scripts/changelog-fold.js` refused every fold and the Unreleased section could not be built. They are repaired into the README format with their facts unchanged. A test now reads every fragment the fold reads through `readFragment`, so a malformed one is named by the pull request that adds it instead of silently blocking later folds.
