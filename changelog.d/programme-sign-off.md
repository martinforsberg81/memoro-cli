section: Changed

- **Programme record signatures and complete document templates.** New records
  start as drafts except area repairs. Existing version 1 records read as legacy
  without disk changes; actual writes upgrade them. Phase, archive-state and
  sign/return/drop record writers retain concurrent fields under the strict
  runner lock. Signing captures the working page and nested design hashes in a
  separate signed copy. New programme pages use the complete document template
  and structural checks; repairs retain their short page. Horizon show names
  the desk-authored basis.

- **Independent programme readings.** `mc programs review` shares goal plan
  review's reader launch and token checks, with a separate document binding,
  30-minute limit and no cap. Interactive Martin's `mc programs sign` requires
  structure and a current reading, with an explicit logged reason for NOT OK.
  Goal review retains its two-reading/20-minute policy and now also reads goals
  against their signed programme part. No sign-off desk item is created.
- **Programme return, drop and model commands.** Interactive Martin can return
  an open programme to draft or shelve a declined draft whole; a programme
  planner can return only its own programme, never from a goal session.
  Reasons and signed copies are retained without releasing holds or deleting
  unpublished or restricted material. The latest live/archive signature is
  the next document's model; show/list expose signatures, legacy state and
  design drift. Goal creation refuses draft/dropped programmes and headless
  recordless callers before any fetch or write.

- **Draft programmes wait visibly for sign-off.** Draft records prevent new
  plan/build/review/mend sessions, including a return during admission, without
  cancelling running sessions or holding queued merges. Drafts with no goals
  appear under their horizon; the existing status position reads draft or waits
  for sign-off when an item already exists. JSON carries the record state.
  Signed copies, reading metadata and return reasons have the programme-file
  guard, with the existing file-tool and Bash escape rules unchanged.

- **A signed programme is cut once per signature.** The programme planning turn
  is due while a signed, open, non-legacy programme's `cut_text` is not its
  `signed_text`, even when goals exist, and cuts the programme from SIGNED.md
  alone. A goal names its part with `Part <n>` in the label of a document whose
  path is the programme's SIGNED.md. On completion the runner reads the record
  again under the lock and writes `cut_text` only when every signed part is
  named by a goal and the signature is unchanged; a return to draft is a
  success, a newer signature or a settled record counts no failure, and the
  desk item closes when the signature is cut.
