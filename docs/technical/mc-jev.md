# jev, then a reader, before Martin: `mc ask`

A session has one way to ask: `mc ask`. An options question is read by
TypeSafe's Jev model first (Martin, 2026-11-07; programme `jev`). Jev is a
System One model: it generates no text; it takes a `state` and typed questions
and returns probabilities. When jev settles the question with high probability,
the answer goes back to the calling session, which keeps working. When it does
not, a fresh read-only reader session answers inside the same call (*The
reader*). Nothing a session asks makes a goal wait on Martin except a reserved
act and a goal defect the reader finds. What reaches Martin, and what he decides
himself, is the rule in
[canon/tasks/asking-martin.md](../../canon/tasks/asking-martin.md). The shared
code is `src/mc/jev.js`, the reader is `src/mc/ask-reader.js`, and `mc ask` is in
`src/mc/commands/ask.js`. `mc goal martin` is gone (*Retired*).

## Decisions presented to Martin

Normal build questions are answered by the technical standards and programme
design. Apply those answers without asking; investigate a detail-level question
as a possible missing general rule before escalating it.

What remains for Martin is shown as a brief in the form that
[canon/roles/decision.md](../../canon/roles/decision.md) and
[mc-martin.md](mc-martin.md) set: a change to a text he holds in three parts, an
act only he may do in the parts of a reserved brief. The
desk's opening shows each waiting item with its brief ([mc-martin](mc-martin.md)).
Preserve concrete action identifiers and evidence when needed. After the
answer, reconcile the standard, programme design and affected goal contracts;
recording it only in a goal log is insufficient.

## Who asks

Martin, 2026-11-08: jev is asked from any session, interactive or headless,
with or without a goal, as decision support. An interactive session always
asks before using options to make a decision: when jev settles it, the
session continues with jev's answer and names it in its account. Martin's
mandate of 2026-11-14 is that the system decides every technical question
itself and reports afterwards; his decision of 2026-11-15 is that there is one
way to ask, `mc ask`, and that it never asks him except for a reserved act.
A call makes one jev consultation and, when jev does not settle it, one reader.
Every answer leaves stage and status unchanged, appends the trace to the goal's
LOG.md and continues. Build, review and finish repair acceptance obstacles
in-role. Reserved acts never go to jev or the reader, from any session.

A goal session that does not know whether a question is Martin's does not
classify it: it asks. Whether a text of Martin's would change is the reader's
finding, not a flag the session sets.

## `mc ask`

```
mc ask [<programme>/<goal>] --reason "<the question>" \
  --option "<key>: <text>" --option "<key>: <text>" [--option …] \
  --recommend <key> [--evidence "…" | --evidence-file <path|->] \
  [--document <path>]… [--reserved <act>]
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
- `--kind` is accepted and ignored: an old call still parses, and stderr says
  `mc: --kind is not read — whether a text of Martin’s would change is the reader’s finding`.
- `--reserved <act>` names an act only Martin may do (`deploy`,
  `production-data`, `credentials`, `admin`); the call goes to him and to nobody
  else.

A call that breaks any of these — and one whose core (question, options,
evidence, goal) alone is over the budget — exits 2, writes nothing, and
stderr says what is wrong, gives a complete example call and tells the session
to call again (Martin's decision: options are required, and a call without
them is answered with how to call it correctly). `mc goal log --status Martin`
is refused the same way, pointing at `mc ask`.

A named goal (or `MC_GOAL`) supplies the `jevContext` state: the goal, its
contract, documents and last log entries. Without a goal, programme context is
`MC_PROGRAMME`, otherwise the programme containing the working directory under
`~/mc/programs/`; its README is sent, and `goal` is null. With no programme, it
carries only question, options, evidence and documents. The questions say “this
work” when there is no goal.

Build, review, finish, mend, plan, decision and interactive Martin may call it
within their role bounds; a goal session cannot ask for another goal. The
Martin role's interactive-only restriction also applies to `mc ask`: an
unattended Martin call is refused before any goal/log/ledger mutation, key read
or provider request. `desk-prepare` and `plan-review` cannot ask at all, and an
`ask-reader` session may only run `mc ask answer`. The unattended `decision`
desk role may call `mc ask` at any active stage without acquiring a delivery
role's stage restriction; its goal mutations retain `by decision` attribution.
This does not authorize headless reserved acts; those remain briefs for Martin
([mc-martin.md](mc-martin.md)).

`mc goal defect` (a wrong goal, reported by build, review or finish) is a report
and not a question: it asks nobody, carries no options and never reaches jev or
the reader. The runner's own recovery settings of `Martin` (`src/mc/run.js`),
the no-progress stop among them, do not go through `mc ask` either.

### Retired

`mc goal martin` is gone: it exits 2 in every role, before any other check, and
prints the `mc ask` call to make (`retiredMartin` in `src/mc/commands/goal.js`).
It reads no key and writes no ledger row, and its message keeps no part of the
call the caller typed: the old `--reason` text is never echoed.

## The flow

1. **Not asked.** `--reserved <act>` is never sent to jev or the reader. The goal
   is set to Martin with the entry `reserved act <act> — Martin decides, jev is
   not asked`, the call exits 1, and the ledger row has `outcome: "reserved"`
   and `answered_by: "martin"`. Reserved acts never go to jev (Martin,
   2026-11-07).
2. **One request to jev.** `POST https://api.typesafe.ai/v1/systemone`, model
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
     standards in the state do not already answer.* Its reading is recorded and
     shown in `mc decisions`; it routes nothing.
3. **Answered by jev** when all answer conditions hold (*The thresholds*): exit
   0, `answered_by: "jev"`.
4. **Read.** A missing key, an unreadable keys source, a network error, a
   15-second timeout, a non-2xx (429 and 5xx are retried once, honouring
   `retry-after` up to 10 seconds; one without waits 1 second), a malformed
   response, a choice that is not an option key, or an answer below a threshold
   all mean jev did not settle it. The reader reads it now, in the same call
   (*The reader*), and stderr says `mc: jev did not settle it — a reader reads
   it now (up to 10 minutes)`. An unreadable keys source launches no reader: its
   copy could not be redacted.

## The reader

Role `ask-reader` (`canon/roles/ask-reader.md`), model list `decision`
(`mc-roles.md`), a limit of 10 minutes (`LIMIT_MS`), started as `ask-reader` by
`mc ask` itself and never by the runner. It mirrors `mc goal plan-review`: a
fresh session that reads and does not edit.

- **Model.** `chooseAskReader` takes the first model of the `decision` list
  that is not the asker's own, and the whole list when nothing else can run.
- **The tree.** The reader works in a read-only copy of the asker's worktree
  (`snapshotTree`): the tracked and untracked files git lists, with the working
  tree's bytes, not the ignored ones and no `.git`; only regular text files up
  to 1 MiB (`MAX_FILE_BYTES`); every key-source value of 8 or more characters
  is redacted in each copy; every file is read-only. One `git ls-files` call is
  made and the source is never written. A call without a worktree launches in an
  empty tree. The copy lives under the call's directory,
  `<runner>/ask/<id>` (`callDirOf`), and is removed when the call ends; one that
  cannot be removed is left and said.
- **The prompt.** The question, the options with the recommendation, the
  evidence, what jev read, the goal's repositories and where the copy is.
  Nothing in it holds a key-source value.
- **The token.** Each call has an id and a token. The token is only in the
  reader's environment (`MC_ASK_TOKEN`, with the call id in `MC_ASK_CALL`); its
  sha256 is in `launch.json` in the call's directory. No file holds the token.
- **The tools.** The reader runs headless (`MC_HEADLESS=1`) in the `ask-reader`
  role: it may use `mc goal show|list|areas` and `mc ask answer`, and the
  pre-tool hook refuses every other `mc` verb, and every deploy or credentials
  command, as to any unattended session ([mc-hooks.md](mc-hooks.md)).
- **The verb.** `mc ask answer <id> continue <key> [--why "…"]`,
  `mc ask answer <id> defect --part "…" --found "…"` or
  `mc ask answer <id> text --inside <key> | --none --text "…" --file <path|->`.
  It is accepted only from the `ask-reader` session the call launched: the
  call's id, a token whose sha256 is the launch file's, a call still live (its
  process alive and within the 10 minutes), and once. A failed check exits 2,
  writes nothing and says the fix.
- **The wait.** The asker waits inside the call. A tool call that cannot wait up
  to fifteen minutes runs `mc ask` in the background and reads its answer
  afterwards.
- **The cost.** One row of kind `ask-reader` in the desk's `runs.tsv`, counted
  under the desk's daily ceiling (`desk-budget.js`; `PASSES` in
  `desk-opening.js` names it). A held ceiling launches no reader and the call is
  decided as unread.

The reader gives one of four answers (Martin, 2026-11-15):

| Answer | Verb | What happens | Ledger `outcome` | `answered_by` |
|---|---|---|---|---|
| Continue with an option | `continue <key>` | exit 0; the key is the answer. A key other than the recommendation carries its `--why`, which the asker's output and the ledger show and the desk reads. | `read` | `reader` |
| A goal defect | `defect` | recorded as `mc goal defect` records it (one entry, the goal set to Martin, no further session); exit 0 with the entry's text. A defect that cannot be recorded is unread. | `defect` | `reader` |
| A text of Martin's would change | `text` | `mc martin propose` writes the desk item (a duplicate takes the goal and notes the asker as `other_goal`); the caller continues inside the wording that stands, `--inside <key>` the option that does so (exit 0), or `--none` when none does (exit 1: continue with the rest, the part that needs the text waits on the item). The goal is not set to Martin. | `text` | `reader` |
| Unread | — | no reader answered (no verdict, the 10 minutes ran out, no model could start, billing or the tool unavailable, the role missing, the ceiling held, the keys source unreadable): exit 0 with the session's own recommendation, and the ledger says why in `unread_reason`. Every unread row reaches the desk. | `decided` | `session` |

Whatever the asker is told, no answer but a reserved act or a defect makes a goal
wait on Martin.

## The thresholds

jev answers only when its `answer.choice` equals `--recommend`,
`probabilities[choice] >= 0.90`, `fits >= 0.70` and `settled >= 0.70`. These
live as `THRESHOLDS` in `src/mc/jev.js`; the `judge` for answered questions is
unchanged. The three original thresholds, and the pinned model, change only
with Martin. The `product` reading has no routing threshold; `mc decisions`
flags a decision with product `>= 0.70` for Martin to notice. The session's
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
stdout and stderr, from the reader's copy of the worktree, its prompt, its
launch file, the run row and any desk item. An unreadable keys source sends
nothing and launches no reader.

The key (`TYPESAFE_API_KEY`) is read by mc itself from the `mc keys` source
(`src/mc/keys-dotenv.js`; default `~/mc/self/memoro/.dev.vars`,
`MC_KEYS_FILE` honoured; [mc-keys.md](mc-keys.md)). It goes only into the
Authorization header: never into or from the session environment, argv,
LOG.md, the ledger, stdout or stderr.

## The outcome

- **Answered by jev:** exit 0, the status is unchanged, stdout says
  `mc: jev answered <key> (p <prob>, fits <n>, settled <n>, <model>) — continue
  with: <option text>`, and LOG.md gets an entry with the question, the
  options, the recommendation and jev's answer. The session continues with the
  answer as if Martin had given it.
- **Read:** exit 0 (or 1 for a text with no option inside the wording); stdout
  says `mc: the reader answered <key> — continue with: <option text>` (with
  `why:` when the key is not the recommendation), or names the desk item, or the
  defect. LOG.md gets the question, the options, what jev read and the answer.
  The stage and status are unchanged except for a defect, which sets the goal to
  Martin as `mc goal defect` does.
- **Unread:** exit 0; stdout says `mc: decided by the session, unread (<why>) —
  continue with: <option text>`. LOG.md says `Decided by the session, unread`
  with the reason, and the ledger row has `outcome: "decided"`, `answered_by:
  "session"` and `unread_reason`. Every unread row opens a desk item.
- **Reserved:** the goal is set to `Martin` and the call exits 1; the entry
  records the question, options, recommendation and the act. Nothing is sent.

## The ledger

Every call that passes validation appends one JSON line to
`<mc home>/jev/decisions.jsonl` (`mcHome`: `MC_HOME`, else
`~/.memoro/mc`): `at`, `verb` (`ask`), `programme` (or null), `goal` (or null),
`tool`, `role`, `question`, `options`, `recommend`, `kind` (null: the flag is
not read; old rows hold `technical` or `product`), `reserved`, `documents` (the
paths sent), `trimmed` (each part cut), `state_length`, `state_sha256`, `model`
(the response's model id), `answers` (`answer` with choice, probabilities and
confidence; `fits`; `settled`, `product`), `answered_by`, `outcome`, `chosen`
(the option key the caller continues with, or null) and `reason`. No key and no
state body go there. A ledger that cannot be written is a warning, never a
failure.

- `answered_by` says who answered: `jev`, `reader`, `session` (nothing read it;
  the session's own recommendation) or `martin` (a reserved act).
- `outcome` is `answered` (jev), `read` (the reader chose an option), `defect`
  (the reader found a goal defect), `text` (a text of Martin's would change),
  `decided` (unread, by the session) or `reserved`.
- A reader row also carries `reader` (`tool`, `model`, and the `key` with its
  `why`, the `part` and `found` of a defect, or the `inside` key and the `text`),
  and a `text` row carries `desk_item` and `other_goal` (the item was already
  asked by that goal). An unread row carries `unread_reason`, and the `reader`
  when one was started.
- Old rows have no `answered_by`. `rowAnswer` in `src/mc/jev.js` reads them: an
  old `answered` row is jev's, with the choice in `answers`; an old `decided`
  row is the session's, with the recommendation as the choice; an old `martin`
  row is Martin's. Nothing rewrites them, and `mc decisions` and the desk read
  old and new rows through it.

## Tests

No test or gate run makes a live jev request: the transport, its timers, the
keys source and the ledger are injected through `deps`
(`tests/mc/jev.test.js`, `tests/mc/commands/ask.test.js`), and the real
transport refuses to run under the Node test runner. The reader is injected the
same way (`tests/mc/ask-reader.test.js`): no test starts a model, and none makes
a git call (the copy takes an injected `git`); the copy is proved against real
Git by a probe that is run and not committed. Drift in TypeSafe's real
response shape is not covered by acceptance; plan runs a live smoke call
after landing.

## `mc decisions`

`mc decisions [--since <date>] [--programme <programme>] [--json]` reads only
the ledger; it makes no model or network request and writes no file, including
invocation logs (the explicit exception in [mc-log.md](mc-log.md)). By default
it lists the `decided`, `answered`, `read`, `text` and `defect` rows from the
last seven days; `--since` (YYYY-MM-DD) and `--programme` narrow the set. Rows
are newest first and show time, programme/goal, who answered (`answered_by`),
one-line question, chosen key and option text (or `found a goal defect`), and the
reading. A choice that is not the recommendation is marked `not the
recommendation`, and one that differs from jev's is marked `jev preferred
<key>`. An unread row is marked `UNREAD`. Rows a person is to notice (unread,
not the recommendation, and `decided` rows with a product reading of `0.70` or
higher, marked `jev read this as a product choice`) are listed first. An
unparseable line is named on stderr and skipped. `--json` returns the same rows
as data. An absent ledger says there is nothing to report and exits 0.

The desk (`syncHeld`, [mc-martin.md](mc-martin.md)) opens a `decision:<at>` item
for each new row whose chosen key differs from the recommendation and for every
unread row, so Martin can overturn an answer there; an answer he overturns is
treated as any desk decision. Not here yet: calibrating the thresholds against
Martin's answers.
