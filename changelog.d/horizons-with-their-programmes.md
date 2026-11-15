section: Changed

- **The page shows horizons with their programmes.** The default `mc` page draws HORIZONS in place of the per-programme blocks: the open horizons in the desk's order, one row for each programme under way beneath the horizon it serves, `Serving no horizon`, and one folded row for the rest. A programme opens alone by typing its number or its exact name, and `h` returns to the overview; `a` still unfolds everything as before. `mc --json` gains `horizons`, and a `number`, `horizon` and `horizon_state` on each programme, and loses nothing.
