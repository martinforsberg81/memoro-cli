section: Added

- **`mc docker`: the container runtime the gates need, with a lease per holder.** `ensure` starts a stopped OrbStack and waits for `docker info`; `prune` removes only what mc labelled whose holder is gone. On 2026-10-18 the Postgres reference gate exited 69 twice against a stopped OrbStack nobody owned.
