# Risk-based test strategy

## Select protection by consequence

Prioritise the consequence and likelihood of failure, and whether other
controls already detect it. A new function, component, bug fix or line of code
does not automatically warrant a new permanent test. Coverage percentages and
test counts are not outcomes. The test-writing skill defines admission and
proof; role instructions define who commissions, implements and judges work.

| Area | Observable protection |
| --- | --- |
| Security and authorisation | Disallowed operations fail, accounts stay isolated, secrets do not escape. Include denial and failure paths, not only successful access. |
| Data and money | Writes, deletion, synchronisation and payments produce the right persisted state; retries and partial failures do not lose or duplicate effects. |
| Domain rules and state | Consequential calculations, decisions and transitions satisfy the agreed rule, including relevant boundaries and invalid transitions. |
| Essential user journeys | A small, chosen set of important flows crosses the real integration boundaries on which success depends. |
| mc landing and unattended decisions | The judged code lands on the intended base; unsafe landings and incorrect runner actions are refused. |

These are priorities, not a demand to add a suite to every domain. Expand
protection only where a concrete risk and missing evidence justify it.

## Commission by consequence, not by finding

An audit finding, review note or proposal is a candidate, not a commission.
It becomes test work only when all three hold:

1. the fault would have a consequence in the table above;
2. it is plausible, and nothing already detects it: other tests, the merge
   round, review or a runtime refusal;
3. closing it costs less than the gap, counting test, maintenance and review
   cost.

A test-cost optimisation is commissioned only from a measured cost that matters
for the affected round, never from inspection alone. Documentation drift is
fixed by the work that touches the document, or in one bounded pass per
repository. Anything else is declined with its reason and a one-line residual
risk. A weak but harmless test stays as it is: rewriting a test that works is
a cost, not a gain.

## Use the cheapest credible level

| Subject | Suitable evidence |
| --- | --- |
| Pure calculation or state decision | Direct calls with small inputs, expected outputs and selected boundary/failure cases. |
| Persistence, transactions or query semantics | The relevant real database mechanism with a minimal isolated fixture; a fake SQL responder cannot prove SQL works. Use the repository's approved schema provision, not a full migration replay per test. |
| Request or component integration | Real collaborating application code around the boundary being proved; replace unrelated remote dependencies with controlled responses. |
| DOM, focus, layout or interaction | A real browser and observable user outcomes. Source strings and simulated DOMs do not prove rendering or interaction. Keep full journeys few and selected. |
| External-service handling | Controlled success, failure and retry responses for our decisions; separately scoped live probes when the provider's real behaviour is the question. No credentials or live network in the ordinary fast lane. |
| AI output quality | Separate evaluations with explicit criteria and representative cases. Exact generated wording is not a stable oracle. Deterministic parsing and tool/permission rules can have ordinary tests. |
| Architecture restrictions | Narrow source analysis only for an explicit invariant, such as a forbidden dependency. Explain why behavioural checks cannot establish it. |

The level is determined by what can expose the fault, not by the available
mock helper. A Git model proves our decisions against modelled answers; it
does not prove Git merge/conflict semantics. Use existing approved mechanisms;
a new integration lane is a planning decision, not an implicit requirement.

## Reject weak or redundant evidence

A meaningful test fails because a promised behaviour is broken, not because a
helper was renamed, code moved, wording changed or harmless calls reordered.
Do not assert private call sequences, file totals or source spellings unless
that exact property is the commissioned contract. Do not add broad scans for
one local change. Check for existing protection before adding another layer.

Fault evidence must exercise the relevant assertion: a test failing because
an import is broken or setup crashes does not establish fault detection.
For a regression, reproduce the original failure where practical; otherwise
record the deliberate faulty case and its limits. One deliberate fault per
protected behaviour is enough; the proof is proportionate to the consequence,
not an exhaustive fault list, a mutation-testing framework or a full-suite
replay.

## Budget execution and maintenance

Use the existing gate and its selection mechanism. Keep checks deterministic,
isolated from the person's state and safe in concurrent worktrees. Measure
setup, file startup and selected-round cost alongside individual test times.
Record resource prerequisites; unavailable evidence is not a passing result.
Do not split cases or hoist heavy setup merely to evade a timeout.

### What runs where

Main is where work meets; production is what users have. A merge checks four
things: a clean merge onto current main; the change's own tests; no command
gates; and the review's verdict on the judged head. Review judges whether the
change is well written, free of bugs and works as intended.

The change's own tests are every added or modified test file, every test that
directly imports an added or modified source (one hop, read at head), and, for
a deleted or renamed source, its direct importer tests at the base. Memoro
also runs the eight-file mandatory core in `config/testing-registry.mjs`.
No transitive import closure, pin, scan, area blanket or registry target widens
this set. Bare `mc gate` and the merge round use the same scope without cost
deferral or command gates.

The daily full run retains every test, including deferred tests and main-only
ratchets, every CI binding command and all three contract suites, including
`test:browser-contracts`. The wide selection remains available through
`mc gate --whole-selection`; named gates and `mc test <repo> --full` remain
optional tools, never landing requirements. Wide regression protection belongs
to the daily full run and before a deploy, not to a merge. Main may carry a
red this merge did not look for: the daily run finds it within a day and sends
it to a main-red mend; the deploy gate keeps it from production. Until the
separate deploy-gate goal lands, the person deploying must read that full run.

Browser journeys, live integrations, AI evaluations and performance evidence
still use their commissioned existing levels and environments. No suite is
retired by changing merge selection; the full run keeps its protection. No new
lane, timeout increase or threshold weakening is part of this strategy.

## Apply the strategy to the existing estate

Existing checks are revisited only where a consequential area lacks credible
evidence, a cost is measured, or a test blocks work. There is no estate-wide
audit, path-by-path disposition or closeout: an untouched legacy test is
neither certified nor scheduled. For each decision taken, record the path,
protected behaviour, evidence examined, keep/rebuild/consolidate/retire
verdict and next action. Use measured runtime when available; static
inspection is not a timing result.

Before retiring a check, identify any unique protection, the replacement that
actually covers it, or the residual risk accepted in planning. Keep useful
parts of an otherwise weak suite. Do not delete a check simply because it is
slow or currently red. Work that changes protection is reviewed against its
commissioned scope; a green gate is not an audit of the whole estate.

## Adoption and limits

This strategy governs new test work and changes to existing checks. It does
not certify legacy tests, automatically rewrite existing goals, or add a
machine-enforced permission system. Planning must include protection scope in
new goals and amend active goals when their test work would exceed it. Reviews
check this explicitly; missing evidence is reported, not presumed.
