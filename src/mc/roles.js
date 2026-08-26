/**
 * Roles: a named definition that sits on a work area.
 *
 * A role is not a flag and not a conversation. It is a file — frontmatter
 * for what mc needs to know (default model, singleton, tools), overlay text
 * for what the conversation needs to be told — and a mark on a work area
 * saying "everything started here carries this role". Every conversation
 * opened in a role's area inherits the overlay and the model default; a
 * conversation in an ordinary area inherits nothing, which is the whole
 * parallel-operation guarantee.
 *
 * Definitions live outside this repository: they are part of the user's
 * rulebook and version with it, not with mc. Until that catalogue has a
 * settled home, `MC_ROLES_DIR` points at wherever it is being drafted and
 * `<mc home>/roles` is where mc looks otherwise.
 *
 * The overlay reaches Claude conversations only, for now. Codex runs happily
 * inside a role's area — that is the point of the area — but keeps today's
 * plain instruction delivery until overlay delivery for it is designed.
 *
 * A role file:
 *
 *   ---
 *   name: worker
 *   model: fable
 *   singleton: false
 *   tools: claude, codex
 *   ---
 *   You are a worker: …
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonRoot } from './canon.js';
import { mcHome } from './paths.js';

/**
 * Reserved as identities, not as words: `mc new pm` succeeding would create
 * an ordinary session wearing the one name whose meaning is "the singleton
 * role's workspace", and everything that later trusts the name — attach,
 * status, send — would be talking to an impostor. `helper` is reserved
 * alongside because it is what people will actually type.
 */
export const RESERVED_ROLE_NAMES = Object.freeze(['pm', 'pm-helper', 'helper']);

const ROLE_COMMANDS = { pm: 'mc pm', 'pm-helper': 'mc pm-helper', helper: 'mc pm-helper' };

export function reservedRoleName(name) {
  // Case-insensitively: the filesystems this runs on mostly are, and `PM`
  // passing a guard that `pm` fails is the same impostor through a side door.
  return RESERVED_ROLE_NAMES.includes(String(name || '').toLowerCase());
}

/** The refusal, worded once: what is reserved, and which door is the real one. */
export function reservedRoleHint(name) {
  return `"${name}" is reserved for a role — that workspace is created by its own command (${ROLE_COMMANDS[String(name || '').toLowerCase()]})`;
}

export function rolesDir(env = process.env) {
  return env.MC_ROLES_DIR || join(mcHome(), 'roles');
}

/**
 * Every role defined in the catalogue, by file. A directory that does not
 * exist is an empty catalogue, not an error — roles are optional equipment.
 */
export function listRoles(env = process.env) {
  const dir = rolesDir(env);
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  } catch { return []; }
  const roles = [];
  for (const file of names) {
    const role = parseRole(readFile(join(dir, file)), file.replace(/\.md$/u, ''));
    if (role) roles.push({ ...role, path: join(dir, file) });
  }
  return roles;
}

/**
 * A role that ships with mc: `canon/roles/<name>.md` in the package. These
 * are the verbs' own roles (plan, brief, …) — repository-owned, versioned
 * with the code that launches them, never read from the user's catalogue.
 */
export function canonRolesDir() {
  return join(canonRoot(), 'roles');
}

export function readCanonRole(name) {
  const path = join(canonRolesDir(), `${name}.md`);
  const role = parseRole(readFile(path), name);
  return role ? { ...role, path } : null;
}

export function readRole(name, env = process.env) {
  const path = join(rolesDir(env), `${name}.md`);
  const role = parseRole(readFile(path), name);
  return role ? { ...role, path } : null;
}

/**
 * Frontmatter plus body. The keys mc understands are read; anything else in
 * the frontmatter is the rulebook's business and is left alone.
 */
export function parseRole(text, fallbackName = null) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // A rulebook checkout with CRLF endings is still a rulebook.
  const normalised = text.replace(/\r\n/gu, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(normalised);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z-]+):\s*(.*)$/u.exec(line.trim());
    if (pair) fields[pair[1].toLowerCase()] = pair[2].trim();
  }
  const overlay = match[2].trim() || null;
  return {
    name: fields.name || fallbackName,
    model: fields.model || null,
    singleton: fields.singleton === 'true',
    tools: fields.tools ? fields.tools.split(',').map((t) => t.trim()).filter(Boolean) : [],
    overlay,
  };
}

/**
 * The mark on a work area. One file, one word: which role this area carries.
 * Written once when the role command creates the area, read every time a
 * conversation starts there. An area without the file is an ordinary area,
 * and stays one — a role is decided at creation, never acquired.
 */
export function areaRoleName(areaPath) {
  return readFile(join(areaPath, '.mc-role'))?.trim() || null;
}

export function markAreaRole(areaPath, roleName) {
  writeFileSync(join(areaPath, '.mc-role'), `${roleName}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * The role carried by a work area, definition and all. A marked area whose
 * definition has gone missing reports the miss rather than pretending to be
 * ordinary: the caller decides whether that blocks or merely warns.
 */
export function areaRole(areaPath, env = process.env) {
  const name = areaRoleName(areaPath);
  if (!name) return null;
  const role = readRole(name, env);
  return role || { name, missing: true, path: join(rolesDir(env), `${name}.md`) };
}

/**
 * What a new conversation is told, per tool. The overlay rides behind the
 * profile, kept separate from it the way role text has always been.
 * Claude only for now: codex keeps exactly today's delivery until overlay
 * delivery for it is designed, and handing it half the mechanism would be
 * worse than handing it none.
 */
export function instructionsFor(toolId, profile, overlay) {
  if (toolId !== 'claude-code') return profile || null;
  const combined = [profile, overlay].filter(Boolean).join('\n\n---\n\n');
  return combined || null;
}

function readFile(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
