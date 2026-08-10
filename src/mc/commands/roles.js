/**
 * `mc roles` — the defined roles, read from their files.
 *
 * mc does not own the definitions; the rulebook does. This is a window onto
 * that catalogue: list what is defined, show one whole — frontmatter facts
 * first, overlay text after — so what a role session will be told is never
 * a guess.
 */
import { listRoles, readRole, rolesDir } from '../roles.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc roles list [--json]\n');
    stderr.write('        mc roles show <role> [--json]\n');
    return 2;
  }

  if (opts.verb === 'show') {
    const role = readRole(opts.name);
    if (!role) {
      stderr.write(`mc: no role "${opts.name}" — looked for ${rolesDir()}/${opts.name}.md\n`);
      return 1;
    }
    if (opts.json) { stdout.write(`${JSON.stringify({ ok: true, role }, null, 2)}\n`); return 0; }
    stdout.write(`${role.name}  (${role.path})\n`);
    stdout.write(`  model:     ${role.model || '(tool default)'}\n`);
    stdout.write(`  singleton: ${role.singleton}\n`);
    stdout.write(`  tools:     ${role.tools.length ? role.tools.join(', ') : '(any)'}\n`);
    stdout.write(role.overlay ? `\n${role.overlay}\n` : '\n(no overlay text)\n');
    return 0;
  }

  const roles = listRoles();
  if (opts.json) { stdout.write(`${JSON.stringify({ ok: true, dir: rolesDir(), roles }, null, 2)}\n`); return 0; }
  if (roles.length === 0) {
    stdout.write(`mc: no roles defined in ${rolesDir()}\n`);
    stdout.write('mc: a role is a markdown file there — frontmatter for mc, overlay text for the conversation\n');
    return 0;
  }
  stdout.write(`${rolesDir()}\n`);
  for (const role of roles) {
    const marks = [role.model || 'tool default', role.singleton ? 'singleton' : null]
      .filter(Boolean).join(' · ');
    stdout.write(`  ${role.name.padEnd(12)} ${marks}\n`);
  }
  return 0;
}

export function parseArgs(argv) {
  const opts = { verb: 'list', name: null, json: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    positional.push(arg);
  }
  if (positional.length === 0) return opts;
  const [head, ...rest] = positional;
  if (head === 'list') return rest.length ? { ...opts, error: `unexpected arg: ${rest[0]}` } : opts;
  if (head === 'show') {
    opts.verb = 'show';
    opts.name = rest[0] || null;
    if (!opts.name) return { ...opts, error: 'which role? mc roles show <role>' };
    if (rest.length > 1) return { ...opts, error: `unexpected arg: ${rest[1]}` };
    return opts;
  }
  return { ...opts, error: `unknown roles command "${head}"` };
}
