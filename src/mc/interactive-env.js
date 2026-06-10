const FALLBACK_TERM = 'xterm-256color';

export function normalizeInteractivePtyEnv({
  baseEnv = process.env,
  termName = null,
  fallbackTerm = FALLBACK_TERM,
} = {}) {
  const env = { ...baseEnv };
  const requestedTerm = nonEmptyString(termName) || nonEmptyString(env.TERM);
  const repairedTerm = !requestedTerm || requestedTerm === 'dumb' || requestedTerm === 'unknown';
  const effectiveTerm = repairedTerm ? fallbackTerm : requestedTerm;

  env.TERM = effectiveTerm;

  if (repairedTerm) {
    // Parent agent/non-TTY environments commonly set these to suppress their
    // own colour output. Do not leak that into an interactive child TUI.
    delete env.NO_COLOR;
    if (env.CLICOLOR === '0') delete env.CLICOLOR;
    if (!nonEmptyString(env.COLORTERM)) env.COLORTERM = 'truecolor';
  }

  return {
    env,
    termName: effectiveTerm,
    repairedTerm,
  };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
