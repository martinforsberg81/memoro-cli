/**
 * The complete top-level help text. Keep this module dependency-free so the
 * thin entry point can print help without loading a runtime implementation.
 */
export const HELP_TEXT = `mc — source-owned coding sessions

THE PAGE
  mc                               The one page: what is running now, how deep
                                    the queue is, the decisions waiting on
                                    you, what waits in intake, and every
                                    project numbered, by repository. At a
                                    terminal it ends in a way in — a number
                                    opens that project. No model; reads only
  mc --json [--fresh]              The same page as one object. The page is
                                    offline and instant; --fresh fetches and
                                    asks GitHub, and without it the page says
                                    how old its PR cache is

  mc brief                         Decide what to work on next
  mc plan [<programme>]            Plan a programme; no name asks which
  mc run                           The runner: headless steps, a lane per repository
  mc run start | stop [--force]    Turn it on, or off — after the round, or now
  mc run --update                  After the round: new code, new process
  mc run lanes [<n>] [--total <n>] Steps in flight: <n> per repository, --total across
                                    every repository at once; no argument prints both
  mc test <repo> <pr>              Measure a pull request; merge nothing
  mc test dev | prod               The app running, measured — locally or live
  mc merge <repo> <pr>             The same measurement, then the merge
  mc deploy [--dry-run]            memoro's main to production, after one question
  mc dev list                      Which dev server runs in which worktree
  mc status <name>                 One project, whole
  mc work <name>                   Open that workarea

IN FULL
  mc status <name>                 One project: its PLAN.md frontmatter and
                                    step, the decisions that belong to it,
                                    its last three runner steps and the open
                                    PR on its branch. --json and --offline
                                    as above. Without a name it says where
                                    the page went: mc is the page
  mc work                          The page — mc by another name
  mc work <name>                   Open it — the name is enough, new or not
  mc work <name> --tmux [task]     Start it in the background, for another
                                    session to talk to; mc work <name> joins
                                    it, and ctrl-b d leaves it running
  mc work <name> new               A new conversation rather than the last one —
                                    including when one is running in the
                                    background: it is ended and replaced in the
                                    same window, so anyone attached stays
                                    attached. Nothing is deleted
  mc work <name> new --model <m>   …on a chosen model, passed to the tool as
                                    given; a resumed conversation stays on the
                                    model its transcript says it ran on
  mc work <name> <id>              One particular conversation, by the id shown.
                                    While another is running there it is
                                    refused, with both ways on: join what runs,
                                    or stop it and open the one you named
  mc work <name> --resume <id>     The same, said explicitly — and the only way
                                    to name one with --tmux, where the rest of
                                    the line is the task. An id that matches
                                    nothing is an error before anything starts,
                                    never a new conversation in its place
  mc work add <name> <repo> [branch]
                                    Add a repository's worktree to that work
  mc work stop <name>              Stop what is running there; keep the work
  mc work remove <name> <repo>     Take one repository out of that work
  mc work release <name> [--apply] Remove what git says can go; keep the rest
  mc work discard <name> [--apply] Throw it away — worktrees, branches, and the
                                    conversations, which nothing brings back
  mc repo status [repo]            One repository seen whole: main, what the
                                    last full run found on it and since when,
                                    the open pull requests and how far behind
                                    main each one is, the work areas standing on
                                    it, and whether this machine's installation
                                    is in step. Without a name, every repository
                                    mc can see
  mc repo status --offline         The same without touching the network; the
                                    page says which parts are last-seen
  mc repo status --json            The same, for a session rather than a person
  mc repo watch start [--interval <seconds>]
                                    Keep the answer fresh in the background:
                                    one process refreshes a snapshot, and every
                                    reader — person, session, board — gets it
                                    for the price of a file read
  mc repo watch stop               Stop it; the last snapshot stays and ages
  mc repo watch status [--json]    Whether it is running and when it last wrote
  mc repo claim <repo> "<what for>"
                                    Say you are holding a round on it: verify,
                                    merge, deploy. mc refuses a second claim
                                    and blocks no git at all — the lease is an
                                    agreement, visible to everyone in the view
  mc repo release <repo> [--force] Give it back. --force takes it from someone
                                    else, and is always written to the log
  mc repo who <repo> [--json]      Who holds it, for what, since when — and
                                    whether that holder is still working, read
                                    off the board rather than off a clock. A
                                    holder mc cannot see reads unknown, never
                                    a guess
  mc test <repo> <pr>              Measure that pull request, and stop there —
                                    take the lease, build a fresh baseline and
                                    a candidate with main merged in, run what
                                    the change reaches on BOTH sides, and
                                    compare the failures by name at every
                                    level. What runs is what the repository
                                    declares: with a select command it is the
                                    test files the change reaches, without one
                                    it is the whole suite. Both sides always
                                    run the CANDIDATE's list, because a
                                    selection is a function of the diff and the
                                    base's diff against itself is empty. Merges
                                    nothing, and cannot
  mc test <repo> --full            The repository's own whole suite on the
                                    default branch as fetched — one tree, no
                                    pull request, no selection
  mc test nightly start [--interval <seconds>]
                                    That same full round on an interval, with
                                    nobody asking: every repository mc knows,
                                    once a day by default, written to a log
                                    under mc's home. A tick that finds a gate
                                    round running skips it and says whose round
                                    it was; nothing it finds refuses a merge or
                                    delays a round
  mc test nightly stop             Stop it; a round in flight ends with it
  mc test nightly status [--json]  Whether it is running, how often and where
                                    it writes — and, per repository, what the
                                    last run found: red, and since when
  mc test dev [--here] [--suite <name>] [--json]
                                    The round no tree can answer: the app
                                    running, measured by the suites the
                                    repository declares in .mc/test.json —
                                    module graphs that link, surfaces that
                                    settle, routes that render. mc ensures a
                                    dev server first and reuses the one already
                                    serving that worktree, decided from the
                                    inventory rather than from a port
                                    answering. One shared server, started from
                                    the installation on main, because ten lanes
                                    with ten wranglers is a machine nobody can
                                    work on; --here gives the calling worktree
                                    its own, for a change that is not on main
                                    yet. --url prints the address and runs
                                    nothing
  mc test prod [--here] [--suite <name>] [--json]
                                    The same suites against meetmemoro.app,
                                    for the answers that are only true there:
                                    real bindings, real assets, real latency.
                                    The suites that sign in use the managed
                                    test account and need TEST_SEEDED_TOKEN in
                                    the shell; without it they report skipped
                                    rather than passing quietly. Neither of
                                    these runs by itself — no round, no page
                                    and no schedule starts one. --here runs
                                    this worktree's copy of the suites, for
                                    when the instrument is what changed
  mc dev list [--json]             The machine's dev servers: one line each —
                                    instance, url, session and worktree. A
                                    registration whose process is gone is swept
                                    as it is read, so the answer is what is
                                    running rather than what once was. It exits
                                    0 on an empty machine, because memoro's dev
                                    wrapper runs it to find out whether this mc
                                    speaks the protocol at all
  mc dev register <manifest> [--json]
                                    Take a copy of the manifest a project's dev
                                    wrapper just wrote. mc holds the index; the
                                    wrapper stays authoritative for how its
                                    server starts, stops and becomes healthy
  mc dev unregister <manifest> [--json]
                                    Forget it. Not an error when nothing was
                                    registered — the end state is the one asked
                                    for either way
  mc merge <repo> <pr>             That same measurement, then the landing:
                                    only if nothing new went red and the base
                                    has not moved since, squash-merge, pull the
                                    source-linked installation, and log a line.
                                    Nothing merges a red gate. The round does
                                    not measure the base, so the verdict
                                    carries no standing-red number: green is
                                    green, and what ran is the count on the
                                    line under it
  mc merge <repo> <pr> <pr>...      Several at once: one candidate with all
                                    of them merged in, measured once each
                                    side, each one's own tests by itself, then
                                    merged in the order given. A batch that
                                    stops — a conflict, a red — falls back to
                                    one round per pull request and says so
  mc merge <repo> <pr> --docs      Land a pull request that touches nothing
                                    outside docs/ — no suite, no lease, squash.
                                    Anything else is refused with the file
                                    that is outside docs/
  mc deploy [--dry-run] [--json]   memoro's main to production: the sha it
                                    would ship, what is live now and the gap
                                    between them, what the nightly said about
                                    that tree — then one question, and on a
                                    yes the repository's own npm run deploy,
                                    under mc's lease so nothing moves main
                                    while the build reads it. No flag skips
                                    the question and without a terminal it
                                    refuses; --dry-run is the reading and
                                    stops there. Every deploy, and every
                                    refusal, is a row in
                                    ~/mc/runner/log/deploys.tsv — written
                                    before the deploy and completed after it,
                                    and read back by the page, the brief and
                                    mc helper. It takes no repository:
                                    memoro-cli is installed, not deployed
  mc repo guard [repo]             Install the pre-push guard: a push to a
                                    branch whose pull request is already merged
                                    is refused with the number and date, and
                                    the way forward (a new branch from main).
                                    Not knowing never refuses. MC_PUSH_ANYWAY=1
                                    lets a deliberate push through. mc installs
                                    it in every repository it adds a worktree
                                    to; --json says whether it is in place
  mc log [--failures] [--limit n]  What mc did and how it ended. Every
                                    invocation writes a start and an end; a
                                    start with no end is a command that died
  mc log <run>                     One invocation whole: what it said, the
                                    rounds it ran, the leases it touched —
                                    the three files joined on its run id
  mc log --open                    Gate rounds that started and never ended,
                                    with the lease each left behind. It only
                                    reads: releasing one stays your decision
  mc brief                         The evaluation session: gather what the
                                    runner merged, opened and is waiting on,
                                    then decide with a fresh session
  mc brief --collect [--offline]   Only the file: ~/mc/brief/<date>.md, no
                                    model, from the runner log, PRs, plans
                                    on main, decision files and the queue
  mc helper                        The desk: a session in ~/mc/helper/ that
                                    takes your report of a bug or something
                                    that should be better and writes it into
                                    ~/mc/proposals/<date>-<x>.md. It
                                    reads no digest, touches no proposal that
                                    is already there, and fixes nothing — you
                                    pick it up at mc brief or mc plan
                                    (--codex|--claude, --model <m> as usual)
  mc helper --intake               The eye on production: the daily digest,
                                    then one headless turn that reads it and
                                    proposes from it — zero on a quiet day.
                                    Never the queue: the next brief lists
                                    them, and you decide. mc run does this
                                    once a day on its own; mc shows the
                                    digest and its \`!\` lines
  mc helper --collect              Only the digest, no model:
                                    ~/mc/intake/errors-<date>.md from the
                                    error survey, the analysis items,
                                    AI-provider errors, health and deploys
                                    — plus what is new since the last digest.
                                    Reads production, writes nothing to it
  mc helper --intake [--collect] --since <iso> [--limit <n>] [--threshold <n>] [--model <model>]
                                    …a different window, more fingerprints,
                                    another bar for marking one \`!\`, or a
                                    model other than the role's
  mc plan <programme>              A session in a directory, told which
                                    programme it is for. A fresh foreground
                                    session in ~/mc/plan/<programme>/, both
                                    repositories checked out on
                                    plan/<programme>. What comes out of it is
                                    yours and its to work out — the prompt
                                    predicts no plan, no project and no PR.
                                    Never a workarea — mc run cannot see it
  mc plan                          …asks which programme first: the ones on
                                    main, the ones being planned, or a new
                                    one you name. --codex|--claude, --model
                                    <m> as usual
  mc run                           The runner: one fresh headless session per
                                    step of the next project, merged direct;
                                    queue = ~/mc/queue.md then every ready
                                    PLAN.md on origin/main. Touch
                                    ~/mc/runner/STOP to exit after the step.
                                    Runs mc helper --intake once a day too,
                                    in the first round after 05:00Z
  mc run --once                    One step for the first runnable project,
                                    and no helper
  mc run --rounds <n> [--no-merge] [--idle-sleep <s>]
  mc worker <name> [task]          A project folder that carries the worker
                                    role, read from the roles mc ships: every
                                    conversation started in it gets the
                                    overlay and the model default
  mc roles list                    The defined roles, read from their files
  mc roles show <role>             One role whole: facts, then overlay text
  mc vault <verb>                  The Memoro token vault: setup, unlock,
                                    lock, status, set, get, list, rm, rotate,
                                    bind, bindings, import, scan, audit,
                                    adopt, hydrate, devices, recovery,
                                    recover, migrate. mc vault with no verb
                                    prints them with what each one takes. The
                                    one capability verb that is not a door
                                    into the session manager, and the one
                                    this cut keeps

WHAT IS NOT HERE
  There is no verb that lists work. mc is the page; a second list beside the
  first one is what this replaced.

  The session manager is not here either. A registry, a broker, a PTY host,
  managed providers and cloud runtimes were the product before this one, and
  the fourteen verbs that were their doors — setup, install-shell, auth,
  tool-auth, connections, github, coding-profile, dev, deps, cloud-session,
  cloud-runtime, security, doctor, migrate, and the session verbs before them
  — went on 2026-09-03. A work area is a directory, the worktrees it spans and
  the conversations started in it, and nothing else about it is mc's to know.

REQUIREMENTS
  - Plain mc prints the page and, at a terminal, opens what you pick.
  - Install and authenticate the selected coding tool.
  - Sign in to Memoro for mc vault.

HELP
  mc <command> --help              Show command-specific usage
  mc --version                     Print version
`;
