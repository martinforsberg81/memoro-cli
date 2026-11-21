/** Session identity shared by launchers, SessionStart and the commands only a person runs. */
import { relative, resolve, sep } from 'node:path';

import { workRoot } from './paths.js';
import { BUILD_ROLES } from './run-plan.js';

/** Written in session scratch only after every registered PR has been queued. */
export const MERGE_HANDOFF_FILE = '.mc-merge-handoff.json';

/**
 * Identity belongs to the child, never to the session that started mc.
 * MC_HEADLESS is the runner's and the intake turn's mark on a session nobody
 * watches; an interactive session opened from inside one must not inherit it.
 */
export const SESSION_IDENTITY_ENV = ['MC_ROLE', 'MC_PROGRAMME', 'MC_GOAL', 'MC_STEP', 'MC_PROJECT', 'MC_HEADLESS'];

export function withoutSessionIdentity(env) {
  const next = { ...env };
  for (const key of SESSION_IDENTITY_ENV) delete next[key];
  return next;
}

/** Shared aliases for live identity and historical launch evidence. */
export function normalizeSessionRole(role) {
  if (role === 'brief') return 'manager';
  return role || null;
}

/** Environment first; cwd is the fallback for a session opened by hand. */
export function sessionIdentity({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.MC_ROLE) return { role: normalizeSessionRole(env.MC_ROLE), programme: env.MC_PROGRAMME || null, source: 'MC_ROLE' };
  if (env.MC_GOAL) return { role: BUILD_ROLES.goal, programme: env.MC_PROGRAMME || env.MC_GOAL.split('/')[0], source: 'MC_GOAL' };

  const path = relative(resolve(workRoot(env)), resolve(cwd));
  const parts = path.split(sep);
  const [first, second, third, fourth] = parts;
  const found = (role, programme = null) => ({ role, programme, source: 'cwd' });
  if (first === 'programs' && second && third === 'goals' && fourth) return found(BUILD_ROLES.goal, second);
  if (first === 'brief') return found('manager');
  if (['manager', 'helper', 'martin', 'intake'].includes(first)) return found(first);
  return found(null);
}

export function sessionRoleLine(identity, { cwd = process.cwd(), env = process.env } = {}) {
  const { role, programme } = identity;
  if (!role) return `mc — session role unknown: checked MC_ROLE, MC_GOAL and cwd ${cwd} against ${workRoot(env)}.`;
  const name = programme ? ` for programme \`${programme}\`` : '';
  return `You are the ${roleLabel(role)}${name}.`;
}

/**
 * A role's name as a sentence says it: `build-session:goal` is the build
 * session (goal), `mend-session` the mend
 * session. A name of another shape —
 * `brief`, `helper`, a catalogue's own — is that name's session.
 */
export function roleLabel(role) {
  const [file, part] = String(role).split(':');
  return `${file.replace(/-session$/u, '')} session${part ? ` (${part})` : ''}`;
}

/**
 * Why `command` (`mc programs archive`) is refused here, or null for a person. A coding agent outside mc's
 * directories is still a session, not a person.
 */
export function personCommandRefusal(command, context = {}) {
  const env = context.env || process.env;
  const identity = sessionIdentity(context);
  const agent = ['CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI'].find((key) => env[key]);
  if (!identity.role && !agent) return null;
  return `${sessionRoleLine(identity, context)} ${command} is a person's command, not a session's: you are already in ${identity.role ? `a ${roleLabel(identity.role)}` : `a coding-agent session (${agent})`}.`;
}

/** Build a fresh launch identity, preserving non-identity environment. */
export function sessionLaunchEnvironment({ env = process.env, cwd, role = null, programme = null } = {}) {
  const clean = withoutSessionIdentity(env);
  const inferred = sessionIdentity({ cwd, env: clean });
  const next = { ...clean, MC_ROLE: role || inferred.role || 'work' };
  if (programme || inferred.programme) next.MC_PROGRAMME = programme || inferred.programme;
  return next;
}
