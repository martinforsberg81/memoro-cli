section: Added

- **`mc programme capabilities` says what an installation can run, and the
  rollout is documented.** The report names, for each control capability, what
  is built, which tests prove it and what is still missing, and for Codex and
  Claude the prompt path, live control and context source actually measured.
  The installed runner passes no autonomous capability and has no suspend-aware
  clock, so it supports none and `mc programme start` still refuses; no
  programme is activated. A smoke test drives the documented
  status/start/pause/resume commands as real processes against a disposable
  programme with fake tool binaries. The v1/v2 boundaries, closure budgets,
  unknown context, non-green recovery and the agreement → start → plan chain of
  authority are written down; role overlays say start, pause and resume are the
  operator's.
