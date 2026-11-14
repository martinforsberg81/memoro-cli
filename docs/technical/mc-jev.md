# jev before Martin: `mc ask` and `mc goal martin`

An options question is read by TypeSafe's Jev model first (Martin,
2026-11-07; programme `jev`). Jev is a System One model: it generates no
text; it takes a `state` and typed questions and returns probabilities. When
jev settles the question with high probability, the answer goes back to the
calling session, which keeps working. Otherwise an unsettled technical question
is decided by the session's recommendation; product choices and reserved acts
reach Martin. The shared code is `src/mc/jev.js`;
`mc goal martin` is `askMartin` in `src/mc/commands/goal.js`, and `mc ask` is
in `src/mc/commands/ask.js`.

## Decisions presented to Martin

Martin, 2026-11-08: every decision presented for his consideration is written
at design level, ready for `docs/technical/`. Normal build questions are
answered by the technical standards and programme design. Apply those answers
without asking; investigate a detail-level question as a possible missing
general rule before escalating it.

A remaining decision includes evidence, design alternatives and tradeoffs,
one recommendation, and proposed normative text with the destination technical
document and section. Preserve concrete action identifiers and evidence when
needed. After the answer, reconcile the standard, programme design and affected
goal contracts; recording it only in a goal log is insufficient.

## Who asks jev

Martin, 2026-11-08: jev is asked from any session, interactive or headless,
with or without a goal, as decision support. An interactive session always
asks jev before using options to make a decision: when jev settles it, the
session continues with jev's answer and names it in its account; otherwise the
technical/product flow below applies. A goal-bound `mc ask` or compatible `mc goal
martin` call makes one jev consultation. An answer leaves stage/status unchanged,
appends the trace and continues. Martin's mandate of 2026-11-14 is that the system
decides every technical question itself and reports afterwards. A session labels
`product` as a choice of direction that the goal, programme page and standards do not
already answer, and that changes what users are promised, product cost, personal-data
handling or test strategy. `technical` is everything else, including implementation,
architecture, tooling, environment, order of work, whether a goal adopts or changes
what its own criteria need, and carrying out an already decided design, even when
users see the result. The session's kind determines the route; jev's product reading
is recorded but never moves a technical question to Martin. An unsettled technical
call, whatever that reading, or any unavailable jev result, records the session's
recommendation and continues. An unresolved product call stores the sanitized
question/options/recommendation/evidence/reading and sets that goal directly to
Martin; it must not trigger another jev request or mend hop. Build, review and finish
repair acceptance obstacles in-role. Reserved acts never go to jev, from any session.

`mc ask` is the general route and the single-pass goal-bound escalation path (landed, `jev/ask-anywhere`); `mc goal martin` remains compatible with it and needs no mend caller. A person caller of `mc goal martin` (`MC_TOOL` unset) still skips jev (*The flow*, step 1).

## `mc ask`

```
mc ask [<programme>/<goal>] --kind technical|product --reason "<the question>" \
  --option "<key>: <text>" --option "<key>: <text>" [--option …] \
  --recommend <key> [--evidence "…" | --evidence-file <path|->] \
  [--document <path>]… [--reserved <act>]
```

Session callers require `--kind technical|product`; person callers may omit it.
It uses the same validation, request, thresholds and ledger as `mc goal martin`,
but always asks jev regardless of `MC_TOOL`; a reserved act is never sent. A
technical result not answered, whatever its product reading, or unavailable,
logs and continues with the recommendation, preserving goal stage/status. A
product result sets a goal Martin; a
no-goal product call exits 1 without changing a goal. A no-goal technical call
is decided and ledgered without changing a goal. A named goal (or `MC_GOAL`) supplies exactly the
`jevContext` state of `mc goal martin`. Without a goal, programme context is
`MC_PROGRAMME`, otherwise the programme containing the working directory under
`~/mc/programs/`; its README is sent,
and `goal` is null. With no programme, it carries only question, options,
evidence and documents. The questions say “this work” when there is no goal;
the goal-bound instruction texts remain unchanged.

Answered calls exit 0 and say `mc: jev answered … — continue with: …`. An
unsettled or unavailable technical call exits 0 after recording the session's
decision; an unresolved product call exits 1. Reserved acts exit 1 with
Martin's decision message. A malformed call exits 2. An answered call with
a named goal appends the same kind of LOG.md entry as `mc goal martin`; an
unsettled technical call records the session's recommendation in the goal log
and ledger without changing stage/status. A product escalation changes that
goal to Martin. Invalid calls change neither goal nor ledger. No-goal calls do
not change a goal.

## The call

```
mc goal martin [<programme>/<goal>] --kind technical|product --reason "<the question>" \
  --option "<key>: <text>" --option "<key>: <text>" [--option …] \
  --recommend <key> [--evidence "…" | --evidence-file <path|->] \
  [--document <repo>/<path>]… [--reserved deploy|production-data|credentials|admin]
```

- `--reason` is the question and is required.
- `--option` is given 2 to 4 times; its key matches `^[a-z][a-z0-9_]{0,31}$`
  and is unique, its text is not empty.
- `--recommend` names one of the keys: the session's own choice.
- `--evidence` (or `--evidence-file`, `-` for stdin) is what the session found
  and tried; `--document` adds a file the question turns on. Paths resolve
  relative to the goal or programme directory, `~/…` or absolute. An explicit
  document is sent only if its real path is inside an allowed goal repository
  worktree, programme planning worktree, or (without programme context) the
  working directory's git top level. Escaping symlinks are refused with a
  warning. Goal-listed documents are sent as plan wrote them.

A call that breaks any of these — and one whose core (question, options,
evidence, goal) alone is over the budget — exits 2, writes nothing, and
stderr says what is wrong, gives a complete example call and tells the session
to call again (Martin's decision: options are required, and a call without
them is answered with how to call it correctly). `mc goal log --status Martin`
is refused the same way, pointing at `mc goal martin`.

Build, review, finish, mend, plan and interactive Martin may set Martin within their role bounds; build/review retain stage and brief mutation restrictions. Martin may use `mc ask` to consult jev once for a newly synthesized design-level question. Goal-bound mc ask is a single consultation and direct escalation path. The
runner's own recovery settings of `Martin` (`src/mc/run.js`) do not go
through the verb and never ask jev.

The Martin role's interactive-only restriction also applies to `mc ask`,
with or without a goal. An unattended Martin call is refused before any
goal/log/ledger mutation, key read or provider request; ordinary headless
stage roles retain their existing bounded ask permissions.

## The flow

1. **Not asked.** `--reserved <act>` is never sent to jev. A person caller of
   `mc goal martin` (`MC_TOOL` unset or `person`) also goes straight to Martin:
   no request. The entry says `jev not asked: reserved act <act>` or
   `jev not asked: person`. Reserved acts never go to jev (Martin, 2026-11-07).
2. **One request.** `POST https://api.typesafe.ai/v1/systemone`, model
   `jev-1.14.0` (pinned), `Authorization: Bearer <TYPESAFE_API_KEY>`, Node's
   `fetch`, no SDK, no long-context header. Four questions:
   - `answer` — a Choice over the option keys, the option texts as criteria:
     *Which option is the right way for this goal to proceed, given the goal,
     its contract and the decided standards in the state.*
   - `fits` — a Noul: *One of the options in `options` is a correct way for
     this goal to proceed.*
   - `settled` — a Noul: *The goal, its contract, the programme README or
     the technical standards in the state already decide which option is
     right, so no new product or policy decision by Martin is needed.*
   - `product` — a Noul: *Choosing between the options is a choice of product
     direction that changes what users are promised, what the product costs or
     how personal data is handled, and that the goal, programme page and
     standards in the state do not already answer.*
3. **Answered** when all existing answer conditions hold.
4. **Technical decision.** Every unsettled technical call, whatever jev's
   product reading, or if jev is unavailable for any reason, records and uses
   the session's recommendation; the goal stays at the same stage/status.
5. **Product escalation.** An unresolved product call follows the Martin path.
   A missing key or unreadable keys source, a network
   error, a 15-second timeout, a non-2xx (429 and 5xx are retried once,
   honouring `retry-after` up to 10 seconds; one without waits 1 second), a
   malformed response and a choice that is not an option key are unavailable.
   Unavailability decides a technical call by the session; a product call sets
   Martin with `jev unavailable: <reason>`.

## The thresholds

jev answers only when its `answer.choice` equals `--recommend`,
`probabilities[choice] >= 0.90`, `fits >= 0.70` and `settled >= 0.70`. These
live as `THRESHOLDS` in `src/mc/jev.js`; the `judge` for answered questions is
unchanged. The three original thresholds, and the pinned model, change only
with Martin. The `product` reading has no routing threshold; `mc decisions`
flags a session decision with product `>= 0.70` for Martin to notice. The session's
recommendation is never in the state: jev chooses blind, and agreement is the
check.

## The context sent

The state is one JSON object:

- `question`, `options` (key to text), `evidence`;
- `goal` — title, goal, contract, out of scope, the criteria with check and
  met, stage, status;
- `programme` — `~/mc/programs/<programme>/README.md`. Nothing under
  `docs/project/` is read or sent: a decision still in force lives in the
  README or in `docs/technical/`;
- `documents` — the goal's documents and each `--document`, as path (and
  label) and text; one that cannot be read is said on stderr and not sent;
- `log` — the last five LOG.md entries.

The serialized state stays within 90,000 characters (`STATE_BUDGET`). The
figure follows jev-1.14.0's input limit, measured 2026-11-10 with synthetic
text: 195,000 characters gave 32,320 input tokens and 200; 205,000 gave
`400 max_tokens_exceeded`, so the limit is about 32,000 tokens. Real states
(JSON, paths, code) run at about 3.5 characters a token, so 90,000 characters
is about 25,700 tokens.

Trimmed in this order: the oldest log entries, then document text largest
first (cut, ending `[truncated]`), then the programme README, then whole
documents largest first if still necessary. The question,
options, evidence and goal are never trimmed; if they alone exceed the budget,
the call is refused with a return instruction to shorten them.

**Shrink and retry.** A 400 whose body names `max_tokens_exceeded` is not
retried as it is: the state is rebuilt at 0.7 of the budget (63,000, then
44,100 characters) and asked again, at most twice. The ledger row records
`budget` (the one finally sent) and `error_type`; `trimmed` names the shrink,
`budget shrunk to <n> characters after max_tokens_exceeded`. If the third
state is refused too, the call ends unavailable:
`jev unavailable: HTTP 400 (max_tokens_exceeded) after 2 rebuilds of the
state, the last at 44100 characters`; the kind-based flow above applies. Any other non-2xx
keeps its handling (429 and 5xx are retried once) and its reason names the
body's error_type when it has one, e.g. `HTTP 400 (invalid_schema)`.

## The data rule

Martin, 2026-11-07: sending mc's working context (goal text, logs, programme
documents, `docs/technical/`) to TypeSafe is approved. No user data and no
passwords are sent — and they do not belong in ordinary sessions either.
Key redaction is the guard: before sending, every value of 8 or more
characters from the `mc keys` source is replaced with `[redacted]` in the
state, and the same values are redacted from the LOG.md entry, the ledger,
stdout and stderr.

The key (`TYPESAFE_API_KEY`) is read by mc itself from the `mc keys` source
(`src/mc/keys-dotenv.js`; default `~/mc/self/memoro/.dev.vars`,
`MC_KEYS_FILE` honoured; [mc-keys.md](mc-keys.md)). It goes only into the
Authorization header: never into or from the session environment, argv,
LOG.md, the ledger, stdout or stderr.

## The outcome

- **Answered:** exit 0, the status is unchanged, stdout says
  `mc: jev answered <key> (p <prob>, fits <n>, settled <n>, <model>) — continue
  with: <option text>`, and LOG.md gets an entry with the question, the
  options, the recommendation and jev's answer. The session continues with the
  answer as if Martin had given it.
- **Decided:** an unsettled or unavailable technical call exits 0. The status
  and stage are unchanged; stdout names the selected recommendation and the
  reading/unavailable reason. The goal's LOG.md comment starts `Decided by the
  session (technical):` and includes the question, options, recommendation,
  evidence and jev reading. The ledger has `kind: "technical"` and
  `outcome: "decided"`.
- **Martin:** an unresolved product call sets a goal to `Martin` and exits 1;
  the entry records the question, options, recommendation and reading.
  Reserved acts keep their existing behavior.

## The ledger

Every call that passes validation appends one JSON line to
`<mc home>/jev/decisions.jsonl` (`mcHome`: `MC_HOME`, else
`~/.memoro/mc`): `at`, `verb` (`ask` or `goal martin`), `programme` (or null),
`goal` (or null), `tool`, `role`, `question`, `options`,
`recommend`, `kind` (absent on rows predating this change), `reserved`, `documents` (the paths sent), `trimmed` (each part
cut), `state_length`, `state_sha256`, `model` (the response's model id),
`answers` (`answer` with choice, probabilities and confidence; `fits`;
`settled`, `product`), `outcome` (`answered`, `decided`, `martin` or `reserved`) and `reason`. No key and no
state body go there. A ledger that cannot be written is a warning, never a
failure.

## Tests

No test or gate run makes a live jev request: the transport, its timers, the
keys source and the ledger are injected through `deps`
(`tests/mc/jev.test.js`, `tests/mc/commands/goal.test.js`), and the real
transport refuses to run under the Node test runner. Drift in TypeSafe's real
response shape is not covered by acceptance; plan runs a live smoke call
after landing.

## `mc decisions`

`mc decisions [--since <date>] [--programme <programme>] [--json]` reads only
the ledger; it makes no model or network request and writes no file, including
invocation logs (the explicit exception in [mc-log.md](mc-log.md)). By default
it lists `decided` and `answered` rows from the last seven days; `--since`
(YYYY-MM-DD) and `--programme` narrow the set. Rows are newest first and show
time, programme/goal, kind (`-` for old rows), one-line question, chosen key and
option text, and jev's reading. A differing jev choice is marked
`jev preferred <key>`. An unparseable line is named on stderr and skipped.
For `decided` rows, product readings of `0.70` or higher are marked `jev read
this as a product choice` and listed first, so Martin sees them before the
other rows. `--json` returns the same rows as data. An absent ledger says there
is nothing to report and exits 0.

Not here yet: the ledger on the mc page, a way for Martin to overturn a jev
answer, and calibrating the thresholds against Martin's answers.
