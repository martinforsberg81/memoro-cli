section: Changed

- **The extra gate names what it compared, says its fallback out loud, and
  keeps a red baseline measurement (D-0138 follow-up).** Measured in the
  first live round against red main (2026-08-24): the attribution held —
  "already red before this PR" — but the line said "exit 1 on the baseline,
  exit 1 on the candidate": exit codes, not names, because node 24 writes
  its spec reporter to a pipe and the TAP comparison silently degraded.
  Track 3 called the risk before the round ran: five red on each side can
  be five different red and report nothing new. Now the gates run in an
  environment that asks node for TAP (as the suite always has); when names
  exist the round says both sides' red by name, "N new, M fixed", and a
  both-sides-red stop says "the same N" only when the sets actually match;
  when names cannot be read it says so — "could not compare by name —
  falling back to exit codes; a new failure over a red baseline would not
  be seen". And the baseline's own gate measurement is saved on its SHA the
  moment it is taken, red included — the A1 entry is only ever written by a
  green merge, so on a red main every round paid the baseline gate again
  (662 s + 531 s ≈ 20 minutes per round, on the very main where the most
  rounds run); now the second round on the same main carries it.
