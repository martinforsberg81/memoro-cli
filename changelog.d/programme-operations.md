section: Added

- **Programme status, start, pause and resume.** `mc programme status` shows an
  autonomous programme's mode, activation, planned stop, plan ownership, waits,
  in-flight work and next automatic action, and per goal its builder criteria,
  evidence quality, review findings, actual models, session, gate and
  publication; unknown readings stay unknown. `start` records a deliberate
  activation only with an approved revision, a planned stop, valid build/review
  profiles and every control capability, which no installation reports yet.
  `pause` holds new starts and merge submissions while started work finishes;
  `resume` restores what it held. The page gains an AUTONOMY block only when such
  a programme exists; v1 projects are unchanged.
