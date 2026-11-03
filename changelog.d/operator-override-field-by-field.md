section: Changed

- **The operator's `repo-gates.json` overrides field by field, and
  `DECLARATION SHADOWED` is gone (D-0135).** An entry there used to replace
  the whole declaration, so an override written to change one fact dropped
  every field it did not repeat: `extra_gates` fell out on 2026-08-22 and
  `pr_tests_flags` on 2026-08-24, both in silence. The round then started
  naming the dropped fields. That fixed the silence but left the hole, and by
  now an override would have dropped fourteen fields, among them `select`,
  `suite`, `derived` and `retry_once`. The operator's layer now merges the
  same way the repository's `.mc/test.json` already did: it changes the fields
  it states and keeps the rest, and `null` removes a field on purpose. With
  nothing left to warn about, the `shadowed` list and the round's warning line
  are removed. So is the special case that put the shipped `round_timeout_ms`
  back under a whole-entry override. The ceiling can still be tuned, and an
  override that sets it to `null` stops the round instead of running one
  without a ceiling. `sources` names the file each field came from in all
  three layers, not only `override`. No `~/mc/repo-gates.json` exists on this
  machine today, so no round behaves differently.
