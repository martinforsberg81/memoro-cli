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
record the deliberate faulty case and its limits. This is focused evidence,
not a requirement for a new mutation-testing framework or full-suite replay.

## Budget execution and maintenance

Use the existing gate and its selection mechanism. Keep checks deterministic,
isolated from the person's state and safe in concurrent worktrees. Measure
setup, file startup and selected-round cost alongside individual test times.
Record resource prerequisites; unavailable evidence is not a passing result.
Do not split cases or hoist heavy setup merely to evade a timeout.

Fast deterministic checks belong in the affected-change lane. Browser journeys,
live integrations, AI evaluations and performance measurements belong in the
existing appropriate lanes when commissioned. A one-second unit-test limit
must not be used to claim an inherently slower end-to-end flow was verified by
a mocked substitute. Instead choose the correct evidence and record its cost.
Nightly detection supplements selection; it does not make duplicate or brittle
checks worth keeping. No new lane, timeout increase or threshold weakening is
part of adopting this strategy.

## Apply the strategy to the existing estate

Audit in bounded batches, prioritising costly fixtures, source-text assertions
and overlapping checks. For each decision record the path, protected behaviour,
evidence examined, keep/rebuild/consolidate/retire verdict and next action.
Use measured runtime when available; static inspection is not a timing result.

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
