# Changelog

All notable changes to `memoro-cli` are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The PM round checks that every order line reached its track (D-0170). A
  track stood blocked one day, unable to build G5, while the order —
  verbatim, complete, with its negative test — sat under `Rad till spår 3:`
  in an msr-design report in PM's inbox archive; the convention held, the
  channel broke. Every pass, deterministically and with no model: for each
  `RAD TILL SPÅR N:` line (any casing, quoted or bare) in an archived
  msr-design report, the order's own text — whitespace-normalised, first
  sixty characters — must appear somewhere in `msr-track-N`'s `inbox/` or
  its `archive/`. Quiet when everything is delivered; otherwise the knock
  opens with one line per undelivered order (source file, minute, first
  eighty characters), under the round's own wake-on-change rule — a new
  miss knocks now, a standing one earns one reminder on the third pass. A
  track that does not exist is said as that, never as delivered.
  Deliberately not generalised: `msr-design → msr-track-N` is the only
  channel with this form today, and a second channel is a second order.

### Added
- `mc repo merge <repo> <pr> <pr>...` — several pull requests in one round
  (A3). Measured 2026-08-23: three PRs in a row took three rounds of
  4m20s–5m39s and held the suite lease for ~16 minutes while two tracks
  were refused it and a third waited; with eleven PRs queued the round, not
  the computation, was the bottleneck. A batch is one candidate — the base
  with every head merged in, in the order given — the full suite once on
  each side, and **each pull request's own tests still run by themselves**
  (`origin/<base>...<head>`), so the batch never hides which PR carried
  which test. Green: each lands in order, the base re-read between merges
  and required to be exactly the commit this round just made (read from the
  forge's `mergeCommit`, so a stranger's merge in the gap stops the rest
  rather than being booked as ours). A batch that stops — a conflict among
  them, a red, one PR's own tests — falls back to one round per pull
  request inside the same lease and says it is doing so; the report keeps
  the batch verdict beside the single rounds, and the merge log gets one
  line per landed PR naming the batch. Two different bases refuse to be one
  candidate. And every round now prints wall clock per step — fetch,
  prepare, both suites, PR tests, extra gates (A5) — so the next
  efficiency decision is measured, not guessed.

### Fixed
- PM's wake holds: the watcher runs the code on disk, and a stranded notice
  is finished rather than waited on. Measured 2026-08-23: `mc watch pm` had
  been started thirteen minutes *before* the fix for the prompt it could not
  find (#364) and ran the old code for a day — 188 knocks tried, none
  landed, 154 *could not find its prompt*, and the board read *alive*. On
  current code a second gap stood behind the first: a wake had typed its
  notice into PM's busy pane and given up before Enter, and every wake after
  it probed the box, found real text, and queued itself behind mc's own
  sentence — 75 minutes, four tracks standing. Three changes, each
  measured live: (1) both watchers carry the stamp of the source tree they
  started from, look at it between passes, and restart themselves on the
  new code when it moves (29 s from the edit to the new pid); `mc watch
  <leg> status` and the `mc status` watch row say *OLD CODE* for a process
  behind the tree, and which kind — one that restarts itself, or one started
  before the check existed that needs `stop && start` once. (2) Text in a
  box shaped like an mc notice — any sender, any wording — is mc's own knock
  stopped halfway, not a person's draft: the wake presses Enter on it and
  types nothing (Enter on the stranded notice → PM read its inbox within the
  minute). (3) *Press up to edit queued messages* in the box of a busy pane
  is the turn's receipt, reported `queued`, not *the notice left the prompt
  without becoming a turn*. (4) A notice typed into a busy pane that never
  drew it within the wait gets its Enter anyway rather than being left
  standing — the box was probed empty before typing, so Enter submits the
  notice or lands in an empty box — and the second submit try is `C-m`,
  the other spelling of the same key, named in the result when it was the
  one that worked. (5) A submitted line gets several looks (up to 2.4 s)
  before the next key: measured on PM's idle pane, the notice was still
  drawn 600 ms after Enter and a turn by the next look, so one look at
  400 ms read "still there", pressed again, and cleared a line that was on
  its way — the *it stayed in the prompt* three panes reported that
  evening.

### Added
- `mc work <name>` refuses a workplace somebody is already sitting in
  (D-0154). The repo lease protects the merge queue and says nothing about
  who is in a worktree: a session started in an area whose worktree belonged
  to a person's own session — from their terminal, invisible to mc's
  background naming — switched the branch under them mid-work. Opening an
  area now asks which tool processes stand in it or its worktrees, the way
  the status board finds them, and one mc did not start there is an
  occupant: *alpha is occupied — claude (pid 4242) is working in …, started
  outside mc*, with the way through named. `--anyway` is that way, for the
  person who knows the workplace is theirs to share. mc's own background
  session is not an occupant — `mc work <name>` joins it and `new` replaces
  it in place, as before. A clean `git status` was never "free"; now the
  question is asked of the processes rather than of the tree.
- A session started outside mc's naming is found by where it stands
  (D-0136 point 2). Nine sessions ran in tmux sessions called `clean`,
  `ops`, `vocab`, … and every `mc work send --wake` to them delivered the
  file, never knocked, and reported *nothing is running* — while they ran.
  When `mc-<name>` does not exist, mc now asks tmux where every pane stands:
  one whose current path is the area or under it is the area's address (the
  session's name when it is alone there, the pane id otherwise), for the
  wake, for `mc work <name>` (which says *running in tmux ops, started
  outside mc and found by where it stands*) and for the session guard. No
  bind file, nothing to keep in step. What is left unaddressable is a tool
  with no pane at all, and that is said as what it is — *claude (pid N) is
  running in <name> outside tmux — mc has no pane to knock on* — never as
  nothing running.

- **A wake refused on a draft is queued, not dropped — and the session shows
  as unreachable until it lands.** The guard was right to refuse (the draft is
  somebody's), but the consequence was a session nobody could reach: the
  answer sat in its inbox for twenty minutes, nothing told it to read, and
  reaching it by hand cleared the draft the guard existed to protect
  (2026-08-22, Martin's order). Now `mc work send --wake` on a real draft
  says *queued — a draft is in <name>'s prompt, so nothing was typed; it will
  be knocked when the prompt clears* (`--json`: `queued`, `since`), the entry
  lives in `<mc home>/watch/pending-wakes.json`, the session guard's round
  tries it first every time, a knock that lands on its own forgets it, and a
  target that stopped is dropped (the file is still in the inbox). `mc
  status` writes *✉ draft in prompt — unreachable by wake since 21:14 (wake
  queued; it lands when the prompt clears)* under the area, in red, so the
  state is on the board and not in one sender's scrollback. There is no
  `--anyway` for this one, deliberately: typing into a draft and pressing
  Enter *sends the draft*, and a flag that did that would be the harm with a
  name.
- `mc work <name>` joins what is running instead of asking which of four
  conversations — a question mc cannot answer either (D-0100) — and then
  refusing the pick as #361 requires; a person stood outside a live session
  that way with an answer waiting in its inbox. `mc work` marks a running
  area (*● running as mc-<name> — mc work <name> joins it*) and the
  conversation a transcript written in the last two minutes says is live.

### Changed
- **The test gate no longer says `GREEN` over standing red names.** The rule it
  enforces is differential — nothing new went red — and on this repository,
  which carries 55 red names on `main`, the verdict printed `GREEN` anyway.
  That word is what every merge decision gets reported onward with, and it was
  reported as the larger claim it sounds like for a week. The differential
  logic is untouched; the word was the defect. A base with no red names still
  reads `GREEN — the test gate passes`, unchanged. A base with red names never
  uses the word: `NO NEW RED — 55 standing red names on main`, followed by what
  those names actually cost — a test that is already failing cannot fail any
  harder, so a fault introduced inside one of them has nowhere to appear. They
  are 55 blind spots, not only 55 items of debt. `--json` gains `standing_red`
  and a `verdict` of `green` / `no-new-red` / `red` / `ratchet-risen` /
  `stopped`, the two passes kept as separate words so a reader who wanted the
  strict one can still ask for it. The merge round narrates the same statement
  rather than a friendlier one, and the merge log row reads
  `55 standing red before`.

### Added
- **The suite right is a lease, and the suites that actually run are on the
  board** (D-0141, D-0155). One full suite at a time on eight gigabytes was a
  rule handed out in messages and hoped for; one session ran the contract
  suite eleven times on a clock nobody saw. `mc suite claim "<what for>"`,
  `mc suite release [--force]` and `mc suite who` are the machine-wide
  counterpart of the repository lease — advisory, refusing a second claim and
  blocking no process, every change of hands logged. The gate round takes the
  right before either suite run and gives it back after, and stops in the
  other holder's favour (`suite-lease`) when it is held; a holder who claimed
  by hand before the round keeps it after. `mc status` carries a `suite` row
  under the header: who holds the right, and every `node --test` / `npm test`
  process standing in any work area right now, with how long it has run
  (`ps etime`) — because seventy minutes on this machine means contention and
  seven means solo, and a suite nobody claimed is a row rather than a slow
  machine. `--json` carries it as `suite: { lease, running }`.
- memoro's built-in gate declaration is the measured one (D-0089: `prepare:
  npm ci`, the contract gate, the PM's merge log) instead of `UNKNOWN` beside
  an operator override that knew. Two places answered one question about one
  repository, and mc's own reading of itself quoted the stale half.
- **`.mc/red-ratchet.json` — the standing red set, recorded so it can only get
  smaller.** Inside a single round the differential rule already catches every
  rise, including a brand new test that is born red: absent from the baseline
  is the strongest possible way of not being in it, so it lands in `broke` and
  the round is red. The hole is *between* rounds. Every round measures `main`
  afresh and remembers nothing, so a red name that reaches `main` by a path no
  gate stood in becomes part of the next baseline and is reported as "no new
  red" over it from then on. That is how 55 accumulated. The floor now lives in
  the repository, in the diff: a red name that is not in its `names` fails the
  round, the same class as a new red name. It binds **names, not a count** —
  two rounds hours apart here gave 55 and then 56, the extra one green again
  after that, so a count ratchet would fail good pull requests whenever the
  machine was busy, and a gate that fails at random is worse than the word it
  was built to correct. Nothing writes the file automatically, including the
  merge round: evicting a name on a lucky round lays a trap for the next
  author. The round prints exactly which names came good, JSON-quoted, so
  lowering it is a paste. A repository with no ratchet behaves exactly as
  before; one whose ratchet will not parse stops the round rather than reading
  as an empty floor and failing everything on a typo.
- `mc repo merge` says what it merged **into**, every time. A round on a
  stacked pull request said *merged as 7dcbf96* — true, and into its base
  branch `pm-heartbeat`, which everyone including PM read as main; the fix
  had to be re-landed. The progress line, the verb's output and the merge
  log line now name the base (`merged #363 into pm-heartbeat as 7dcbf96`,
  `Squash-merge into \`pm-heartbeat\` → …`), and when that base is not the
  branch the remote points HEAD at, a warning says so in its own words:
  *this landed on a branch, not on main*. A default git cannot name is
  reported as unknown, never assumed — a guess would be the very assumption
  the warning exists to catch. The report carries `merged_into`,
  `default_branch` and `off_default`. Nothing is blocked: a stacked merge is
  sometimes meant, and the round's job is to make it impossible to misread.
- The gate runs the pull request's own tests (D-0157). The suite answers
  "did anything else break?"; it had never answered "is this change
  proved?" — `test:msr:contract` globs some directories and not others, and
  #10803's tests lived in `tests/ui/`, one it does not glob: the same count
  as the day before, with 114 new test lines. Now every `*.test.js` (`.mjs`,
  `.cjs`) the PR adds or changes, wherever it lies, is run on the candidate
  after the suite, from the same diff that counts red — no directory list,
  which would fix yesterday's hole and make tomorrow's. Held to the suite's
  own rule: a run that never summarised or summarised nothing is a stop, and
  one red among them stops the round with the whole suite green
  (`pr-tests`). A PR that touches no test file is recorded as `files: []`
  and said in the progress, never left blank. The files run with the flags
  the repository's own `test` script gives node (`--import`, `--require`,
  `--conditions`) and without its globs. The report carries `pr_tests`:
  files, totals, red, exit code. This does not replace the contract suite
  and does not make it differential — D-0138 stands on its own.
- `mc status` shows the clock a session set for itself (D-0155). A Claude
  conversation can schedule its own next turn — `ScheduleWakeup`, a prompt
  and a delay — and nothing outside its transcript knew: one session ran the
  full contract suite eleven times that way, on an eight-gigabyte machine,
  with the suite right held by another area, and its pane looked idle the
  whole time. The board now reads the last `ScheduleWakeup` in the
  transcript's tail: set and not stopped and not yet rung, it is a row under
  the conversation — `⏰ wakeup in 9m: npm run test:msr:contract` — in
  yellow, overdue ones included, since a clock that was set and a session
  that is gone is its own finding. `--json` carries it as `wakeup`
  (`prompt`, `delay_s`, `set_at`, `due_at`, `reason`). A `stop` clears it;
  the prompt arriving as a user turn means it rang. Read against the
  eleven-run transcript: the clock before its stop, null after, eleven rings.
- A suite is not believed in a worktree without its dependency tree (D-0152).
  Run there it does not fail, it shrinks: 2162 tests and a tidy number, where
  206 never ran and were not counted as skipped; 2368/2368 once the tree was
  linked. The gate round now checks, after preparation and before either
  run, that a manifest declaring dependencies has a `node_modules` to be found
  in, and **stops** with `dependencies` if not — unless the declaration vouches
  (`prepare: null`, with its evidence) that the suite runs without one, in
  which case the round says so in its progress rather than assuming. And
  `mc status` writes `no node_modules` beside a worktree whose manifest
  declares dependencies and has no tree (a `dependencies` field on the page:
  `missing`, `present`, or null where the question does not arise), so the
  state PM measured by hand across twenty-seven worktrees is on the board.
  What mc cannot do is refuse a suite a session starts itself in its own
  worktree; that preflight belongs to the repository's own test script.
- The PM heartbeat wakes PM (D-0013). Two things stood between a report in
  `pm/inbox/` and PM reading it: the wake guard's first rule refused every
  knock on a pane a client is attached to — and PM's pane is attached by
  design, so every round of `mc watch pm` ended in *delivered, but did not
  knock: somebody is attached to it* — and the round itself ran on a
  thirty-minute clock, so a report landing a minute after a round waited
  twenty-nine. Now a singleton role's pane (`pm`, `pm-helper`) is knocked
  with a client attached; the exception is the role, never the sender, and
  the empty-prompt rule still guards whatever the person has typed. And the
  round's wait ends at a new file in the inbox: the file is what wakes the
  round, the half hour is the floor. A loop asked for N rounds also stops
  after the Nth instead of sleeping one more interval first.
- The wake guard no longer decides prompt-emptiness from the drawing (D-0151).
  A pane can show an order after the prompt mark that was carried out long
  ago — redrawn from an old frame, back again after `C-u` — and the guard read
  it as somebody's draft: *delivered, but did not knock: there is already
  something in its prompt*, for a day, on three panes that were empty and
  ready, while the fleet was booked as waiting on a person who had typed
  nothing. Text in the box is now a question put to the input: one character
  typed, the row read back, the character deleted. A row that became the
  character alone was empty and is knocked; a row that kept its text is a
  real draft, refused as before and left exactly as it was; a probe never
  drawn claims nothing, in its own words. Measured by hand on three live
  panes before building and again after. Also: the box is found under up to
  ten trailing rows instead of three — PM's pane carries a status line, a
  `/rc active` row, a ledger row and a row per running agent, and the old
  tolerance answered every knock with *could not find its prompt*.
- `mc pm new` and `mc pm-helper new` — a reliable way to start a **fresh**
  conversation in a singleton role. Every door into the role meant "take me to
  the PM": attach if it runs, resume the newest if it stopped, create if it
  never existed. There was no way to say *start over*, so the role with the
  longest life of all was the one role that could not perform a continuity
  handoff — it respawned its own window by hand, `mc pm` resumed as it always
  does, and nothing said the handoff had not happened. The verb is `new`
  because `mc work <name> new` already means exactly this. What is running is
  ended and replaced **in the same tmux window**, so anyone attached stays
  attached and watches the successor boot; killing and recreating the session
  would throw them out, and the case this exists for is the person sitting in
  the pane. From outside the role's session the tool is asked to leave by its
  own `/exit` first, so Claude's SessionEnd hooks run; from inside it — the PM
  handing itself off, the normal case — the caller cannot outlive its own exit,
  so the replacement is abrupt and the turn in flight is lost. mc says which of
  the two happened and writes it to the log. `--model` is allowed and chooses
  the successor's tier; without it, the role's default, never the predecessor's.
  **Nothing is deleted**: the predecessor's transcript stays on disk, and the
  successor is started with one factual line naming the id and the command that
  reaches it.
- `mc pm <conversation id>` / `mc pm-helper <conversation id>` — one particular
  conversation in the role's home, by id prefix, in the same grammar as
  `mc work <name> <id>`. Without it a handoff is one-way: the singleton could
  only resume the *newest* conversation, which after a handoff is the
  successor, so the predecessor became unreachable through mc the moment it
  existed. An id that matches nothing is an error naming where to look — never
  a new conversation with the id as its opening words. While the role is
  running it refuses rather than quietly attaching to the other conversation.

### Fixed
- `mc work <name> <id>` no longer joins whatever is running instead of the
  conversation it was given. It attached, silently: the background branch never
  looked at the id, so the user landed in some other conversation and nothing
  from the outside said so — the last of the four D-0100 datapoints. It now
  refuses, and names both ways on: join what is running (`mc work <name>`), or
  stop it and open the one asked for. mc does not guess whether the running
  session happens to hold that conversation — it stores nothing, and a session
  started fresh names no id anywhere — so it says that rather than pretending
  to know. An id matching nothing in the area is still its own error, before
  anything else is said. `--resume <id>` is the same request and gets the same
  answer.
- `mc work <name> new` no longer ignores `new` when that work is running in the
  background. It printed *joining …* and attached: the background branch
  returned before the choice was ever read, so a stated choice passed and the
  tool did its own thing, without an error. One rule now, in both places:
  **new means a new conversation, whatever is running** — ended and replaced in
  the same window, politely from outside and abruptly from inside, exactly as
  the role door does it. `--model` is accepted there too, because a new
  conversation can take one; joining a live conversation with `--model` is
  still refused.

### Removed
- `mc supervisor` — replaced outright by `mc pm`, no transition alias. The
  singleton shape it established (one named workspace, no worktree,
  resume-or-create, attach rather than duplicate) lives on in `mc pm` /
  `mc pm-helper`, with the role text in the role catalogue instead of the
  code and the conversation always in tmux. The auth bypass for the removed
  command's argv is gone with it; the cloud-runtime subsystem's scoped
  supervisor device-flow (server API paths, token account) is a separate
  surface and is untouched.

### Fixed
- `mc work <name> --tmux` can now resume a named conversation, with
  `--resume <id>`. It could not before: under `--tmux` the whole rest of the
  line was read as the task, so an id typed there became a *new* conversation's
  opening words — and it looked like it had worked. The resume machinery was
  never missing; `startInBackground` has taken a conversation since the
  singleton roles needed it, which is why `mc pm` resumes fine. Two things kept
  an id from reaching it, and both are fixed. An id matching nothing is now an
  error before anything is started, rather than a new conversation quietly
  standing in for the one that was asked for. `--resume` works without `--tmux`
  too, alongside the positional form, and a task given with a resume reaches
  that conversation instead of opening a new one. `--tmux` without `--resume`
  still reads the rest of the line as the task, unchanged and asserted.

### Changed
- The gate round now reads a per-repository declaration: what to run before the
  suite can be believed, which gates beyond the suite are required, and where
  merges are logged. `<mc home>/repo-gates.json` adds or overrides an entry
  without a release. A repository mc has not been told about **stops the
  round**, with a reason naming the file and the shape to write — the only
  exception being one that can be proved not to need preparation, because its
  manifest asks for nothing. The heuristic "it has dependencies, so install
  them" is deliberately not used: this repository declares three dependencies,
  one of them native, and its suite runs from a clean worktree. Gates beyond
  the suite are held to the suite's own rule — one that did not reach its own
  end is not an approval, and one that could not be run at all stops the round.
  Behaviour for `memoro-cli` is unchanged: it declares that it needs no
  preparation, with the evidence for that claim written beside it. A
  declaration can also say `UNKNOWN` for a part it does not know — memoro's
  extra gate is known and ordered, its preparation step is not — and a partly
  declared repository stops exactly as hard as an undeclared one, because
  "partly declared" must never become a way to run anyway.

- The merge log line records the decision class as `D (delegerad)` rather than
  a class of the verb's own invention. A verb has no authority of its own — it
  carries out its holder's — and the log is the document that shows who allowed
  what, so a class that is not in the decision matrix breaks the chain. The
  machine's part is in the note, where it says who ran it and as whom.

- `mc repo merge <repo> <pr>` now lands the change when the gate is green:
  squash-merge, a `git pull` in the source-linked installation, and one line in
  the merge log. `--check` keeps the old behaviour of gating and stopping, and
  there is no third mode — nothing merges a gate the round called red, not
  behind a flag and not behind an option. The merge lives in its own module on
  top of the gate, which still cannot merge at all. One lease is held across
  the whole round rather than around each half, and two things are re-checked
  between the verdict and the merge: that `origin/<base>` is still the commit
  the baseline was measured at, and that the lease is still ours. A deploy pull
  that fails does not fail the round or undo the merge — it is reported so the
  machine can be pulled by hand.

- `mc work send --wake` now claims a wake only when the notice appears above
  the input box as a turn the conversation took — one more time than before mc
  typed. An empty box is no longer accepted on its own: a line cleared with
  Escape inside the submit window leaves it exactly as empty as a line that
  went in, and that was the last way left to report a wake without evidence.
  Measured against a real idle pane before the rule was tightened — three runs,
  sampling every 50ms: the turn appears above the box 480–520ms after the
  notice lands and stays visible for twenty seconds, while mc looks 400ms after
  Enter. The count is taken over the joined rows rather than row by row,
  because a turn is the notice plus a mark and so is wider than the notice —
  a narrower pane wraps it, and a row-by-row match would have turned every wake
  in a narrow pane into a reported failure.

### Added
- Lease liveness — `mc repo who`, the status view's lease section and a refused
  `mc repo claim` now say whether the holder is still working, not only how
  long it has held the lease. Age answers the wrong question: a gate round
  *should* take half an hour and a forgotten lease can be two minutes old, so
  no threshold separates them — a real lease reading `grindvarv #344` stood 27
  minutes with a silent holder and came within minutes of being force-released
  out from under a running round. The fact is derived from the board, which
  already reads every area's processes and transcripts at the moment of asking:
  no heartbeat, no new file, no clock, no TTL and no expiry. A heartbeat would
  have failed hardest in the case it was built for, since it needs the holder
  to run mc at intervals and the deadest-looking lease is the one whose holder
  is ten minutes into a suite run. A holder mc cannot see — `user@host`, or an
  area no longer on the board — reads `liveness unknown` with the reason, never
  a blank and never a guess. Nothing blocks `--force`, which behaves exactly as
  it did.

- `mc repo merge <repo> <pr> --check` — the verify half of the gate round as a
  machine rather than as an instruction somebody follows. It takes the
  repository's lease, builds two throwaway detached worktrees under
  `<mc home>/gate/` (the baseline at the pull request's base branch, the
  candidate at its head with the current base merged in), runs the
  repository's own `npm test` on both in the same round, and compares the two
  red sets by name at every level — subtests included, because a total can
  match while the contents have swapped. Names red on the candidate and green
  on the baseline stop the round; `TODO` and `SKIP` never do; and a run that
  never reached its own summary stops it too, so two suites that both died the
  same way cannot read as a confident green. The lease is released in a
  `finally`, and `--json` carries the red sets, the difference, both commits
  and the stop reason for a surface that reports onward without reading prose.
  `--check` is compulsory: there is no merge in this verb yet, not behind a
  flag either, and its verdict is "the test gate passes", never "approved".

- `mc pm` and `mc pm-helper` — the singleton roles' one door each, grown out
  of `mc supervisor`: attach if it runs (the conversation lives in tmux, so
  a second `mc pm` joins the first instead of forking the transcript),
  restart in the role home if it stopped (resuming the newest conversation
  on the model its transcript records), create it the first time. Creation
  bootstraps the role home layout — `pm/` with `state.md`, `inbox/`,
  `queues/`, `decisions/`, `digests/`, `handoff/`; `pm-helper/` with
  `sweeps/`, `underlag/`, `memoro-mirror/`, `logs/` — each directory carrying
  a README marker, and the PM home is `git init`-ed with a first commit; the
  layout is re-completed idempotently on every start. No worktrees, ever:
  role homes list none, and their filing directories no longer masquerade as
  repositories on the status board. Claude-only, per the role design.
- Roles are first-class: a role is a file (frontmatter for mc — default
  model, singleton, tools — and overlay text for the conversation) that sits
  on a work area. `mc worker <name>` creates a project folder carrying the
  worker role; every conversation started in it — `mc work <name> new`,
  `--tmux`, lead or agent — inherits the role's overlay behind the Coding
  Profile (Claude conversations only, for now) and the role's model default
  under any explicit `--model`. `mc roles list`/`mc roles show <role>` read
  the catalogue (`MC_ROLES_DIR`, else `<mc home>/roles`). The names `pm`,
  `pm-helper`, and `helper` are reserved for the role workspaces and refused
  by `mc new`, `mc rename`, `mc work`, and `mc worker` with a pointer to the
  role's own command. Ordinary areas are untouched: no mark, no overlay, no
  default — launches are byte-for-byte what they were.
- `mc work <name> new --model <model>` (and the same flag when opening or
  resuming a conversation, including `--tmux`) starts the tool on a chosen
  model — passed through as given, `--model` for Claude and `-m` for Codex;
  the tool remains the authority on model names. The model is a property of
  the conversation: resuming reads what the conversation last ran on from its
  own transcript and passes it again, so a restart lands where the
  conversation was rather than wherever the tool's default has moved.
  `mc status` shows the model per conversation.
- `mc new` now mints the native session id at launch for tools that accept one
  (Claude Code via `--session-id`) and records it in the registry on the launch
  commit. Claude sessions are resumable by `mc open` from their first moment,
  with no dependence on post-hoc transcript discovery.
- `mc end` distills the session transcript (foreground upload) before deleting
  it. A failed upload aborts that target with everything intact; `--no-distill`
  opts out explicitly.
- `mc end` self-heals the `registry-live-without-local-broker` deadlock inline:
  when broker cleanup reports the broker unavailable for a live-marked row, the
  scoped storage repair (socket-probe liveness, mark-idle only) runs as part of
  the teardown instead of requiring a separate `mc storage repair --apply`.

### Fixed
- `mc end` no longer strands the rest of a batch when one target fails;
  every target is attempted and reported independently.
- Managed `mc end` teardown confirms credential cleanup through the provider
  artifact journal (previously unmerged fix).
- `mc security claude-c1 <session>` runs the pinned, broker-owned managed
  Claude credential-boundary gate only after every local provider has exited.
  The fixed vault lease passes the Claude access token through an anonymous
  descriptor to a short-lived trusted runtime; the sandboxed Claude executor
  receives only a revocable sentinel, and the command returns status only. Each
  CLI installation gets a private generation receipt, so C1 requires a later
  clean boot after upgrades, downgrades, and same-version reinstalls.
- `mc dev list|status|logs|stop|restart` provides a machine-local development
  server inventory backed by project-owned manifests. Controls require matching
  manifest, worktree, and process-group identity; `mc status` and `mc doctor`
  now surface unhealthy and orphaned dev services.
- `mc setup` now offers opt-in local image/motion resource profiles. The
  default remains unlimited; balanced, conservative, and custom profiles add
  cross-session concurrency, compute-thread, disk/swap, background-scheduling,
  and process-tree memory safeguards for recognised local Python workloads.
- `mc cloud-runtime run` now restores the latest coding-bin snapshot before
  provider launch and captures/uploads a filtered snapshot when a cloud runtime
  goes to sleep.
- Cloud runtime status now exposes broker readiness, coding-bin snapshot state,
  and pending/ready/sleeping phase semantics through the shared runtime
  contract.
- `mc tool-auth hydrate|persist` and the runtime persist watcher support cloud
  tool login state without exposing secret payloads to the LLM session.
- `mc vault bind <label> <ENV_KEY>` attaches existing vault secrets to a repo
  without re-entering values, and `mc vault bindings` shows the repo's
  value-free materialisation map.
- `npm run smoke:mc` runs a release/global-install smoke gate against a selected
  `mc` binary, checking Codex defaults, help text, tool-switch dry-run,
  no-launch session creation, explicit Claude resume, and fanout defaults in an
  isolated temp repo.
- `mc status --json` and `mc auth status --json` now expose an
  `effective_config` object with source metadata for package defaults, global
  config, repo policy, repo-local config, and session policy. This is
  visibility-only groundwork for policy-driven repo customization.
- Coordinator sessions now have an in-session MEMORO.md reconciliation habit:
  `/mc map` is the user-facing command across tools. Claude Code gets a
  managed `/mc` command that handles `map`, while grounding teaches other
  tools the same convention. The flow is a concise in-session prompt; it does
  not add a terminal `mc map` command or auto-edit the map.

### Changed

- `mc work send` no longer wakes the recipient's conversation as a matter of
  course: the file goes into `inbox/` and the knock is asked for with `--wake`.
  Waking types into an input box that belongs to somebody else, so it now
  refuses on a pane a tmux client is attached to, and on a pane whose box is
  not visibly empty — anybody's draft, and equally a notice an earlier wake
  gave up on, which is what used to be pasted onto and submitted as one
  sentence. The `C-u` that takes an unsent notice back out is pressed only on a
  line mc has just read and can prove holds nothing but its own notice;
  otherwise the line is left alone and the sender is told it was. Every
  refusal is printed with the reason, and carried in `--json` as `guard` and
  `left`. The notice itself is now ASCII, so comparing the box against it
  cannot be defeated by a pane that re-encodes non-ASCII characters.

- `mc end` now shows one compact session/worktree/branch/provider-artifact
  status and asks once before permanent teardown. Confirmed or automation-
  consented teardown removes exact ID-verified Codex/Claude transcripts and
  auxiliary paths, broker/runtime sidecars, vault materialisation, dirty
  worktrees, local branches, and registry state, then fails if any contracted
  artifact remains. Shared provider databases/history/memory/config are never
  mutated; `--keep-branch` is the explicit exception.

### Fixed
- Managed local Codex sessions now reuse the operating-system account's npm
  cache, so the isolated executor home no longer causes avoidable registry
  downloads during `npm ci`; npm credentials remain outside the executor.
- Broker-owned Codex launches now retry twice when Codex exits during startup
  with its specific transient SQLite state/log database lock error. Other
  startup failures and established sessions are not retried.
- Coding-bin snapshots preserve deletions through a snapshot manifest and filter
  token-bearing argv/environment paths before upload.
- Broker connection readiness now handles pretty-printed JSON payloads from the
  cloud broker connect command.
- Fresh mc installs now default to Codex instead of falling through to Claude,
  including `mc new`, bare `mc`, `mc setup`, and status policy reporting.
- Fanout sessions and raw registry upserts now use the shared package default
  tool instead of hardcoding Claude in fallback paths.
- Broker sidecars now fall back to the selected/default tool source instead of
  labeling partial launch payloads as Claude Code by default.
- mc now repairs inherited headless terminal env (`TERM=dumb`, `NO_COLOR`) before
  launching interactive PTYs, so broker-owned Codex sessions can render their
  native styled input/footer instead of a plain downgraded TUI.
- Codex sessions launched by `mc` now get a guarded PATH that blocks direct
  Cloudflare Wrangler data-access commands (`d1 execute`, R2 object access,
  KV reads, tail, secrets, and similar). Repo-approved admin scripts can be
  declared through `dataAccess.cloudflare.approvedScripts` in `.mc/policy.json`
  instead of being hardcoded in the package.

### Fixed
- `mc repo merge` no longer says *nothing was merged* after a merge call
  that failed on the network. On #10844 GitHub took the call, performed the
  squash, and timed out on the reply; the round reported *nothing was
  merged* and the change was on `main`. A failed call is now followed by a
  question to the forge: `MERGED` → the round carries on as merged, with the
  error kept beside it (`merge_error`) and said in the progress; `OPEN` →
  the failed merge it always was; cannot ask → the round stops at
  `merge-unknown`, claims neither way, pulls and logs nothing, and names
  the command that answers (*check with gh pr view <n>*). The verb prints
  *whether #N merged is UNKNOWN — …* for that stop instead of the sentence
  that was once false. A reason says what was measured, not what was
  inferred — here in the direction of claiming nothing happened.

## [0.7.6] — 2026-06-06

### Added
- `mc spawn <name> "<brief>"` creates an idle, durable project session
  with its own worktree/branch, `.mc/brief.md`, parent coordinator,
  focus, and optional `MEMORO.md` node metadata.
- `mc list --tree` shows parent/child session fabric so coordinator and
  project sessions are visible together.
- `mc status <name>` now reports effective policy visibility: selected
  tool, permission profile source, whether vault materialisation is
  expected, and whether native auth remains owned by the tool.
- Vault secret payloads now support explicit native-auth target metadata
  (`target_tool`, `target_auth_mode`, `target_location`). Provider-only
  OpenAI secrets still do not materialise into Codex; an explicit Codex
  target is required.
- Effective policy visibility now honours permission profile precedence:
  session registry policy, then `.mc/policy.json` in the worktree, then
  global mc config, then defaults.
- `mc status` now labels permission profile fields unsupported per adapter
  until mc has explicit, reversible renderer support for that tool.
- `mc auth status` now includes the same effective policy/secrets report per
  tool, including native-auth ownership, vault targets, repo policy precedence,
  and unsupported permission fields.
- Codex launches now render explicit mc permission policy into launch args for
  `workspace` (`--sandbox`) and `approval` (`--ask-for-approval`). Default
  policy placeholders render no flags, so native Codex behavior stays unchanged
  unless the user configures policy. mc never renders Codex full-access mode.
- `mc vault scan` and `mc vault import <dotenv-file>` migrate existing `.env`
  / `.dev.vars` secrets into the encrypted vault without printing values.
  Imports create deterministic labels, skip duplicate source keys, skip existing
  vault labels by default, and persist value-free repo bindings in
  `.mc/secrets.json`.
- `mc vault set <label> --bind ENV_KEY` lets manually created secrets be
  attached to the current repo. Without `--bind`, manually set secrets remain
  account-wide/global by design.
- Repo-bound dotenv secrets now materialise during session launch into managed
  blocks in the bound `.env` / `.dev.vars` file, are tracked in the session
  vault manifest, covered by the existing LLM read-blocking hook, and shredded
  by `mc end`.

### Changed
- `mc list` now separates reachable active sessions from local dead/idle
  sessions, uses clean terminal excerpt sanitisation, and supports a numbered
  picker path via `mc resume`.
- Session resume now reuses stable mc coding session IDs for named sessions,
  so a resumed session reconnects to the same tracked mc session instead of
  silently minting a new identity.
- Repo-bound vault materialisation is an allowlist: when `.mc/secrets.json`
  exists, runtime use is limited to labels bound by that repo. Provider-compatible
  global secrets are not used as fallback.

### Fixed
- `mc tool-switch codex` now persists the default tool even when adapter wrapper
  sync reports drift, so later `mc new` / bare `mc` invocations honour the
  selected default.
- JSON/non-interactive `mc vault import` no longer prompts for the master
  password when the vault is locked; it returns a structured locked-vault error.
- `mc vault import` human output no longer calls a confirmed mutation preview a
  dry-run, and `mc vault list` sizes its columns to long labels.
- `mc vault status`, `unlock`, and JSON `get` now distinguish a usable cached
  vault key from a live server session without a local decrypt key, so
  metadata reads no longer fail with a misleading generic locked-vault message.

## [0.7.5] — 2026-06-04

### Added
- `mc` now sends a real first user message into the launched coding
  session when a repo is missing `MEMORO.md`, so the file is created
  inside Claude/Codex only after user opt-in instead of being silently
  seeded out-of-band.
- `mc new`, `mc resume`, and bare `mc` share a selected-tool preflight
  path for vault startup, grounding focus, and relaunch environment.
  Bare `mc` now honours the persisted default from `mc tool-switch`.
- `mc resume <name>` accepts `--codex`, `--claude`, and `--tool <name>`
  to relaunch an existing session under a different tool after the
  current TUI has been closed.
- Wrap-mode runtime pieces are split into testable modules for startup
  decisions, local session metadata, heartbeats, dispatch socket handling,
  WebSocket command handlers, and delayed startup-message delivery.

### Changed
- `mc --help` is rewritten around the ordinary user workflow: start,
  resume, setup, secrets, fleet/advanced, and what happens on session
  start.
- Bare `mc` now refuses to start a coding session in the primary
  worktree; use `mc new <name>` for isolated work or `mc resume <name>`
  for existing session work.
- Coordinator grounding now states the three product targets explicitly:
  roadmap/end-goal awareness, orchestrator-role discipline, and
  cross-session work-project order.
- `MEMORO.md` and the fanout plan now document the sharper product
  boundary: mc is a continuity/grounding layer, not a PM system or
  agent-runner.

### Fixed
- `mc tool-switch codex --dry-run` now works in ordinary repos that have
  not materialised `docs/coding-agent-protocol.md`; it falls back to the
  coordinator canon shipped in the installed package.
- Adapter sync now treats an instruction file containing only mc grounding
  as a missing wrapper, not as hand-edited drift. This fixes grounded
  Codex sessions whose `AGENTS.md` existed before `mc adapter sync`.
- Codex session grounding no longer writes runtime state into `AGENTS.md`;
  the static adapter-sync wrapper stays clean and the grounding bundle is
  delivered as Codex's initial CLI prompt instead.
- Claude session grounding no longer writes runtime state into `CLAUDE.md`;
  the static adapter-sync wrapper stays clean and the grounding bundle is
  delivered via Claude Code's `--append-system-prompt` launch arg instead.
- Startup grounding no longer tells agents to read repo-local coordinator
  canon paths when those files are absent. Package-canon is described as
  already supplied by mc, with `mc adapter materialise` as the explicit way
  to put full canon files on disk.
- `mc resume <name>` under Codex no longer falls into Codex's native
  resume picker. mc strips the Claude-only resume signal and starts Codex
  with the grounding bundle as its initial prompt in the selected worktree.
- `mc resume` without a name now lists mc registry sessions across tools,
  so Claude-started sessions remain visible after relaunching under Codex
  or changing the default tool.
- Codex-selected sessions no longer auto-materialise generic OpenAI vault
  secrets into Codex auth. This avoids overwriting ChatGPT/Pro native
  auth with a project/API token.
- Vault startup skips unlock prompts when the selected tool has no
  matching provider target, and `mc status <name>` now shows the stored
  session tool plus the recommended relaunch command.

## [0.7.0] — 2026-06-01

### Added
- `mc vault` — encrypted secret store with full lifecycle (§12 phase
  1+2+3). Client-side AES-GCM with PBKDF2 (600k iterations); the
  server holds only ciphertext. Verbs: `init`, `unlock`, `lock`,
  `set`, `get`, `list`, `delete`, `change-password`, `destroy`,
  `status`. Phase 2 caches the unlocked key in the OS keychain so
  repeated `mc resume` doesn't reprompt; JIT materialisation writes
  decrypted tokens to disk only for the lifetime of the launched
  session (PR #47, #51). Phase 3 installs a per-session PreToolUse
  hook that blocks foreign LLMs from reading the materialised
  paths — the LLM-blindness invariant (PR #53). `mc vault` errors
  print human-readable codes in non-JSON mode (PR #48).
- `mc auth devices` — list and revoke registered devices (§14
  phase 1 client). Fresh installs auto-trigger the OAuth Device
  Flow on first command so onboarding is one less prompt
  (PR #54).

### Plan
- §14 — device-aware auth via OAuth Device Flow, with fixed 90-day
  rotation instead of sliding TTL (PRs #49, #50).
- §15 — memoro-agent as a remote Streamable-HTTP MCP endpoint on
  the Memoro Worker, exposing the existing chat orchestrator as a
  tool surface for Claude Code, Cursor, and Codex. Token enrollment
  via Pattern A (bearer in MCP config) or Pattern B (`headersHelper`
  from OS keychain). Implementation drev queued (PR #55).

### Docs
- Skill: `agent-coordination.md` gains the drev 3+4 lessons —
  honest uncertainty disclosure when verification is blocked, and
  the bounded architectural-self-upgrade pattern (PR #52). Also
  the test-only `--json` anti-pattern from PR #48.

## [0.6.0] — 2026-05-31

### Added
- `mc reconcile [--apply --only-safe] [--json]` (§9e). Detects
  sessions whose work has already shipped elsewhere and groups them
  by suggested action: `safe_to_end` (squash-phantoms — deterministic
  via cherry + content-diff), `branch_merged_recently` (gh PR head
  match within 7 days), `verify_and_end` (transcript-mention PRs that
  merged in 7 days, found by scanning the last ≤200 KB of the
  session's Claude transcript). `--apply --only-safe` acts ONLY on
  the squash-phantom bucket — the cron-safe acceptance bar
  ("can I run this on a cron and never lose work?"). `gh` calls go
  through an injectable portal so missing/expired auth soft-degrades
  to empty buckets instead of crashing. File-overlap heuristic
  category deferred to v2 (§11f.5).
- `mc setup` — non-interactive self-verifying onboarding checklist
  (§11b). Runs every probe `mc auth status` exposes and prints only
  the missing steps with exact runnable commands. Writes
  `${MC_HOME}/.setup-done-v1` when everything is green.
- `mc auth status [--json]` — single-screen health check answering
  "is mc ready to use here?" (§11a). Adapter contract codified:
  `TOOL_NAME`, `STATUS_TIMEOUT_MS`, `getStatus(opts?)` →
  `{ installed, version, authenticated, hint, detailLines }`. Hint
  invariant locked in the contract test so future tool-adders can't
  ship placeholder strings.
- `mc auth memoro [--logout|--status]` and `mc auth <claude|codex|gemini>`
  per-target helpers (§11c). `mc auth memoro` is a thin alias for
  `memoro-cli login/logout` with passthrough for unknown flags.
- `mc list --orphans` and `mc gc --reap-orphans [--dry-run --min-age D]`
  (§9j). Detects orphaned `memoro-cli heartbeat-loop` daemons via the
  canonical Unix reparent-to-PID-1 signal and cleans them up — landed
  after observing 9 accumulated orphans pinging the API ~1 req/min
  sustained.
- First-run friendliness in `mc new` and `mc list` (§11d). When both
  the sentinel and the keychain token are missing, a one-line hint
  ("Looks like a fresh install. Run `mc setup` to get started.") goes
  to stderr in place of the cryptic prereq failure. `mc list` keeps
  stdout machine-parseable. Migrants who already ran `memoro-cli login`
  get a silent sentinel write on first successful `mc new` and never
  see the hint.
- README rewrite + `docs/onboarding.md` (§11e). README front door is
  now `mc setup`; the long story (per-tool install, multi-machine
  notes, shell-wrapper specifics) lives in `docs/onboarding.md`.
  Install commands are not duplicated in docs — `mc setup` and
  `mc auth status` are the authority.

### Fixed
- `/memoro-update` body rewritten to be unambiguously display-only.
  Previous wording ("Run these two commands in the user's shell") had
  the LLM trying to execute `npm install -g memoro-cli` via Bash, which
  auto-mode correctly blocks as sanctioned global persistence. New body
  tells the LLM to display the recipe and not run it.
- `/memoro-update`, `/memoro-coordinator`, `/memoro-coordinator-suggest`
  files are now refreshed on every `mc` launch (in addition to the
  existing `hook install` path). Updates to their canonical bodies
  propagate without re-running `memoro-cli hook install`.

### Added
- `/memoro-coordinator-suggest` slash command — analyses every active
  session and recommends a concrete next step per session, plus a
  one-sentence prioritisation. Built for the "where should I spend the
  next 30 minutes?" triage moment.

### Changed
- `/memoro-coordinator` body upgraded: instructs the LLM to present
  active sessions as a **numbered list** with one-line characterisation
  per session, flag PAUSED sessions explicitly, and point users at
  `/memoro-coordinator-suggest` when they want next-step recommendations.
- Coordinator slash command files now **overwrite-on-launch** if their
  canonical content has changed — updates land automatically without
  re-running `memoro-cli hook install`.

### Added
- `mc new <label>` — launch a labeled mc session. Labels appear in
  `mc sessions list` (`[audit]` instead of `[sess_xxx]`) and resolve
  cleanly when dispatching: `mc sessions send audit "..."`. First-match
  wins on collision; warns to stderr.
- `mc` heartbeats now carry `last_assistant_excerpt` — the trailing text
  of what Claude is currently showing in the wrapped session, ANSI-stripped.
  `mc sessions list` displays it under each session so a peer coordinator
  can spot paused prompts (e.g. *"How should I proceed? 1. Update Gemini
  Flash only…"*) at a glance instead of relying on `idle_seconds` alone.

## [0.2.0] — 2026-04-24

### Added
- `memoro show <section>` — prints one lens section on demand (`loose-ends`,
  `decisions`, `rules`, `stack`, `repos`, `practices`, `tool-use`) via a new
  untrimmed `/api/lens/portrait-coding/sections` endpoint. Designed to back
  slash-command output inside Claude Code and similar tools.
- Claude Code adapter: `installCommands` / `uninstallCommands` manage
  `~/.claude/commands/memoro-*.md` files. `hook install` now also installs
  slash commands; `hook uninstall` also removes them. A managed marker
  inside each file means uninstall leaves hand-authored `memoro-*.md` files
  alone.
- Daily auto-update-check. Every invocation compares the running version to
  a cached `latestVersion` and prints a one-line notice to stderr when an
  update is available. Cache is refreshed at most once per 24h by a
  detached child that fetches `registry.npmjs.org`; the main process never
  blocks on the network. Disable with `MEMORO_NO_UPDATE_CHECK=1`.

### Changed
- Claude Code adapter resolves paths lazily via `homedir()` so tests and
  future env overrides can redirect `HOME` without fighting ESM module
  caching.

## [0.1.0] — 2026-04-23

Initial public release.

### Added
- Commands: `login`, `logout`, `status`, `config set/get`, `session upload`,
  `lens pull`, `codex run`, `hook install`, `hook uninstall`.
- Adapters for **Claude Code** (native `SessionStart` / `SessionEnd` hooks) and
  **Codex CLI** (via a `~/.local/bin/codex` shim plus `codex-memoro` wrapper).
- Client-side transcript cleanup — raw tool outputs and code bodies are stripped
  locally; only cleaned user/assistant messages plus deterministic metadata
  (`coding_context`, `repo_manifest`) are uploaded.
- Session annotations captured client-side before upload.
- Managed-block helpers (`upsertManagedBlock`, `removeManagedBlock`,
  `readManagedBlock`) for safely writing the Memoro lens into tool config files
  such as `~/.claude/CLAUDE.md` and `AGENTS.md`.
- Secure token storage via the OS keychain (macOS Keychain / Linux libsecret /
  Windows Credential Manager) with a documented `~/.memoro/config.json` (mode
  `0600`) fallback when no keyring is available.
- Programmatic API re-exporting `adapters`, `parseTranscript`,
  `buildSessionPayload`, and the managed-block helpers.

### Fixed
- Paste into the hidden token prompt on macOS Terminal.
- `SessionEnd` hook being killed mid-upload on Claude Code.
- `SessionEnd` transcript path now read from stdin JSON for compatibility with
  current Claude Code hook payloads.

[0.7.6]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.7.6
[0.7.5]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.7.5
[0.7.0]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.7.0
[0.2.0]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.1.0
