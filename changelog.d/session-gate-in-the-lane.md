section: Changed

- **A session's `mc gate` runs the tests its change reaches, in the gate lane,
  and `mc publish` queues the pull request** (ruling 52). Step sessions spent
  their last dozen turns on a whole memoro gate — 10–11k tests, often past the
  600 s tool limit and polled with `mc gate --wait` — then `mc publish`, then
  `mc merge`, and every one of those gates ran beside the others and beside the
  merge round, outside the heavy/light lanes. The merger reused one in about
  one round in eight and measured the rest again. Now `mc gate` runs named test
  files only (at most 30; bare, the test files the branch changed), refuses
  `--full`, and its shell takes the repository's lane lock before the tests and
  waits while a merge round, a deploy, an iOS build or another session holds
  it. `mc publish` runs `mc merge <repo> <pr>` itself (`--no-merge` to not), and
  a queued step is told to end the session in that turn. The pre-tool hook
  turns `npm test` and `node --test` to `mc gate <files…>`, and the step,
  mend and shared role texts and the runner's prompts say all of this.
