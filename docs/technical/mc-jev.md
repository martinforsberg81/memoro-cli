# jev before Martin: `mc ask` and `mc goal martin`

A goal's question for Martin is read by TypeSafe's Jev model first (Martin,
2026-11-07; programme `jev`). Jev is a System One model: it generates no
text; it takes a `state` and typed questions and returns probabilities. When
jev settles the question with high probability, the answer goes back to the
calling session, which keeps working. Otherwise the goal waits on Martin as
before, with jev's reading attached. The shared code is `src/mc/jev.js`;
`mc goal martin` is `askMartin` in `src/mc/commands/goal.js`, and `mc ask` is
in `src/mc/commands/ask.js`.

Martin's decision, 2026-11-08: jev is asked from any session before a question
with options reaches Martin. Interactive sessions use `mc ask`; goal questions
use `mc goal martin` (which asks jev itself, not both verbs).

## `mc ask`

```
mc ask [<programme>/<goal>] --reason "<the question>" \
  --option "<key>: <text>" --option "<key>: <text>" [--option …] \
  --recommend <key> [--evidence "…" | --evidence-file <path|->] \
  [--document <path>]… [--reserved <act>]
```

It uses the same validation, request, thresholds and ledger as `mc goal martin`,
but always asks jev regardless of `MC_TOOL`; a reserved act is never sent. It
never changes goal state. A named goal (or `MC_GOAL`) supplies exactly the
`jevContext` state of `mc goal martin`. Without a goal, programme context is
`MC_PROGRAMME`, otherwise the programme containing the working directory under
`~/mc/programs/`; its README and repository planning-worktree rulings are sent,
and `goal` is null. With no programme, it carries only question, options,
evidence and documents. The questions say “this work” when there is no goal;
the goal-bound instruction texts remain unchanged.

Answered calls exit 0 and say `mc: jev answered … — continue with: …`. A miss,
unavailable request or residual over-budget state exits 1; reserved acts exit 1
with Martin's decision message. A malformed call exits 2. An answered call with
a named goal appends the same kind of LOG.md entry as `mc goal martin`; other
calls do not change a goal.

## The call

```
mc goal martin [<programme>/<goal>] --reason "<the question>" \
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

Who may set `Martin` is unchanged (`refusedMove`): plan, finish, mend and a
person; a build or review session is refused before jev is asked. The
runner's own recovery settings of `Martin` (`src/mc/run.js`) do not go
through the verb and never ask jev.

## The flow

1. **Not asked.** `--reserved <act>`, or a caller with `MC_TOOL` unset or
   `person`, goes straight to Martin: no request. The entry says
   `jev not asked: reserved act <act>` or `jev not asked: person`. Reserved
   acts never go to jev (Martin, 2026-11-07).
2. **One request.** `POST https://api.typesafe.ai/v1/systemone`, model
   `jev-1.14.0` (pinned), `Authorization: Bearer <TYPESAFE_API_KEY>`, Node's
   `fetch`, no SDK, no long-context header. Three questions:
   - `answer` — a Choice over the option keys, the option texts as criteria:
     *Which option is the right way for this goal to proceed, given the goal,
     its contract and the decided standards in the state.*
   - `fits` — a Noul: *One of the options in `options` is a correct way for
     this goal to proceed.*
   - `settled` — a Noul: *The goal, its contract, the programme's rulings or
     the technical standards in the state already decide which option is
     right, so no new product or policy decision by Martin is needed.*
3. **Answered** when all hold, else **Martin**.
4. **Failure is Martin.** A missing key or unreadable keys source, a network
   error, a 15-second timeout, a non-2xx (429 and 5xx are retried once,
   honouring `retry-after` up to 10 seconds; one without waits 1 second), a
   malformed response and a choice that is not an option key all set `Martin`
   with `jev unavailable: <reason>`. jev never makes the verb fail.

## The thresholds

jev answers only when its `answer.choice` equals `--recommend`,
`probabilities[choice] >= 0.90`, `fits >= 0.70` and `settled >= 0.70`. The
four live as `THRESHOLDS` (and the agreement in `judge`) in `src/mc/jev.js`.
They, and the pinned model, change only with Martin. The session's
recommendation is never in the state: jev chooses blind, and agreement is the
check.

## The context sent

The state is one JSON object:

- `question`, `options` (key to text), `evidence`;
- `goal` — title, goal, contract, out of scope, the criteria with check and
  met, stage, status;
- `programme` — `~/mc/programs/<programme>/README.md`, and
  `docs/project/<programme>/rulings.md` from each of the goal's repository
  worktrees when present;
- `documents` — the goal's documents and each `--document`, as path (and
  label) and text; one that cannot be read is said on stderr and not sent;
- `log` — the last five LOG.md entries.

The serialized state stays within 240,000 characters (`STATE_BUDGET`).
Trimmed in this order: the oldest log entries, then document text largest
first (cut, ending `[truncated]`), then the programme README (then its
rulings), then whole documents largest first if still necessary. The question,
options, evidence and goal are never trimmed; if they alone exceed the budget,
the call is refused with a return instruction to shorten them.

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
- **Martin:** the status becomes `Martin`; the entry records the question, the
  options, the recommendation and jev's reading with each condition missed,
  or why jev was not asked or was unavailable.

## The ledger

Every call that passes validation appends one JSON line to
`<mc home>/jev/decisions.jsonl` (`mcHome`: `MC_HOME`, else
`~/.memoro/mc`): `at`, `verb` (`ask` or `goal martin`), `programme` (or null),
`goal` (or null), `tool`, `role`, `question`, `options`,
`recommend`, `reserved`, `documents` (the paths sent), `trimmed` (each part
cut), `state_length`, `state_sha256`, `model` (the response's model id),
`answers` (`answer` with choice, probabilities and confidence; `fits`;
`settled`), `outcome` (`answered` or `martin`) and `reason`. No key and no
state body go there. A ledger that cannot be written is a warning, never a
failure.

## Tests

No test or gate run makes a live jev request: the transport, its timers, the
keys source and the ledger are injected through `deps`
(`tests/mc/jev.test.js`, `tests/mc/commands/goal.test.js`), and the real
transport refuses to run under the Node test runner. Drift in TypeSafe's real
response shape is not covered by acceptance; plan runs a live smoke call
after landing.

Not here yet: the ledger on the mc page, a way for Martin to overturn a jev
answer, and calibrating the thresholds against Martin's answers.
