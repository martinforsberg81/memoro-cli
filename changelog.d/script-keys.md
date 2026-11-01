section: Added

- **`mc keys run` releases declared vault keys only to main-matching scripts.**
  A committed manifest fixes key names and the Node source closure; envelope
  custody, inherited-environment scrubbing, streaming output redaction and
  value-free run records keep accidental exposure out of sessions. `mc keys
  list` reports names and custody status without exporting values. This is
  not an isolation boundary against another process running as the same OS user.
