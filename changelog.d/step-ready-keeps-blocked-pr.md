section: Fixed

- **`mc step ready` on a blocked step keeps its open pull request.** A step
  parked on a question with its session's work in an open pull request could
  not be set ready: mc refused with "open and changes files — land or close it
  first", and closing it meant starting the step again from main. Nobody was
  working on that pull request; note-window step 5 sat behind its own #13931
  on 2026-10-20. Now the one open pull request that changes files is written
  on the step with the answer (`answered: { name, answer, at }` in the
  register), the runner goes back to its branch as for a step the merger sent
  back, and the session is told the decision, the answer and that it goes on
  from that pull request. A failed step, or a blocked one with two such pull
  requests, is still refused. The answer is cleared once the step lands, fails,
  is done or is blocked again.
