section: Added

- **The PM helper is built (design note v0.2, approved 2026-08-17;
  Martin's order 2026-08-24: PM must stop being a middleman).** The role
  home gains the full §2 layout — `intake/` (with `processed/`), `sweeps/`,
  `briefs/` (né `underlag`, renamed before the home ever existed on disk),
  `improve/`, `memoro-mirror/`, `inbox/`, `logs/`. One module knows where
  intake comes from (`pm-helper-intake.js`, §3): non-`.md` is an
  attachment, an `.md` sharing the stem is its description, the same
  quarter hour belongs together; `mc pm-helper intake [--json]` lists
  oldest-first and `intake done <stem…>` MOVES to `processed/<date>/` —
  never deletes, and a stem that names nothing is said, because silence is
  the one forbidden outcome. The improve rhythm hangs on the PM heartbeat
  (§4, no second clock): a round with nothing urgent pulses the helper —
  "take the next project in rotation" — and the rotation itself is the
  helper's, not mc's. And the §5 boundary is the tool's, not the role's
  memory: `mc repo merge` without `--check` is refused outright when the
  pm-helper's area runs it — the helper produces evidence, the PM makes
  decisions.
