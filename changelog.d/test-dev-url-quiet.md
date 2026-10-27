section: Fixed

- **`mc test dev --url` prints the URL alone on stdout.** The lines a person
  waits through — the static tier, a wait for a slot, the start — went to
  stdout too, so `URL=$(mc test dev --here --url)` captured them whenever a
  slot was held, and memoro's theme matrix navigated to that text
  (2026-10-27). With `--url` they now go to stderr; without it nothing changes.
