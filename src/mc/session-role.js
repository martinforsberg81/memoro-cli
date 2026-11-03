/** Session identity shared by launchers, SessionStart and the plan entrance. */
import { relative, resolve, sep } from 'node:path';

import { workRoot } from './paths.js';

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

/** Environment first; cwd is the fallback for a session opened by hand. */
export function sessionIdentity({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.MC_ROLE) return { role: env.MC_ROLE, programme: env.MC_PROGRAMME || null, source: 'MC_ROLE' };
  if (env.MC_GOAL) return { role: 'build-goal', programme: env.MC_PROGRAMME || env.MC_GOAL.split('/')[0], source: 'MC_GOAL' };
  if (env.MC_STEP) return { role: 'build-project', programme: env.MC_PROGRAMME || null, source: 'MC_STEP' };

  const path = relative(resolve(workRoot(env)), resolve(cwd));
  const parts = path.split(sep);
  const [first, second, third, fourth] = parts;
  const found = (role, programme = null) => ({ role, programme, source: 'cwd' });
  if (first === 'programs' && second) {
    if (third === 'goals') return fourth ? found('build-goal', second) : found(null);
    return found('plan', second);
  }
  // Layout 1 remains readable while machines move to programs/.
  if (first === 'plan' && second) return found('plan', second);
  if ((first === 'step' && second) || (first === 'runner' && second === 'step' && third)) return found('build-project');
  if (['brief', 'helper', 'intake'].includes(first)) return found(first);
  return found(null);
}

export function sessionRoleLine(identity, { cwd = process.cwd(), env = process.env } = {}) {
  const { role, programme } = identity;
  if (!role) return `mc — session role unknown: checked MC_ROLE, MC_GOAL, MC_STEP and cwd ${cwd} against ${workRoot(env)}.`;
  const name = programme ? ` for programme \`${programme}\`` : '';
  if (role === 'plan') return `You are the plan session${name}. \`mc plan\` is the person's command that opens a session like this one; you never run it. Plans change through \`mc project …\`.`;
  return `You are the ${role} session${name}.`;
}

/** A coding agent outside mc's directories is still a session, not a person. */
export function planSessionRefusal(context = {}) {
  const env = context.env || process.env;
  const identity = sessionIdentity(context);
  const agent = ['CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI'].find((key) => env[key]);
  if (!identity.role && !agent) return null;
  return `${sessionRoleLine(identity, context)} mc plan is a person's command, not a session's: you are already in ${identity.role ? `a ${identity.role} session` : `a coding-agent session (${agent})`}. Use mc project new, mc project step add or mc project send to change plans; do not open another plan session.`;
}

/** Build a fresh launch identity, preserving non-identity environment. */
export function sessionLaunchEnvironment({ env = process.env, cwd, role = null, programme = null } = {}) {
  const clean = withoutSessionIdentity(env);
  const inferred = sessionIdentity({ cwd, env: clean });
  const next = { ...clean, MC_ROLE: role || inferred.role || 'work' };
  if (programme || inferred.programme) next.MC_PROGRAMME = programme || inferred.programme;
  return next;
}
