section: Changed

- **A plan sent from now on builds on its project's one branch, and lands once.** `mc project send` appends a review step, last and always, to every plan — one-step plans included. Its steps build on the project's branch one after the other and are `built`, not landed; the review step measures every success criterion, holds the diff to the goal, the contract and the out of scope, closes what falls short, and lands the one pull request. Its landing makes every built step `done` with the same landed sha. A step before the review is refused at `mc merge` with `before-review`.
- **A plan with a review step does not wait for its own deploy.** `mc step blocked --after-deploy` is refused in such a plan, and a check that needs production is left out of it: the plan lands once, at its review.
- **Plans sent before this change are unchanged.** They run one pull request per step, stacking on a landing step, and the last step measures the criteria, as before.
