/**
 * Shared command usage and long-reference text. No runtime imports: top-level
 * help must not load handlers, credentials, git or session launch machinery.
 * Entries migrate here during the handler/flag audit.
 */
export const COMMAND_USAGE = Object.freeze({
  run: [
    "usage — mc run [--once] [--no-merge] [--idle-sleep <seconds>] [--no-caffeinate]\n",
    "        mc run start [same flags]   the runner, in the background; takes over from one that is stopping\n",
    "        mc run start --if-was-running  only after a runner that died (the login agent's start)\n",
    "        mc run stop [--force]       after the sessions in flight, or now\n",
    "        mc run --update [--force]   new code, new process; the old one finishes its sessions\n",
    "                                    the runner moves now, the merger and the repo watcher at their\n",
    "                                    next safe point, each starting a successor on the new code\n",
    "                                    already on origin/main: nothing written (--force writes anyway)\n",
    "                                    already draining: the drain, and the sessions it waits on\n",
    "        mc run lanes [<n>]          headless sessions at once (plan, build, review), in total\n",
    "                                    across every repository; no argument prints it\n",
    "        mc run --billing             plan usage and next billing for Claude and Codex\n",
    "        mc run --billing <claude|codex> <on|off>\n",
    "                                    whether that provider uses its API key once its plan is spent\n",
    "\n",
    "The runner runs headless sessions: build (a project's step, or a goal) and review.\n",
    "A free lane takes a review first, then a project's build, then a goal's, longest waiting first.\n",
    "The daily digest runs after 05:00Z; inbox turns have their own chore cadence.\n",
    "--once runs one session and skips chores; --no-merge leaves pull requests open.\n",
    "--idle-sleep is the idle wait in seconds (600 by default); --no-caffeinate allows sleep.\n",
    "start and stop are person/runner controls, not a way for a session to start itself.\n",
    "The lane count applies live. The merge lanes, one per repository, are not these lanes.\n",
  ].join(''),
  project: [
    "usage — mc project new <programme>/<project> --repo <repo> --goal <text> --contract <text>... --out-of-scope <text>... [--tool codex]   draft a plan, as DRAFT.json; --tool codex runs its steps on Codex\n",
    "        mc project edit <project> [--goal <text>] [--contract <text>...] [--out-of-scope <text>...]                     change a draft's goal, contract or out of scope\n",
    "        mc project amend <project> --amendment-file <json> --reason \"<authorization>\"  validate a sent plan amendment while its first unfinished step stays blocked\n",
    "        mc project criterion add <project> <text> --check <command>   add a success criterion, to a draft or a sent plan\n",
    "        mc project criterion edit <project> <n> --check <command>     change success criterion <n>'s check, and record it not met\n",
    "        mc project step add <project> <title> --model fast|large --done-when <text> --instruction-file <md> [--effort <level>] [--after <repo>:<project>]   add a step, after the others\n",
    "        mc project step edit <project> <n> [--title <text>] [--model fast|large] [--effort <level>] [--done-when <text>] [--instruction-file <md>]   change the named fields of a step, of a draft or of a sent plan that has not started\n",
    "        a step names a work class; mc picks the model when the step starts (ruling 59)\n",
    "        mc project send <project>                    validate the draft, append its review step and rename it to PLAN.json for the runner\n",
    "        mc project archive <project>                done: its row to the repository's project_log.md, CLOSEOUT.json beside the plan, its step area closed\n",
    "        mc project discard <project> [--apply]      gone: its directory, step area, register file and open pull requests; without --apply it shows what would go\n",
    "        mc project <name> [--json] [--offline]      show a project: a sent plan as mc status <name> does, a draft as it stands\n",
    "        mc project criterion drop <project> <n> --reason \"…\"          remove a criterion nobody can measure from a draft or a sent plan; the register and its log record why\n",
    "        mc project criterion met [<project>] <n>     record that success criterion <n> holds — it was measured by its check\n",
    "        mc project criterion unmet [<project>] <n>   record that success criterion <n> does not hold\n",
    "        the project defaults to MC_STEP's in a runner session\n",
  ].join(''),
  step: [
    "usage — mc step                                   this session's step (MC_STEP)\n",
    "        mc step <project> [--json]                 every step of a project\n",
    "        mc step failed [<project> <n>] --reason \"…\"\n",
    "        mc step blocked [<project> <n>] --on <decision> | --on-project <project> [--reason \"…\"]\n",
    "        mc step blocked [<project> <n>] --until <iso> | --after-deploy [<m>] [--hours <h>] [--reason \"…\"]\n",
    "        mc step note [<project> <n>] \"…\"\n",
    "        mc step ready <project> <n> [--answer \"…\"]\n",
    "        mc step done <project> <n> [--pr <n>]\n",
    "\n",
    "The register, not the plan file, holds progress. A failed step says why; a blocked\n",
    "step names a decision, a project, an ISO instant, or an earlier step's deploy.\n",
    "--after-deploy defaults to the previous step; --hours sets the wait after deploy.\n",
    "Time/deploy waits are released by the runner; only memoro has a deploy, and a plan\n",
    "that lands once at its review cannot wait for an earlier step's deploy.\n",
    "ready releases a step, with --answer carrying the decision that unblocked it;\n",
    "done may record its pull request with --pr. note records a comment, not a new state.\n",
    "Omitted project/step coordinates use MC_STEP; mc step <project> reads every step.\n",
  ].join(''),
  helper: [
    "usage — mc helper [--new] [--codex|--claude] [--model <model>]\n",
    "        mc helper --collect [--since <iso>] [--limit <n>] [--threshold <n>]\n",
    "        mc helper --intake [--collect] [--since <iso>] [--limit <n>] [--threshold <n>] [--model <model>]\n",
    "\n",
    "Person: the bare verb opens or resumes the desk in ~/mc/helper/. It writes proposals\n",
    "under ~/mc/proposals/, reads no digest, and changes no existing proposal.\n",
    "--new starts a fresh conversation; --codex|--claude and --model choose its tool/model.\n",
    "--collect writes one errors-<repo>-<date>.md digest per repository under ~/mc/intake/,\n",
    "with no model and no production writes. --since changes the window; --limit and\n",
    "--threshold are positive counts for fingerprints and their attention marker.\n",
    "--intake collects, then drains the inbox oldest first: one headless turn per file,\n",
    "archived after its turn. --collect stops before the drain; --model selects its model.\n",
    "The runner calls collection and intake through their modules on separate cadences.\n",
  ].join(''),
  model: [
    "usage — mc model [list] [--json]   the ordered fast/large candidates and the review model\n",
    "        mc model add fast|large <tool>:<model>:<effort>   append a class candidate\n",
    "        mc model remove fast|large <tool>:<model>   remove that exact tool/model\n",
    "        mc model set review <tool>:<model>:<effort>   replace the review candidate\n",
    "\n",
    "The catalog does not poll capacity. --json applies only to list.\n",
  ].join(''),
  goal: [
    "usage — mc goal new <programme>/<goal> --repo <repo>[,<repo>] --class fast|large --title \"<title>\"   a goal: GOAL.md, LOG.md, and a worktree per repository on goal/<goal>, from origin/main\n",
    "        mc goal log [<programme>/<goal>] [--done \"…\"] [--comment \"…\"] [--next \"…\"] [--status open|review|blocked|done]   append a session's entry to LOG.md; the goal is MC_GOAL's when none is named\n",
    "        mc goal open|review|blocked|done [<programme>/<goal>] [--reason \"…\"]   set the goal's status, and log the reason; done is a person's;\n",
    "                                    going open, a branch with no commits of its own is remade from origin/main\n",
    "        mc goal show <programme>/<goal>   the goal, its last three log entries, and each worktree's state\n",
    "        mc goal list [<programme>]   every goal, one line each\n",
    "\n",
    "Goals live under ~/mc/programs/<programme>/goals/<goal>/.\nnew fetches each repository first; a failed fetch leaves no goal behind.\n",
    "log tags each entry with MC_TOOL and MC_MODEL (person when neither is set).\n",
    "Statuses are open, blocked and done; --reason supplies a status entry's comment.\n",
    "show includes each worktree's changed files, commits past origin/main and last commit.\n",
    "list includes repositories, status, session count and the last entry's next action.\n",
  ].join(''),
  status: [
    "usage — mc status <name> [--json] [--offline]\n",
    "\n",
    "One project: its plan, register progress, decisions, last three runner steps and open\n",
    "pull request. --json returns data; --offline avoids network reads.\n",
    "A goal is shown by mc goal show, not this verb. Without a name, use mc for the page.\n",
  ].join(''),
});

/** The same usage returned by the routed handler. */
export function commandUsage(verb) {
  if (!Object.hasOwn(COMMAND_USAGE, verb)) throw new RangeError(`No shared help for ${verb}`);
  return COMMAND_USAGE[verb];
}

/** Drop only the usage marker; the syntax and descriptions stay verbatim. */
export function commandReference(verb) {
  return commandUsage(verb).replace(/^usage [—:] /u, '  ').trimEnd();
}
