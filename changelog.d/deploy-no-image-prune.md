section: Changed

- **`mc deploy` no longer prunes Docker images after a deploy.** It asks Docker
  nothing, so a deploy never starts OrbStack for it. Memoro's
  `scripts/container-image.mjs --build` prunes on the machine that builds.
