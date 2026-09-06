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
 * The overlay reaches both tools, through whichever channel each one takes
 * instructions on at launch (`--append-system-prompt` for Claude, `-c
 * instructions=` for codex; see `portrait.js`). It is one body of text with
 * the profile, not a second mechanism.
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
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonRoot } from './canon.js';
import { mcHome } from './paths.js';

/**
 * Reserved as an identity, not as a word: `mc helper` owns `~/mc/helper/`
 * outright, and a workarea of that name would be a second thing living in the
 * same directory.
 *
 * `pm` and `pm-helper` were reserved beside it, for the same reason and for a
 * pair of roles that no longer exist. They are ordinary names again.
 */
export const RESERVED_ROLE_NAMES = Object.freeze(['helper']);

const ROLE_COMMANDS = { helper: 'mc helper' };

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
 *
 * A leading underscore means "not a role": `_common.md` is the text every role
 * session is told (see `sharedRoleText`), and a catalogue directory holding a
 * copy of it must not grow a role named `_common` out of it.
 */
export function listRoles(env = process.env) {
  const dir = rolesDir(env);
  let names = [];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
      .sort();
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

/**
 * The one file whose text every role session is told, whichever role it is.
 *
 * It lives in `canon/roles/` beside the roles themselves, under a name no role
 * can have: `listRoles` makes a role out of every `*.md` in a catalogue
 * directory, so a `common.md` copied into a user's catalogue would be listed
 * and shown as a role named `common`. The underscore is the convention that
 * says otherwise, and `listRoles` skips it.
 *
 * It is read here, at assembly, and deliberately not folded into
 * `readCanonRole`'s `overlay`. `run.js` tests `role.overlay` to decide whether
 * a role file is installed at all, and a shared preamble folded in ahead of
 * that check would make a missing `repair.md` look present — a ninety-minute
 * session launched with no instructions for what it is doing. `mc roles show`
 * and `tests/mc/roles-decisions.test.js` read `overlay` as the role's own
 * words for the same reason.
 */
export const SHARED_ROLE_FILE = '_common.md';

export function sharedRoleText() {
  return readFile(join(canonRolesDir(), SHARED_ROLE_FILE))?.trim() || null;
}

/**
 * A passage two roles share, carried by reference rather than copied.
 *
 * `_common.md` is what *every* role session is told. The rules for writing a
 * `PLAN.json` are not that: two roles write plans (the planning session, and
 * the brief since 2026-09-06) and six do not, and telling a `step` session how
 * to write a plan it may never write is worse than telling it nothing. So a
 * shared passage is its own file under the same underscore convention —
 * `listRoles` skips it, `parseRole` refuses it for want of frontmatter — and a
 * role file names it on a line of its own:
 *
 *   @include _plan-writing.md
 *
 * The line is replaced with that file's text at assembly, in `instructionsFor`,
 * which is the one door every launch path goes through. It is deliberately not
 * expanded in `parseRole`: `run.js` and the role commands test `role.overlay`
 * to decide whether a role file is installed at all, and that has to stay the
 * role's *own* words (see `SHARED_ROLE_FILE`).
 *
 * Only an underscored name in `canon/roles/` can be included — a role cannot
 * include a role, so there is no recursion to bound. A name that is not there
 * is left standing in the text rather than silently dropped: a visible
 * `@include` line in a session's instructions is a broken install somebody can
 * see, and a rule that quietly vanished is not.
 */
const ROLE_INCLUDE = /^@include[ \t]+(_[A-Za-z0-9._-]+\.md)[ \t]*$/gmu;

export function expandRoleIncludes(text) {
  if (typeof text !== 'string' || !text.includes('@include')) return text;
  return text.replace(ROLE_INCLUDE, (line, file) => {
    const passage = readFile(join(canonRolesDir(), file))?.trim();
    return passage || line;
  });
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
  // The user's catalogue first — it is their rulebook, and a role defined
  // there is the one they meant. Canon is the fallback so a role mc ships
  // (worker, since the PM went dormant) reaches every conversation in its
  // area on a machine with no catalogue at all.
  const role = readRole(name, env) || readCanonRole(name);
  return role || { name, missing: true, path: join(rolesDir(env), `${name}.md`) };
}

/**
 * What a new conversation is told: the profile, the text every role session
 * shares, then this role's own overlay — separated so each still reads as
 * itself.
 *
 * This is the single door. Four paths launch a session with instructions —
 * `work-open.js` twice (a conversation in a work area, and the argv a handoff
 * respawns), `run.js` for a runner session and `helper-turn.js` for the intake
 * turn — and each of them used to write the join out for itself. Four copies
 * of one rule is four places for it to drift, and the day they disagree is the
 * day one kind of session quietly stops being told something every other kind
 * is.
 *
 * No overlay is no role, and no role is no shared text: an ordinary work area
 * inherits nothing, which is the whole parallel-operation guarantee.
 *
 * The same text for every tool, because the channel is the same shape for
 * every tool — `profileArgs` already carries a body of markdown to each one
 * at launch, and codex's `-c instructions=` was verified to layer over the
 * base instructions rather than replace them (see `portrait.js`). A tool mc
 * has no channel for gets an empty argument list there and is unaffected by
 * what is assembled here.
 *
 * A passage two roles share is pulled in here too, where the overlay is
 * expanded — see `expandRoleIncludes`. It is the same door because a second
 * one is how a kind of session quietly stops being told something.
 */
export function instructionsFor(toolId, profile, overlay) {
  const shared = overlay ? sharedRoleText() : null;
  const body = expandRoleIncludes(overlay);
  const combined = [profile, shared, body].filter(Boolean).join('\n\n---\n\n');
  return combined || null;
}

/* ------------------------------------------------- what a session ran on */

/**
 * A short fingerprint of a body of text, for a register to keep.
 *
 * The registers are read on every draw of the page, so what goes in them is a
 * hash and not the text: a role overlay is kilobytes of prose and a session's
 * instructions are more, and none of it is anything the page would print.
 * Twelve hex characters of sha256 is enough to tell two revisions of one file
 * apart, which is the only comparison anyone makes with it.
 */
export function textDigest(text) {
  if (typeof text !== 'string' || !text) return null;
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}`;
}

/** Where a role's file was read from — mc's own canon, or the user's catalogue. */
export function roleSourceOf(role) {
  if (!role?.path) return null;
  return role.path.startsWith(`${canonRolesDir()}/`) ? 'canon' : 'catalogue';
}

/**
 * What a register keeps about the text a session was launched on: which role
 * it was, which catalogue that role came from, and a digest of each of the two
 * things that can change under it.
 *
 * Two digests, because the two answers are different questions and only one of
 * them is a fault. `digest` is over the assembled instructions — profile,
 * `_common.md` and the overlay, joined the way `instructionsFor` joins them —
 * and is the honest answer to *is this session running what a launch would
 * produce now*. `text_digest` is over the role's own body alone, expanded, and
 * is the answer to *is this session running the role file on disk today*. A
 * Coding Profile edited at lunchtime moves the first and not the second, and a
 * verb that could not tell those apart would report every live session as
 * drifted every time Martin touched his profile.
 *
 * A launch that assembled nothing — a resumed conversation, which carries its
 * instructions in its own history — records the role and no digests: what that
 * session is running is not knowable from here, and a digest of today's file
 * would be a claim about it that nobody checked.
 */
export function roleRecord({ name = null, source = null, overlay = null, instructions = null } = {}) {
  if (!name) return null;
  return {
    name,
    source: source || 'canon',
    digest: textDigest(instructions),
    text_digest: textDigest(expandRoleIncludes(overlay)),
  };
}

function readFile(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
