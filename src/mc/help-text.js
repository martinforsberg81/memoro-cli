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
  mc end <name>                    Stop and archive; keep every workspace
  mc cleanup <name> --dry-run|--apply
                                    Clean only exactly proven mc-owned resources
  mc delete <name> --force         Delete an archived session home after cleanup

MAINTENANCE
  mc doctor [--repair] [--json]    Diagnose or safely repair session-home state
  mc storage status [--json]       Summarize durable and ephemeral session state
  mc storage explain <name>        Explain one session's stored resources
  mc storage repair [--apply]      Plan or apply loss-free storage repairs
  mc gc [--dry-run|--apply]        Remove stale runtime homes; never Git resources

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
  mc coding-profile read|diff|write
                                    Manage the durable Coding Profile
  mc adapter sync                  Refresh repo-owned tool instructions
  mc doctor                        Diagnose local mc state

IDENTITY
  A session has one opaque mc-id and one owner: this machine or Memoro Cloud.
  Its name, workspace, tool conversation, process, PTY, and runtime generation
  may change without changing that identity.

REQUIREMENTS
  - Run from any directory you want to associate with the session.
  - Install and authenticate the selected coding tool.
  - Sign in to Memoro only for cloud listing and connected capabilities.

HELP
  mc <command> --help              Show command-specific usage
  mc --version                     Print version
`;
