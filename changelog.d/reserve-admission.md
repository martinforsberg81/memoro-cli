section: Fixed

- **Keep unstarted work eligible when an API reserve refuses admission.** A
  locked key or a switch changed before launch leaves the work and its retry
  budget in place. The runner can use another eligible route while the
  unavailable reserve waits.
