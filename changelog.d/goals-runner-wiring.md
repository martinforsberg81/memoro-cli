section: Added

- **`mc run` carries the production autonomous capability.** A sent goal builds,
  is reviewed and lands through the runner, with autonomy off and with no
  capability support: there is no force path. The capability fails closed: an
  awake clock that cannot be read or an invalid control profile means goals are
  skipped. The checkpoint verifier measures progress per run, and main conflicts
  are resolved by one supervised, resolve-only session on the build's launch
  path. Fixed-step projects are unchanged.
- **Capability support comes from observed provider runs.** `mc programme
  capabilities` reads `runner/provider-observations.json`, bound to each tool's
  version, so a new version has no support until observed again. That refuses
  `autonomy on` only.
