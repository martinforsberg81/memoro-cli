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
  mc supervisor                    The session that watches the others: no
                                    worktree, one of it, holds the overview
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
  mc work <name> new               A new conversation rather than the last one
  mc work <name> new --model <m>   …on a chosen model, passed to the tool as
                                    given; a resumed conversation stays on the
                                    model its transcript says it ran on
  mc work <name> <id>              One particular conversation, by the id shown
  mc work add <name> <repo> [branch]
                                    Add a repository's worktree to that work
  mc work stop <name>              Stop what is running there; keep the work
  mc work remove <name> <repo>     Take one repository out of that work
  mc work release <name> [--apply] Remove what git says can go; keep the rest
  mc work discard <name> [--apply] Throw it away — worktrees, branches, and the
                                    conversations, which nothing brings back
  mc worker <name> [task]          A project folder that carries the worker
                                    role: every conversation started in it
                                    gets the role's overlay and model default
  mc pm                            The PM's workspace: attach if it runs,
                                    restart it if it stopped, create it the
                                    first time. One of it, ever; no worktree
  mc pm-helper                     The helper's workspace: same door, same
                                    rules
  mc roles list                    The defined roles, read from their files
  mc roles show <role>             One role whole: facts, then overlay text
  mc worktree add <name> <branch>  Create a worktree this session owns
  mc worktree list <name>          What this session owns
  mc worktrees [--json]            What is lying around, and whose it is
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
