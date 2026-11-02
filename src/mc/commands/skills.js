/**
 * `mc skills` — the task skills mc installs for Claude Code and Codex.
 *
 *   mc skills [--json]          what canon and the programmes ship, against what
 *                               each tool's skills directory holds
 *   mc skills sync [--json]     make the `mc-*` entries there exactly that:
 *                               install, rewrite, remove a stale one; nothing
 *                               without the prefix is touched
 *
 * The same sync runs in `mc hook session-start` and `mc hook install`, so a
 * person rarely needs this verb; it is the door for a machine with no Claude
 * hook (Codex only) and for seeing what would change. The logic is
 * `../skills.js`.
 */
import { skillReport } from './roles.js';
import { skillStatus, syncSkills } from '../skills.js';

export function usage() {
  return [
    'usage — mc skills [--json]        mc\'s task skills, installed vs canon and the programme SKILL.md files\n',
    '        mc skills sync [--json]   install them for Claude (~/.claude/skills) and Codex (~/.agents/skills) as mc-*,\n',
    '                                  rewrite a changed one, remove a stale mc-* one; nothing else is touched\n',
  ].join('');
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const json = argv.includes('--json');
  const rest = argv.filter((arg) => arg !== '--json');
  const unknown = rest.find((arg) => arg.startsWith('--'));
  const error = unknown ? `unknown flag: ${unknown}`
    : rest[0] && !['sync', 'list'].includes(rest[0]) ? `unknown skills command "${rest[0]}"`
      : rest.length > 1 ? `unexpected arg: ${rest[1]}` : null;
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }
  if (rest[0] === 'sync') {
    let changed;
    try {
      changed = syncSkills(env);
    } catch (error) {
      stderr.write(`mc: skills sync failed — ${error.message}\n`);
      return 1;
    }
    if (json) { stdout.write(`${JSON.stringify({ ok: true, changed }, null, 2)}\n`); return 0; }
    if (!changed.length) { stdout.write('mc: skills already current\n'); return 0; }
    for (const row of changed) stdout.write(`mc: ${row.did} ${row.name} (${row.tool}, ${row.dir})\n`);
    return 0;
  }
  const status = skillStatus(env);
  if (json) { stdout.write(`${JSON.stringify({ ok: true, ...status }, null, 2)}\n`); return 0; }
  stdout.write(skillReport(status).replace(/^\n/u, ''));
  return 0;
}
