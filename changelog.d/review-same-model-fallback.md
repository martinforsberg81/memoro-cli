section: Changed

- **A review takes another model first, and the build model rather than
  waiting.** Review is an ordered list of candidates: it takes the first that
  can run on its plan now and is not the model the goal was built on, and that
  model only when no other can. A goal whose every review candidate is its
  build model is reviewed on it instead of waiting for `mc model add review`,
  and one whose other candidates' plans are spent is reviewed on the build
  model's plan before any API reserve. Six goals built on opus waited in review
  while the only other candidate, codex sol, was at 100 % with its API off.
