/**
 * The complete top-level help text. Keep this module dependency-free so the
 * thin entry point can print help without loading a runtime implementation.
 */
export const HELP_TEXT = `mc — source-owned coding sessions

USAGE
  mc new <name> [objective]        Create a local session in this directory
  mc open <name>                   Attach to, start, or exactly resume a session
  mc list                          List local and Memoro Cloud sessions

LOCAL SESSIONS
  mc new <name> [objective] [--tool codex|claude] [--no-launch]
                                    Create no branch or worktree implicitly
  mc open <name> [--cwd <path>] [--tool codex|claude] [--replace]
                                    Associate another directory or open here
  mc resume <name>                 Alias for mc open
  mc status <name> [--json]        Read durable session and runtime state
  mc rename <old> <new> [--json]   Rename metadata without moving workspaces
  mc cd <name> [--workspace <id>]  Print or enter an associated directory
  mc attach <name>                 Attach to the exact live local terminal
  mc sessions send <name> <text>   Write to the exact live local terminal
  mc sessions read <name> [--last N]
                                    Read its bounded current screen
  mc restart <name>                Replace the runtime; keep everything else
  mc end <name>                    Stop and archive; keep every workspace
  mc cleanup <name> --dry-run|--apply
                                    Clean only exactly proven mc-owned resources
  mc delete <name> --force         Delete an archived session home after cleanup

MAINTENANCE
  mc doctor [--repair] [--json]    Diagnose or safely repair session-home state
  mc storage status [--json]       Summarize durable and ephemeral session state
  mc storage explain <name>        Explain one session's stored resources
  mc storage repair [--apply]      Plan or apply loss-free storage repairs
  mc dev list [--json]             Every development server on this machine:
                                    which session owns it, whether it is
                                    healthy, and where it is listening
  mc dev status|logs|stop|restart <selector>
                                    One of them — read it, tail it, stop it,
                                    or start it again. mc dev with no verb
                                    lists all nine and what each one takes
  mc status                        Every piece of work and what it is doing:
                                    waiting for you, working, or idle
  mc status --watch [seconds]      A live page; polls every 15s and rewrites
                                    only the rows that changed
  mc status --json                 The same, for a session watching the others
  mc status --wait [--timeout <s>] Block until something moves, then report
  mc work                          What exists; at a terminal, a way in
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
  mc work send <name> "<text>"     A message into that work's inbox/. Nothing
                                    running is not a failure: it reads the
                                    inbox when it starts
  mc work send <name> … --wake     …and knock on the conversation running
                                    there, so it reads the inbox now. It
                                    refuses on a pane somebody is attached to
                                    or one whose prompt is not empty, and says
                                    so — the message is delivered either way
  mc work send <name> … --task     …and open a tracked task for it in the same
                                    action: state open, moving to done or to
                                    blocked with one line of reason. Never
                                    inferred — without the flag no task exists
  mc work add <name> <repo> [branch]
                                    Add a repository's worktree to that work
  mc work stop <name>              Stop what is running there; keep the work
  mc work remove <name> <repo>     Take one repository out of that work
  mc work release <name> [--apply] Remove what git says can go; keep the rest
  mc work discard <name> [--apply] Throw it away — worktrees, branches, and the
                                    conversations, which nothing brings back
  mc repo status [repo]            One repository seen whole: main, the open
                                    pull requests and how far behind main each
                                    one is, the work areas standing on it, and
                                    whether this machine's installation is in
                                    step. Without a name, every repository mc
                                    can see
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
  mc repo merge <repo> <pr>        Run the test gate for that pull request —
                                    take the lease, build a fresh baseline and
                                    a candidate with main merged in, run the
                                    repository's own full suite on both, and
                                    compare the failures by name at every
                                    level — then, only if it is green and the
                                    base has not moved since, squash-merge,
                                    pull the source-linked installation, and
                                    log a line. Nothing merges a red gate
  mc repo merge <repo> <pr> --check
                                    The same round, stopping at the verdict.
                                    A green gate is not a review
  mc watch pm start [--interval <seconds>]
                                    The PM round, every 30 minutes and never a
                                    model: commit pm/, run mc doctor, count
                                    pm/inbox/, deliver what the session guard
                                    left in the notices ledger, and knock once
                                    if any of it is new. It wakes on change —
                                    an item that lingers earns one reminder
                                    after three passes and then silence
  mc watch pm stop                 Stop it; nothing else changes
  mc watch pm status [--json]      Whether it is running, when it last ran, and
                                    what that pass saw
  mc watch sessions start [--interval <seconds>] [--model <model>]
                                    A watchman over the running conversations.
                                    It flags waiting, silent, dead,
                                    unreachable, stalled, blocked,
                                    quota-exhausted and error — and only
                                    flags: no action, no judgement, no
                                    ranking. Everything with a deterministic
                                    answer is worked out here; Haiku is asked
                                    only about output that is prose, and only
                                    when that output moved
  mc watch sessions stop           Stop it. It never starts itself
  mc watch sessions status [--json]
                                    Whether it is running, when it last looked,
                                    and what is standing
  mc worker <name> [task]          A project folder that carries the worker
                                    role: every conversation started in it
                                    gets the role's overlay and model default
  mc pm                            The PM's workspace: attach if it runs,
                                    restart it if it stopped, create it the
                                    first time. One of it, ever; no worktree
  mc pm new [--model <m>]          Start over: a fresh conversation in the same
                                    window. The one running is asked to leave
                                    (from inside its own session it cannot be
                                    asked, and the turn in flight is lost —
                                    mc says which happened). Nothing is
                                    deleted: the predecessor stays on disk, the
                                    successor is told its id, and mc pm <id>
                                    reaches it. Without --model, the role's
                                    default — never the predecessor's
  mc pm <conversation id>          That conversation, by the id shown in
                                    mc work. The way back from a handoff; it
                                    refuses while the PM is running rather than
                                    quietly attaching to the other one
  mc pm-helper                     The helper's workspace: same door, same
                                    rules — new and an id included
  mc roles list                    The defined roles, read from their files
  mc roles show <role>             One role whole: facts, then overlay text
  mc worktree add <name> <branch>  Create a worktree this session owns
  mc worktree list <name>          What this session owns
  mc worktrees [--json]            What is lying around, and whose it is
  mc task list [<session>] [--json]
                                    Open tasks, oldest-moved first, with age.
                                    Without a session, every open task
                                    anywhere. mc status shows the count per
                                    session; this shows which ones and why
  mc task done <id>                Mark it done — the one way out
  mc task block <id> "<reason>"    Mark it blocked, with what for. done still
                                    ends it from here; nothing else moves it
  mc gc [--dry-run|--apply]        Remove stale runtime homes; never Git resources
  mc migrate [--dry-run] [--stop-legacy-runtimes]
                                    Move pre-V1 sessions into session homes, once
                                    and explicitly; no other command migrates
  mc migrate --session <name>       Move one session and leave the rest alone

LISTING
  mc list [--local|--cloud] [--all] [--json|--names]
  mc sessions list                 Alias for mc list

  Local sessions are authoritative on this machine and are listed without
  probing sockets or the network. Cloud sessions are authoritative in Memoro
  Cloud and appear as a separate source. They are not synchronized copies.

EXECUTION
  Codex and Claude use one certified execution path. A live runtime is attached
  without starting another process. An inactive runtime resumes only from its
  exact recorded conversation evidence. Missing or conflicting evidence fails
  closed; --replace is required to create a replacement conversation.

  A session may use several repositories, worktrees, checkouts, and ordinary
  directories during its lifetime. These paths are workspace associations,
  never the session identity or an implicit cleanup authority.

SETUP AND CAPABILITIES
  mc setup [--json]                Verify local setup
  mc install-shell                 Install shell directory-change support
  mc auth status [--json]          Check Memoro and coding-tool readiness
  mc connections                   Manage connected services
  mc github status [--json]        Check GitHub App capability for this repo
  mc github pr list|view|checks    Read pull requests through the GitHub App
  mc github pr create|update       Write through the same typed capability
  mc setup profile                 Write your Coding Profile in $EDITOR — a
                                    letter to your tools about how you work
  mc coding-profile read|diff|write|edit
                                    The same profile, for a machine to handle
  mc doctor                        Diagnose local mc state

IDENTITY
  A session has one opaque mc-id and one owner: this machine or Memoro Cloud.
  Its name, workspace, tool conversation, process, PTY, and runtime generation
  may change without changing that identity.

REQUIREMENTS
  - Run from any directory you want to associate with the session. mc does not
    require a Git repository; a repository is one thing a workspace may be.
  - Plain mc lists your sessions.
  - Install and authenticate the selected coding tool.
  - Sign in to Memoro only for cloud listing and connected capabilities.

HELP
  mc <command> --help              Show command-specific usage
  mc --version                     Print version
`;
