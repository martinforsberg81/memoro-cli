section: Fixed

- **`mc test dev` survives its server leaving once.** A tier whose server left
  mid-round used to report every later suite as never run and exit 1, though a
  fresh server is up in under a minute. The first time a tier is found gone in
  a round, mc now starts it again and carries on against the new url —
  `mc: the <tier> server left mid-round — started a fresh one, <url>; carrying
  on` — and logs `dev-server-revived`. The suite that was running still reads
  unmeasured; the JSON report gains `revived_tiers`. A second loss in the same
  round, or a start that fails, ends the tier as before.
