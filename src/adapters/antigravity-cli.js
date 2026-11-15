/**
 * Antigravity CLI (`agy`) adapter — unattended sessions only.
 *
 * agy is Google's coding CLI. This phase launches it headless: the build,
 * review, plan-review, finish, mend, plan, manager, intake and decision
 * sessions. The interactive declarations (a persistent driver, a server
 * session, conversation readers, a skills directory, …) are left undeclared
 * on purpose; an entrance that needs one refuses agy by asking the registry
 * (`declared(tool, 'PERSISTENT_DRIVER')`), and the next phase lifts the
 * refusal by declaring them.
 *
 * What agy takes (https://antigravity.google/docs/cli/headless/):
 *   -p <text>                       the prompt, as one argument
 *   --output-format stream-json|json|text
 *   --model <slug>                  the slug carries the effort as a suffix
 *   --conversation <id>             resume
 *   --dangerously-skip-permissions  an unapproved action is soft-denied otherwise
 *   --disable-slash-commands        a prompt that starts with "/" stays a prompt
 *   --add-dir <dir>                 repeatable
 * It has no system-prompt or instructions flag and no cwd flag, so a role's
 * instructions lead the prompt and the working directory is the process's.
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
    args: (argv = []) => [...argv],
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
 * (plan review, the helper and manager turns) prints the one JSON object.
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

/** A plan review passes the checkout as an allowed directory, before the output format. */
export const ALLOWED_DIR = Object.freeze({ flag: '--add-dir', before: '--output-format' });

/** The mechanism that reads this tool's plan usage; `src/mc/run.js` holds the code for it. */
export const CAPACITY_READER = 'agy-usage';

/** The plan windows a usage snapshot carries for this tool, in order. */
export const PLAN_WINDOWS = Object.freeze(['five_hour', 'weekly']);

/** A login interruption refuses the plan: a login that cannot succeed is not relaunched. */
export const LOGIN_REFUSES_PLAN = true;

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
  guarded: null,
  freshSessionId: false,
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
