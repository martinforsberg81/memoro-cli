/**
 * The full `mc --help` text, isolated so the thin CLI entry can print
 * it without loading the command graph (~1s of module imports).
 */
export const HELP_TEXT = `mc — grounded coding sessions

USAGE
  mc                              Start the default grounded coding tool here
  mc new <name> [focus]           Create worktree + branch + start a session
  mc spawn <name> "<brief>"       Create an idle tracked project session
  mc open                         List mc sessions available to open
  mc open <name>                  Open an existing session

COMMON
  mc list [--rich|--awaiting]     Show local sessions
  mc list --tree                  Show coordinator/project session tree
  mc status <name>                Show one session's state
  mc dev plan [service] [--profile <name>]
                                  Validate and show this worktree's dev plan
  mc dev ensure [service] [--profile <name>] [--restart]
                                  Safely prepare and ensure its dev server
  mc dev list [--json]            Show machine-local dev servers
  mc dev status|logs <session>    Inspect one session's dev server
  mc dev stop|restart <session>   Run verified project-owned controls
  mc deps status|hydrate [service]
                                  Inspect or explicitly hydrate dependencies
  mc cd <name>                    cd into a session worktree
  mc end [<name>...]              Confirm and permanently remove local session artifacts
  mc rename <old> <new>           Rename branch + worktree + registry entry

END IS PERMANENT
  Interactive end shows session, dirty/ahead branch state, and exact verified
  Codex/Claude artifacts, then asks y/n once. y removes the broker/PTY, vault
  materialisation, provider transcript + ID-bound auxiliary paths, worktree,
  local branch, runtime sidecars, and registry entry. It cannot be resumed.
  --force supplies automation consent; it never weakens ownership checks.
  --keep-branch is the explicit branch-retention exception. Shared provider
  databases, global history/config/memory, and other sessions are untouched.

START OPTIONS
  mc new <name> [focus] --codex   Start the new session under Codex
  mc new <name> [focus] --claude  Start the new session under Claude Code
  mc new <name> [focus] --tool <claude|codex|gemini>
  mc new <name> --from <ref>      Branch from a ref other than HEAD
  mc open <name> --codex          Use Codex only before first launch or for Codex sessions
  mc open <name> --claude         Use Claude Code only before first launch or for Claude sessions

SETUP
  mc                              First run signs in to Memoro with browser device auth
  mc setup [--json]               Verify setup; choose local heavy-job limits on a TTY
  mc setup --bootstrap            Install missing coding tools and sign them in from custody
  mc setup --resource-profile <unlimited|balanced|conservative|custom>
                                  Configure image/motion resource protection
  mc setup --resource-profile custom --heavy-max-concurrent <n>
           --heavy-max-threads <n> --heavy-max-rss-mb <n>
           --heavy-max-swap-mb <n> --heavy-min-free-disk-gb <n>
                                  Configure every custom safeguard
  mc setup --dependency-mode <auto|isolated|off>
                                  Choose snapshot reuse, worktree-only, or off
  mc install-shell                Install auto-cd support for zsh/bash
  mc auth status [--json]         Check Memoro + coding-tool auth
  mc auth memoro                  Token login/logout for CI or headless setup
  mc auth devices                 List/revoke Memoro device tokens
  mc github status [--json]       Check this repo via the Memoro GitHub App
  mc github connect [--json]      Start the central GitHub connection flow
  mc github repos [--json]        List selected GitHub repositories
  mc github pr list [--json]      List pull requests through the session broker
  mc github pr view <n> [--json]  View one pull request through the session broker
  mc github pr checks <n> [--json]
                                  List checks through the session broker
  mc github pr create --title <text> --body <text> [--base <branch>] [--draft] [--json]
                                  Create a PR from the server-bound session branch
  mc github pr update <n> [--title <text>] [--body <text>] [--json]
                                  Update a PR with exact current-state checks
  mc auth github [--json]         Alias for mc github status
  mc auth <claude|codex|gemini>   Re-check one coding tool
  mc tool-switch <tool>           Set the default tool for future sessions
  mc coding-profile read|diff|write
                                  Read, compare, or update your Coding Profile

SECRETS
  mc vault status                 Show vault setup + lock state
  mc vault audit [--cleanup]      Audit legacy exposure metadata safely
  mc vault setup                  Create a Memoro-account token vault
  mc vault unlock                 Unlock and cache the vault key briefly
  mc vault scan [file...]         Scan dotenv files for import candidates
  mc vault import <file>           Import dotenv secrets into the vault
  mc vault import <file> --dry-run Preview encrypted import candidates
  mc vault set <label>            Store a secret
  mc vault list                   List secret labels, never values
  mc vault get <label>            Disabled: plaintext export is forbidden
  mc vault rm|rotate|lock         Manage stored secrets
  mc tool-auth hydrate|persist    Disabled legacy vault-to-tool bridge

FLEET / ADVANCED
  mc spawn <name> "<brief>"       Create durable child project session
  mc fanout <plan.md>             Create one idle session per plan phase
  mc gather <plan-slug>           Merge phase PRs into a summary branch
  mc supervisor                   Open supervisor control prompt
  mc sessions list                List active sessions seen by Memoro
  mc sessions watch               Summarize local broker sessions for orchestration
  mc sessions send <label|id> <msg>
                                  Dispatch a message into another session
  mc sessions read <label|id>     Fetch another session's recent transcript
  mc sessions stop <label|id>     Stop a broker-owned session
  mc sessions remove <label|id>   Remove a broker session from inventory
  mc reconcile [--apply]          Detect sessions shipped elsewhere
  mc doctor                       Diagnose local mc memory/storage state
  mc storage status|candidates    Inspect local runtime/worktree storage
  mc storage repair [name] --dry-run|--apply
                                  Preview/apply safe local metadata repairs
  mc storage repair <name> --provider-backfill --apply
                                  Backfill a provider-native resume id
  mc storage prune-missing --dry-run|--apply
                                  Prune missing registry tombstones after 7d
  mc storage prune-deps --dry-run|--apply
                                  Prune old inactive worktree node_modules
  mc storage prune-generated --dry-run|--apply
                                  Prune old ignored build/cache directories
  mc gc [--dry-run]               Reap registry-dead, merged, clean worktrees
  mc gc --runtime                 Reap stale runtime pid/socket sidecars
  mc gc --dependency-snapshots --dry-run
                                  Preview dependency snapshot cache cleanup
  mc gc --stale-worktrees --only <names>
                                  Reap only named clean, merged worktrees
  mc gc --sidecars                Reap stale hosts/guard-bin runtime sidecars
  mc gc --all-safe --dry-run      Preview runtime + snapshot + clean merged worktree cleanup
  mc broker start/status/stop     Local PTY broker admin
  mc broker connect               Connect local broker to Memoro cloud
  mc attach <session_id>          Attach to a broker-owned local session
  mc cloud-session start          Internal typed cloud mc runtime
  mc cloud-runtime run            Internal cloud sandbox runtime supervisor
  mc adapter sync                 Refresh tool instruction wrappers
  mc adapter materialise          Copy mc's coordinator canon into this repo
  mc wrap <label> [args...]       Start an in-place labelled wrapper session

COMMAND SURFACES
  Terminal commands manage machines and sessions: setup, auth, new, open,
  end, broker, vault, and repo/worktree lifecycle.

  Inside a launched LLM session, use explicit mc commands for durable working
  method updates, such as \`mc coding-profile read\`, \`mc coding-profile diff\`,
  and \`mc coding-profile write\`.
  Do not treat terminal setup/lifecycle commands as in-session instructions.
  The workflow stays the same across Codex, Claude Code, and future adapters;
  tool-specific slash commands are conveniences, not the main path.

NEW USER FLOW
  1. Install: \`npm install -g memoro-cli\`
  2. Sign in: run \`mc\` and approve the browser device flow
  3. Connect services: \`mc connections\` uses the shared provider registry
  4. Verify: \`mc setup\` checks readiness and offers optional resource limits
  5. Start: from a git repo, run \`mc new <name> [focus]\`

WHAT HAPPENS ON START
  Fresh starts (\`mc\`, \`mc new\`) inject project grounding before the
  coding tool wakes: compact User Profile and Coding Profile context when
  available, mc session identity/repo metadata, plus the current focus. mc does
  not create or read a repo-local MEMORO.md in the normal startup path. Vault
  plaintext is never materialised for the coding tool; provider access uses
  token-free typed capabilities.

  \`mc open\` first attaches to a live broker-owned PTY when one exists,
  preserving that session surface without sending a new prompt. If no
  local live PTY is attachable, mc relaunches the same provider-native
  session by id. If mc cannot find that provider session id, it announces
  the gap and starts a fresh grounded session on the same coding session —
  never a silent, contextless replacement. Idle tracked sessions that have
  never launched start as fresh grounded sessions on first open.

TOOL SELECTION
  \`mc tool-switch <tool>\` changes the default for future bare \`mc\` and
  \`mc new\` starts. It does not change a running session. Tool flags on
  \`mc open <name>\` cannot switch provider for an existing provider
  session; use \`mc new\` for a new tool conversation.

  When a live broker PTY exists, \`mc open <name>\` and its tool-flag
  variants attach to that running session as-is instead of starting a
  duplicate.

  \`mc open\` lists mc's own registry sessions across tools and then calls
  the selected tool's native resume-by-id path directly, without opening
  Claude or Codex pickers.

  \`mc resume\` remains as a compatibility alias for existing scripts.

SESSION NAMES
  \`mc new <name>\` creates a local session name. Use that same name with
  \`mc open\`, \`mc status\`, \`mc cd\`, \`mc rename\`, and \`mc end\`.

REQUIREMENTS
  - Run inside a git repository.
  - Install Codex CLI for the default path, or Claude Code if selected.
  - Authenticate with Memoro: run \`mc\` for device login, or
    \`memoro-cli login\` for CI/headless use.

HELP
  mc <command> --help                Show command-specific usage
  mc --version                       Print version
`;
