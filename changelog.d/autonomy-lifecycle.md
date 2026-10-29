section: Fixed

- **Autonomous goals run end to end: revised, reviewed, landed and archived.**
  A session after plan revised a goal now publishes on the same branch and PR:
  its predecessor's handoff is read against the revision it was built for. The
  runner hands the review, routing and merge doors a `gh` of the shape they
  call. `mc plan <programme> --archive` takes a programme with autonomous goals
  only once plan has confirmed every goal and the programme has stopped or never
  started; until then its records stay. Lifecycle and coexistence tests run the
  acceptance scenarios on real temporary repositories beside a v1 project.
