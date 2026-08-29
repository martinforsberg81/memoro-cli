/**
 * `mc pm` — dormant since decision mc-1 (2026-08-26, option A).
 *
 * The resident PM was the session that triaged the work, woke the others and
 * held the queue. The runner (`mc run`) took the triage and the queue, and
 * `mc brief` took the decisions; a resident model sitting between Martin and
 * his projects had nothing left to hold. So the command answers instead of
 * opening: one line, exit 2, nothing created and nothing deleted.
 *
 * Dormant, not gone. The machinery it stood on — `role-singleton.js`, the
 * reserved names in `roles.js`, `pm-helper-intake.js` — is still here and
 * still right; if a PM returns it returns in modified form, and cutting the
 * code belongs with the wider surface cut, not with the ruling.
 */
export const DORMANT = 'mc pm is dormant — the runner and mc brief replaced it (decision mc-1)';

export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  stderr.write(`${DORMANT}\n`);
  return 2;
}
