# Define the work before creating a goal

An implementation goal commissions a chosen change. Before creating one,
including a skeleton in `draft`, establish all of the following:

- The problem: affected behaviour, trigger, expected result and observed
  failure. Distinguish a user's report, reproduced behaviour and a hypothesis.
  Check existing goals, archived decisions and relevant delivery evidence;
  already commissioned or delivered work does not need another goal.
- The mechanism: inspect the relevant code and available evidence until the
  failure is understood well enough to justify the chosen repair. Cite only
  inspected files and evidence. Do not present a plausible cause as established.
- The solution: state the intended behaviour, responsible components and
  changes to make, including affected boundaries and dependencies. Resolve
  product and policy choices during planning. Builders may choose local
  implementation details; they should not have to discover which problem or
  product change they were commissioned to solve.
- The boundaries and proof: define the success criteria, executable checks,
  protection scope and out-of-scope work together. Check that they describe
  the same delivery without gaps or contradictions.

When these are missing, continue the investigation with the proposal and
record what is known, what is missing and the next useful step. Do not create
an implementation goal whose first task is to find out what to build.
A separately commissioned diagnosis has explicit subjects, a time box,
deliverable and evidence limits. Its criteria accept a bounded investigation,
including a supported negative result, never an unimplemented repair.

## Success criteria

Each criterion states an observable result and a pass/fail boundary. Together
they cover the whole promised delivery; split independently assessable results
when that makes an unmet obligation visible. Keep them proportionate to the
change rather than adding a fixed number of criteria.

- Say under which inputs or conditions the result must hold, what the user
  or consuming component observes, and what counts as failure. Include relevant
  error, recovery and lifecycle behaviour and compatibility that the change
  could break. Select these from the actual risk, not a generic checklist.
- Describe outcomes rather than tasks such as editing a file, adding a test
  or writing documentation. When a document is the commissioned deliverable,
  define the decisions, coverage and reconciliation its content must establish.
- Give each `check` a working directory, prerequisites or fixtures, commands
  or a repeatable procedure, and explicit expected results. State what evidence
  to retain and its limits. Pin named dependencies and required revisions;
  do not leave essential acceptance to unavailable production access or a
  later judgement by Martin.
- For quantitative claims, specify the metric, threshold, measurement scope
  and conditions. For functional claims, name the actual behaviour exercised.
  A green gate, matching keyword, file existence or test count alone does not
  establish the promised outcome. Reuse existing protection and follow
  [writing-tests](../writing-tests.md) for any commissioned test work.
- Read each criterion against its check: could the check pass while the
  promised behaviour is wrong? If so, repair the check or narrow the claim
  honestly. Missing or partial evidence leaves the criterion unmet.

## Out of scope

Name plausible adjacent work that this goal deliberately does not commission,
with enough specificity to prevent expansion: for example, a related host,
data migration, API redesign or legacy retirement. Select actual boundaries
of this solution; do not paste a standard list of prohibitions into every goal.

State what behaviour or interface must be preserved in the contract, and any
deliberately omitted protection and residual risk in the protection decision.
If excluded work is a prerequisite or belongs to another goal, name that
owner and the dependency rather than leaving the delivery boundary implicit.

An exclusion cannot remove work required for a promised result, necessary
failure handling or the criterion's check. Resolve that conflict by changing
the solution or explicitly agreeing a smaller outcome before commissioning.
Read goal, contract, criteria, checks and exclusions together: a build session
must be able to finish the agreed delivery without crossing those boundaries.
