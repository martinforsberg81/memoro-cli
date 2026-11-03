section: Changed

- **mc admits four app servers at once instead of two, and stops a holder it
  has not used for five minutes instead of thirty.** From 31 Oct to 3 Nov 72
  starts of `mc shot dev`/`mc test dev` waited for a slot (median ~200 s) and
  26 were refused after fifteen minutes; every refusal was the cap, never
  memory (36–41 % free). The free-memory floor (`MC_DEV_MIN_FREE_PERCENT`, 15)
  still refuses a start on a machine that is short.
