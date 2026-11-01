section: Fixed

- **A goal can finish.** Four faults the first real goals found on the way from
  a measured build to a pull request. A criterion the runner measured passing
  is now verified evidence by itself, so a session no longer has to find
  `mc goal criterion evidence`, and the role says where a handoff's reference
  comes from. Tests no longer inherit the identity of the session that started
  their gate, which refused every goal that reached the autonomy suites. Finish
  waits for a wide gate past `mc gate`'s 540 seconds, and neither the closing
  window nor a tool wait stops it while the gate runs. A planner's current retry
  diagnosis continues on the uncommitted tree an attempt left, and the same tree
  measured again closes that session.
