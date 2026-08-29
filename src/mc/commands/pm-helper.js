/**
 * `mc pm-helper` — dormant since decision mc-1. See `pm.js` for why.
 *
 * The intake module (`pm-helper-intake.js`) stays: it is the one place that
 * knows the file forms, and it is still tested. It has no door on the CLI
 * while the role it served is dormant.
 */
export const DORMANT = 'mc pm-helper is dormant — the runner and mc brief replaced it (decision mc-1)';

export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  stderr.write(`${DORMANT}\n`);
  return 2;
}
