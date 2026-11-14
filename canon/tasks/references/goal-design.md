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

## The parts

Each part answers one question the build session has. The review of the built
change checks the change against the same part, so what a part leaves out is
not reviewed.

| Part | The build's question | Holds |
|---|---|---|
| `aim` | Why is this done? | One or two sentences against the programme's aim; the goals it builds on and the goals that touch the same files. |
| `outcome` | What is true when I am done? | Short prose: what a user or a consuming component observes. |
| `problem` (B) | What is wrong or missing now? | Observed behaviour and its cause, each with its basis: measured, reported or inferred. |
| `premises` (P) | What does the solution rest on? | Claims about the code and the system: the claim, its source (file and line, or the command that produced it), its basis (read, measured or inferred) and the revision it held at. |
| `decisions` (D) | What is already decided? | Each with who decided and when. The build does not reopen one. |
| `change` (C) | What do I change, and where? | Components with their path and what changes in each; the depth follows the class. |
| `latitude` | What may I choose? | The choices the build owns. |
| `preserve` (V) | What must not change? | Invariants, each naming what upholds it: a criterion, a test, a command. |
| `obligations` | Which standards apply here? | One stand per rule area of the goal's repositories: `touched` with what must hold in this change and the standard and section, or `untouched` with the reason. |
| `risks` (R) | How can this change go wrong? | Failure modes of this change, each settled by a criterion, by the protection, or accepted with its reason. |
| criteria | When am I done? | One outcome each, with its check and the evidence to log. |
| `protection` | What do I test? | Behaviour, consequence of failure, level, existing tests to reuse and the fault to replay; or no new test, with the reason and the residual risk. |
| `out-of-scope` (X) | What do I leave? | Adjacent work, each with its owner: another goal, another programme, or nobody. |
| documents | Where is support? | Documents with the section and when it is needed. |

- A premise is a claim the goal would be wrong without. Where a function lives
  is orientation: it belongs in `change` and the documents.
- A criterion, a preserve item or a change that says "every", "only" or "no
  other" points to a premise that holds the inventory and the command that
  produced it. An inventory that was sampled is a sample, and the goal says so.
- A rule area is a short list of pointed questions, each with the condition
  under which it is asked (`mc goal areas <repo>`). Ask each question whose
  condition holds for this change and write the answer as the area's stand. A
  stand of `untouched` is a claim about the diff: the change does not go there.
- A fast goal prescribes the mechanism, so its premises and change carry the
  whole design and are read hardest before build.
- An amendment after handoff replaces one numbered item or one stand and
  leaves the rest; the log keeps what it replaced.
- A session that finds a premise false, or the goal otherwise wrong, reports a
  goal defect naming the item (`mc goal defect --part P2 …`).

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
- Distinguish measured, historical and missing proof. Record revision, scope
  and logs; partial, skipped or unavailable evidence is not green. A criterion
  is marked met only after its whole check holds. Follow
  [writing-tests](../writing-tests.md) for costs; moving work between clocks is
  not a saving. A report as a deliverable specifies its reconciliation and
  evidence.
- A live check (app, browser) gives its command and prerequisites; read the
  ceiling from evidence: the verdict's wall time is under N s, not enforced by
  a wrapper. Do not set a run count, stage allocation, reserved run or load
  condition: a check that holds only on a quiet machine is a defect to repair.
  Rerun after a change or diagnosis; failure is evidence, not budget.
- A goal that says a state is set wrongly names the caller that sets it today
  and the stage it runs in; its fixture uses that stage.

## Out of scope

Name plausible adjacent work that this goal deliberately does not commission,
with enough specificity to prevent expansion: for example, a related host,
data migration, API redesign or legacy retirement. Select actual boundaries
of this solution; do not paste a standard list of prohibitions into every goal.

State what behaviour or interface must be preserved in `preserve`, and any
deliberately omitted protection and residual risk in `protection`.
If excluded work is a prerequisite or belongs to another goal, name that
owner and the dependency rather than leaving the delivery boundary implicit.

An exclusion cannot remove work required for a promised result, necessary
failure handling or the criterion's check. Resolve that conflict by changing
the solution or explicitly agreeing a smaller outcome before commissioning.
Read outcome, change, preserve, criteria, checks and out of scope together: a
build session must be able to finish the agreed delivery without crossing those
boundaries.
