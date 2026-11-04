section: Fixed

Goals sent to `merge` by review or plan now merge all registered PRs directly
and become done after the final landing. Missing jobs recover after restart;
content conflicts go to a session. The stage was renamed from `merging` to
`merge`, with existing records still readable.
