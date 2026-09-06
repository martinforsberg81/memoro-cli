section: Added

- **`mc test dev` says what the repository declares does not work in dev.**
  `.mc/test.json` may list `environments.dev.not_in_dev` — `{ name, why }`
  each — and a dev round prints them once, before the verdicts, so a red that
  lands on one of them is read as the laptop's and not the app's. `mc test dev`
  is not production and is not asked to be; it is asked to say where it
  differs. `--json` carries the list as `not_in_dev`.
