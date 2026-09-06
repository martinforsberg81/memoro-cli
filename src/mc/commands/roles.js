/**
 * `mc roles` — the defined roles, read from their files.
 *
 * mc does not own the definitions; the rulebook does. This is a window onto
 * that catalogue: list what is defined, show one whole — frontmatter facts
 * first, overlay text after — so what a role session will be told is never
 * a guess.
 *
 * `check` is the third window and the only one that looks at what is running.
 * `show` prints a role's own words as they are on disk; `check` prints the
 * whole of what a launch would hand a session today — profile, `_common.md`,
 * the overlay with its includes expanded, joined by `instructionsFor` — and
 * holds it against the digests the live sessions recorded when they started.
 * A session whose text is not that one is named. That question had no answer
 * at all before: this brief's own role text on 2026-09-06 held two sentences
 * `canon/roles/brief.md` had not held since #614 landed the day before, and
 * nothing on the machine could have said so.
 */
import { join } from 'node:path';

import { foregroundDir } from '../foreground.js';
import { readForeground } from '../page-collect.js';
import { workRoot } from '../paths.js';
import { loadProfile } from '../portrait.js';
import {
  canonRolesDir, expandRoleIncludes, instructionsFor, listRoles, readCanonRole, readRole,
  rolesDir, textDigest,
} from '../roles.js';
import { pidAlive, readCurrents } from '../status-collect.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc roles list [--json]\n');
    stderr.write('        mc roles show <role> [--json]\n');
    stderr.write('        mc roles check [<role>] [--json]\n');
    return 2;
  }

  if (opts.verb === 'check') return check(opts, { stdout, stderr, deps });

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
  // A role is optional here and the verb means something either way: named, it
  // prints that role's assembled text and checks the sessions running it;
  // bare, it checks every live session against whatever role each one names.
  if (head === 'check') {
    opts.verb = 'check';
    opts.name = rest[0] || null;
    if (rest.length > 1) return { ...opts, error: `unexpected arg: ${rest[1]}` };
    return opts;
  }
  return { ...opts, error: `unknown roles command "${head}"` };
}

/* ------------------------------------------------------------------ check */

/**
 * The catalogue first and canon second — the same precedence `areaRole` gives
 * a session, so what this resolves is what a launch would resolve. A role
 * defined in the user's own catalogue is not a stale copy of canon's; it is
 * their rulebook, and reporting it as drift would be reporting the design.
 */
function resolveRole(name, env) {
  const own = readRole(name, env);
  if (own) return { ...own, source: 'catalogue' };
  const canon = readCanonRole(name);
  return canon ? { ...canon, source: 'canon' } : null;
}

/** The same role, from the catalogue the session recorded and no other. */
function roleFromSource(name, source, env) {
  if (source === 'canon') {
    const canon = readCanonRole(name);
    return canon ? { ...canon, source: 'canon' } : null;
  }
  const own = readRole(name, env);
  return own ? { ...own, source: 'catalogue' } : null;
}

/**
 * What a launch would hand a session for this role, right now.
 *
 * The tool is the role's own first tool because that is what the launch verbs
 * pass; it changes nothing — `instructionsFor` assembles the same text for
 * every tool, and only `profileArgs` after it differs — but passing the wrong
 * one would still be describing a launch nobody makes.
 */
function assembleFor(role, profile) {
  const instructions = instructionsFor(role.tools?.[0] || 'claude', profile, role.overlay);
  return {
    name: role.name,
    source: role.source,
    path: role.path,
    digest: textDigest(instructions),
    // The role's own body, includes expanded — the same text `roleRecord`
    // hashes at launch, and the half of the comparison the profile cannot move.
    text_digest: textDigest(expandRoleIncludes(role.overlay)),
    instructions,
  };
}

/** Everything alive that either register knows about, in one shape. */
function liveSessions(env = process.env) {
  const dir = join(workRoot(env), 'runner');
  const sessions = [];
  for (const item of readForeground(foregroundDir(env))) {
    if (!pidAlive(item.pid)) continue;
    sessions.push({
      pid: item.pid,
      what: item.verb ? `mc ${item.verb}` : 'a session',
      where: item.area || null,
      started: item.started || null,
      role: item.role || null,
    });
  }
  for (const item of readCurrents(dir)) {
    if (!pidAlive(item.pid)) continue;
    sessions.push({
      pid: item.pid,
      what: `${item.kind || 'session'} ${item.name || ''}`.trim(),
      where: item.repo || null,
      started: item.started || null,
      role: item.role || null,
    });
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

/**
 * Which of the two things that can move has moved under this session.
 *
 * `drift` is the fault the verb exists for: the role file has been edited
 * since the session was launched, so it is running instructions nobody can
 * read off disk any more. `profile` is not that fault — the Coding Profile is
 * assembled into the same body of text and changes it without the role file
 * moving at all — and saying so separately is the difference between a verb
 * worth running and one that cries drift every time Martin edits his profile.
 */
export function verdictFor(record, today) {
  if (!record) return { verdict: 'unrecorded', detail: 'an ordinary session, or one started before mc kept this' };
  if (!today) return { verdict: 'no-role-file', detail: `no ${record.source} role "${record.name}" on disk today` };
  if (!record.digest) return { verdict: 'resumed', detail: 'no instructions were assembled — a resumed conversation carries its own' };
  if (record.digest === today.digest) return { verdict: 'ok', detail: null };
  if (record.text_digest && record.text_digest !== today.text_digest) {
    return { verdict: 'drift', detail: `started on ${record.text_digest}, ${record.name}.md is ${today.text_digest} now` };
  }
  return { verdict: 'profile', detail: `the role text matches; the Coding Profile has changed since (${record.digest} → ${today.digest})` };
}

/** Named in the report as running something other than what a launch produces now. */
const NAMED = new Set(['drift', 'profile', 'no-role-file']);

async function check(opts, { stdout, stderr, deps }) {
  const env = deps.env || process.env;
  const profile = await (deps.profile || loadProfile)({ env });

  let asked = null;
  if (opts.name) {
    const role = (deps.resolve || resolveRole)(opts.name, env);
    if (!role) {
      stderr.write(`mc: no role "${opts.name}" — looked in ${rolesDir(env)} and ${canonRolesDir()}\n`);
      return 1;
    }
    asked = assembleFor(role, profile);
  }

  const today = new Map();
  if (asked) today.set(`${asked.source}:${asked.name}`, asked);
  const sessions = [];
  for (const session of (deps.sessions || liveSessions)(env)) {
    const record = session.role;
    if (opts.name && record?.name !== opts.name) continue;
    let now = null;
    if (record) {
      const key = `${record.source}:${record.name}`;
      if (!today.has(key)) {
        const role = roleFromSource(record.name, record.source, env);
        today.set(key, role ? assembleFor(role, profile) : null);
      }
      now = today.get(key);
    }
    sessions.push({ ...session, ...verdictFor(record, now) });
  }
  const named = sessions.filter((s) => NAMED.has(s.verdict));

  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: true, role: asked, sessions, drifting: named.length }, null, 2)}\n`);
    return 0;
  }

  if (asked) {
    stdout.write(`${asked.name}  (${asked.source})  ${asked.path}\n`);
    stdout.write(`  role text     ${asked.text_digest || '(no overlay)'}\n`);
    stdout.write(`  instructions  ${asked.digest || '(nothing to hand over)'}   profile + _common.md + overlay, as a launch joins them\n\n`);
  }

  if (sessions.length === 0) {
    stdout.write(opts.name
      ? `no live session is running the ${opts.name} role\n`
      : 'no live session is registered on this machine\n');
  } else {
    // The tally counts every verdict rather than only the fault: "nothing
    // drifted" over ten sessions that recorded nothing at all would be a
    // reassurance nobody measured.
    const tally = [...new Set(sessions.map((s) => s.verdict))]
      .map((verdict) => `${sessions.filter((s) => s.verdict === verdict).length} ${verdict}`);
    stdout.write(`${sessions.length} live session${sessions.length === 1 ? '' : 's'}: ${tally.join(', ')}\n`);
    for (const session of sessions) {
      const where = session.where ? ` ${session.where}` : '';
      const name = `${session.what}${where}`;
      stdout.write([
        `  ${String(session.pid).padEnd(7)}`,
        `${(name.length > 30 ? `${name.slice(0, 29)}…` : name).padEnd(31)}`,
        `${(session.started || '').padEnd(21)}`,
        `${(session.role?.name || '-').padEnd(9)}`,
        `${session.verdict}${session.detail ? ` — ${session.detail}` : ''}\n`,
      ].join(''));
    }
  }

  if (asked?.instructions) {
    stdout.write(`\n----- what a launch would hand a ${asked.name} session today -----\n`);
    stdout.write(`${asked.instructions}\n`);
  }
  return 0;
}
