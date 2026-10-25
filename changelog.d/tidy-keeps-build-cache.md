section: Fixed

- **`mc tidy` no longer prunes Docker's build cache.** It ran `docker builder
  prune --all --filter until=72h` from 2026-10-19, and with the cache gone
  every deploy rebuilt the avatar-motion image from nothing: its 1.45 GB of
  torch, pip and LivePortrait layers came out with new digests each build, so
  every push to registry.cloudflare.com re-uploaded them for most of an hour
  and then timed out on a layer commit, before wrangler reached the Worker's
  triggers. Images unused for three days are still pruned.
