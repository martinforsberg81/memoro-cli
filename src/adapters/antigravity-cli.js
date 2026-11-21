/**
 * Antigravity CLI (`agy`) adapter — unattended and interactive sessions.
 *
 * agy is Google's coding CLI. mc launches it headless (the build, review,
 * finish, mend, manager, intake and decision sessions) and
 * in a person's terminal (`mc plan`, `mc martin`, the server's `mc session`).
 * An agy session lives in the terminal that started it: it has no daemon, no
 * remote client and no socket, so `PERSISTENT_DRIVER` is `terminal`, a server
 * start runs in the `ssh -t` terminal and `join` is refused.
 *
 * What agy takes (https://antigravity.google/docs/cli/headless/):
 *   -p <text>                       the prompt, as one argument (headless)
 *   -i <text>                       the opening message of an interactive session
 *   --output-format stream-json|json|text
 *   --model <slug>                  the slug carries the effort as a suffix
 *   --conversation <id>             resume
 *   --dangerously-skip-permissions  an unapproved action is soft-denied otherwise
 *   --disable-slash-commands        a prompt that starts with "/" stays a prompt
 *   --add-dir <dir>                 repeatable
 * It has no system-prompt or instructions flag and no cwd flag, so a role's
 * instructions lead the opening message and the working directory is the
 * process's. It records its own conversation id, so mc puts a launch marker
 * (a fresh nonce) at the head of the opening message and reads it back from
 * the transcript (`src/mc/launch-marker.js`).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ID = 'antigravity-cli';
export const LABEL = 'Antigravity CLI';
export const TOOL_NAME = 'agy';
export const CONFIG_PATH = null;

const AGY_BIN = 'agy';

export function detect() {
  return existsSync(join(homedir(), '.antigravity')) || existsSync(join(homedir(), '.local', 'bin', AGY_BIN));
}

function defaultWhich(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

/** `agy` resolved on PATH; `bin` is null when it is not installed, so a launch fails high with the hint. */
export function launchSpec({ resolveBinary = defaultWhich } = {}) {
  let bin = null;
  try { bin = resolveBinary(AGY_BIN); } catch { bin = null; }
  return {
    bin,
    executionAccess: 'host',
    // Interactive launches name their writable directories; a headless launch passes none.
    args: (argv = [], { writableDirectories = [] } = {}) => [...argv, ...writableDirectories.flatMap(dir => ['--add-dir', dir])],
    spawn: (argv = []) => ({ bin, args: [...argv] }),
    heartbeatSource: 'agy',
    label: LABEL,
    installHint: 'Install Antigravity CLI (agy) and sign in once; agy was not found on PATH',
  };
}

/** A model slug passed through as given: agy is the authority on what exists. */
export function modelArgs(model) {
  if (!model || typeof model !== 'string') return [];
  return ['--model', model];
}

/**
 * agy takes its effort in the model slug (`gemini-4-argon-high`); combining
 * `--effort` with a suffixed slug is undocumented, so none is passed.
 */
export function effortArgs() {
  return [];
}

/** No session switches: agy loads no project file mc must switch off, and has no cache TTL to choose. */
export function sessionArgs() {
  return [];
}

/** How a resume is named: `--conversation <id>`. */
export function resumeArgs({ sessionId, model = null } = {}) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  return ['--conversation', sessionId, ...modelArgs(model)];
}

/** The prompt cache is not agy's to choose; the conservative figure only makes a cold resume likelier. */
export function cacheTtlMs() {
  return 5 * 60_000;
}

/* ------------------------------------------------------------------
 * Seam declarations. `src/mc/` asks the registry (`index.js`) for these and
 * never compares this tool's name.
 * ------------------------------------------------------------------ */

/** The command name this tool's process runs under. */
export const PROCESS_NAME = 'agy';

/** Where role instructions are told apart from the task inside the single `-p` argument. */
export const INSTRUCTIONS_SEPARATOR = '\n\n--- TASK ---\n\n';

/**
 * The headless argument list. agy has no instructions flag, so the role's
 * instructions (`instr`, one element, the role's markdown) lead the prompt,
 * separated from the task so the session can tell them apart. A resumed
 * conversation already holds them and gets the task alone. `stream: false`
 * (the helper and manager turns) prints the one JSON object.
 */
export function headlessArgs({ modelArgs: model, session = [], instr = [], prompt, resume = null, stream = true }) {
  const lead = !resume && instr.length ? `${instr.join('\n\n')}${INSTRUCTIONS_SEPARATOR}` : '';
  const resumed = resume ? ['--conversation', resume] : [];
  return ['-p', `${lead}${prompt}`, '--output-format', stream ? 'stream-json' : 'json', '--dangerously-skip-permissions', '--disable-slash-commands', ...model, ...resumed, ...session];
}

/** The mechanism `src/mc/run-plan.js` reads this tool's headless output with. */
export const OUTPUT_READER = 'agy-stream';

/** No check-in and no stall guard, as codex: agy's stdin is not a channel. */
export const WATCH = null;

/** A named advisor model is not kept. */
export const ADVISOR_SUPPORT = false;

/** The name billing state and plan windows know this tool by. agy has no API route. */
export const BILLING_PROVIDER = 'agy';

/** Where this tool ranks when a provider priority is not `auto`: after codex (0) and claude (1). */
export const PROVIDER_PRIORITY_RANK = 2;

/** Intake and other catalog-routed turns run on a model the catalog does not name for this tool. */
export const INTAKE_FROM_CATALOG = null;

/** A reading passes the checkout as an allowed directory, before the output format. */
export const ALLOWED_DIR = Object.freeze({ flag: '--add-dir', before: '--output-format' });

/** The mechanism that reads this tool's plan usage; `src/mc/run.js` holds the code for it. */
export const CAPACITY_READER = 'agy-usage';

/** The plan windows a usage snapshot carries for this tool, in order. */
export const PLAN_WINDOWS = Object.freeze(['five_hour', 'weekly']);

/** A login interruption refuses the plan: a login that cannot succeed is not relaunched. */
export const LOGIN_REFUSES_PLAN = true;

/** A quota refusal names the model that was refused: the plan's other models still run. */
export const QUOTA_SCOPE = 'model';

/** No plan refusal or stream window is recorded in billing state for this tool. */
export const PLAN_STATE = null;

/** An unknown capacity reading may bootstrap a choice; candidates are not judged per model. */
export const MODEL_CHOICE = Object.freeze({ bootstrapsOnUnknown: true, perModel: false });

/**
 * How an instruction reaches a session: in the prompt (there is no flag for
 * it). `args` hands `headlessArgs` the markdown as its one `instr` element.
 */
export const INSTRUCTIONS = Object.freeze({
  channel: 'prompt',
  args: (markdown) => [markdown],
  onResume: false,
  // An interactive launch of a role's session ends its instructions with the launch identity marker.
  guarded: Object.freeze({ channel: 'prompt', args: (markdown) => [markdown], marker: true }),
  freshSessionId: false,
});

/**
 * The argv of an interactive launch, whole: a single `-i` argument leads with
 * the launch marker on its own line, then the instructions, then
 * `INSTRUCTIONS_SEPARATOR` and the prompt. A launch with neither is plain
 * `agy`. A resume names the conversation and the model and hands over no
 * instructions: the conversation already holds them.
 */
export function interactiveArgs({ model = null, resume = null, instructions = null, prompt = null, marker = null } = {}) {
  if (resume) return ['--conversation', resume, ...modelArgs(model)];
  const body = instructions && prompt ? `${instructions}${INSTRUCTIONS_SEPARATOR}${prompt}` : instructions || prompt || null;
  return [...modelArgs(model), ...(body ? ['-i', marker ? `${marker}\n\n${body}` : body] : [])];
}

/** The declaration `src/mc/work-open.js` asks for: this tool builds its interactive argv whole. */
export const INTERACTIVE_ARGS = interactiveArgs;

/** The model a role's `mc plan` runs on. */
export const PLAN_MODEL = 'gemini-4-argon-high';

/** A session lives in the terminal that started it: no daemon, no join, no socket. */
export const PERSISTENT_DRIVER = 'terminal';

/** A server start runs in the `ssh -t` terminal (the tty mechanism) and is never joined. */
export const SERVER_SESSION = Object.freeze({ mechanism: 'tty', name: 'Antigravity' });

/** No session outlives the terminal and none is driven remotely. */
export const BACKGROUND = false;
export const REMOTE_CONTROL = false;

/** The folder is recorded in agy's `trustedWorkspaces` before agy starts (`src/mc/agy-trust.js`). */
export const FOLDER_TRUST = 'agy-trust';

/** The conversation's launch is found by the nonce mc put in its opening message. */
export const IDENTITY_READER = 'launch-log';

/** The model comes from the last PLANNER_RESPONSE step. */
export const MODEL_READER = 'agy-step';

/** What the last step says about whose turn it is. */
export const TAIL_READER = 'agy-tail';

/** Conversations are found through agy's brain directory and its conversation database. */
export const CONVERSATION_SOURCE = 'agy-brain';

/** A conversation is removed by its own files. */
export const CONVERSATION_DELETE = Object.freeze({ mechanism: 'agy-conversation', failed: 'conversation-delete-failed' });

/** What a marked conversation cost, read from its steps. */
export const COST_SOURCE = Object.freeze({ files: 'agy-brain', reader: 'agy-steps', option: 'agyDir' });

/** Where this tool loads skills from. */
export const SKILLS_DIR = (_env, home) => join(home, '.gemini', 'antigravity-cli', 'skills');

/**
 * Where and how mc registers its hooks: one top-level entry in the global hooks file,
 * three events, each command ending in `|| true` so a failing mc never blocks agy.
 */
export const HOOKS = Object.freeze({
  dialect: 'agy-hooks',
  file: (_env, home) => join(home, '.gemini', 'config', 'hooks.json'),
  entry: 'mc',
  matcher: 'run_command|read_file|view_file|edit_file|write_to_file',
  tool: 'agy',
});

/** Variables of this tool's own that are dropped at every unattended launch of it, beside the provider keys. */
export const LAUNCH_DROP_ENV = Object.freeze(['AGY_ADC_AUTH']);

const LEVEL_SUFFIX = /-(low|medium|high|xhigh|max)$/u;

/**
 * Whether a candidate's effort agrees with its slug: `gemini-4-argon-high` is
 * the high level, so effort `medium` contradicts it. A slug with no level
 * suffix takes any effort. Returns the problem as text, or null.
 */
export function candidateProblem({ model, effort }) {
  const suffix = LEVEL_SUFFIX.exec(String(model || ''))?.[1];
  if (!suffix || suffix === effort) return null;
  return `effort: ${model} carries level ${suffix} in its name, so the effort is ${suffix}, not ${effort}`;
}
