/**
 * Task skills: the guidance every session reaches the same way.
 *
 * A role reaches only a session mc launches (`--append-system-prompt`, see
 * `roles.js`); a session opened by hand in a repository sees that repository's
 * `AGENTS.md`/`CLAUDE.md` and nothing of mc's. A skill is the one channel both
 * have: Claude Code and Codex each read user-level skills from a directory in
 * the home, list every skill's `name` and `description` to the model, and load
 * the body when the description says it applies.
 *
 * So mc ships its task texts as skills — `canon/skills/<name>/SKILL.md`, beside
 * `canon/roles/` — and installs them, under an `mc-` prefix, where each tool
 * looks:
 *
 *   Claude Code  `~/.claude/skills/` (`$CLAUDE_CONFIG_DIR/skills/` when set)
 *   Codex        `~/.agents/skills/` — the user scope in Codex's own skills
 *                documentation (developers.openai.com/codex/skills, read
 *                2026-11-02; codex-cli 0.166 scans it as `user-agent-skills`)
 *
 * A programme can have one more: `~/mc/programs/<programme>/SKILL.md`, when the
 * file is there, installed the same way as `mc-programme-<programme>` with a
 * description that names the programme. Nothing is generated for a programme
 * without the file.
 *
 * The prefix is the ownership line. `syncSkills` makes the `mc-*` entries in
 * each directory exactly what canon and the programmes hold — an install that
 * differs is rewritten, an `mc-*` entry nobody ships any more is removed — and
 * never reads, writes or removes an entry without the prefix.
 *
 * The sync runs in `mc hook session-start` (every Claude Code session, opened
 * by mc or by hand, runs it first), in `mc hook install`, and as `mc skills
 * sync`. `mc roles check` and `mc skills` report what would change.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { canonRoot } from './canon.js';
import { programsHome } from './paths.js';

export const SKILL_PREFIX = 'mc-';
export const SKILL_FILE = 'SKILL.md';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/u;

export function canonSkillsDir() {
  return join(canonRoot(), 'skills');
}

function homeOf(env) {
  return env.HOME || homedir();
}

/** Where each tool reads user-level skills, for this environment. */
export function skillTargets(env = process.env) {
  const home = homeOf(env);
  return [
    { tool: 'claude', dir: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills') },
    { tool: 'codex', dir: join(home, '.agents', 'skills') },
  ];
}

/**
 * Frontmatter plus body, the shape both tools read. `name` and `description`
 * are required — a skill without a description is one no tool can decide to
 * load — so either missing is `null`, not a skill.
 */
export function parseSkill(text) {
  if (typeof text !== 'string') return null;
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(text.replace(/\r\n/gu, '\n'));
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z-]+):\s*(.*)$/u.exec(line.trim());
    if (pair) fields[pair[1].toLowerCase()] = pair[2].trim();
  }
  if (!fields.name || !fields.description) return null;
  return { name: fields.name, description: fields.description, frontmatter: match[1], body: match[2] };
}

/** The frontmatter as a skill file writes it: `name`, `description`, then any other key as it stood. */
function renderSkill({ name, description, rest = [], note, body }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...rest,
    '---',
    `<!-- Installed by mc from ${note}. mc rewrites this file; change the source. -->`,
    '',
    body.replace(/^\n+/u, ''),
  ].join('\n').replace(/\n*$/u, '\n');
}

function otherKeys(frontmatter) {
  return frontmatter.split('\n').filter((line) => !/^(name|description):/iu.test(line.trim()) && line.trim());
}

function filesUnder(dir) {
  const out = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(dir, path).split(sep).join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/**
 * Every skill canon ships, parsed, with what its install holds. A directory
 * whose `SKILL.md` does not parse is reported as `invalid` rather than skipped:
 * a skill that silently never installs is the failure this exists to prevent.
 */
export function canonSkills({ dir = canonSkillsDir() } = {}) {
  let names = [];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  return names.map((name) => {
    const path = join(dir, name, SKILL_FILE);
    let text = null;
    try { text = readFileSync(path, 'utf8'); } catch { /* no SKILL.md */ }
    const skill = parseSkill(text);
    if (!skill) return { name, path, invalid: `${name}/${SKILL_FILE} has no name or description` };
    if (skill.name !== name || !SKILL_NAME.test(name)) return { name, path, invalid: `${name}/${SKILL_FILE} names itself "${skill.name}"` };
    const installName = `${SKILL_PREFIX}${name}`;
    const files = filesUnder(join(dir, name));
    files[SKILL_FILE] = renderSkill({
      name: installName, description: skill.description, rest: otherKeys(skill.frontmatter),
      note: `canon/skills/${name}/${SKILL_FILE}`, body: skill.body,
    });
    return { name, installName, description: skill.description, path, source: 'canon', files };
  });
}

/**
 * The programme skills: a `SKILL.md` in a programme's directory. The file may
 * carry its own frontmatter or none; either way the install is named for the
 * programme and its description begins with it, so a tool applies it to work
 * there and nowhere else.
 */
export function programmeSkills(env = process.env) {
  const home = programsHome(env);
  let names = [];
  try { names = readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  const out = [];
  for (const programme of names) {
    if (!SKILL_NAME.test(programme)) continue;
    const path = join(home, programme, SKILL_FILE);
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    if (!text.trim()) continue;
    const parsed = parseSkill(text);
    const body = parsed ? parsed.body : text.replace(/^---\n[\s\S]*?\n---\n?/u, '');
    const own = parsed?.description ? ` ${parsed.description}` : '';
    // Codex refuses a description over 1024 characters; one line, so either tool reads it.
    const description = `Details for work in the mc programme "${programme}" (~/mc/programs/${programme}/, its goals and the repositories it works in).${own}`
      .replace(/\s+/gu, ' ').slice(0, 1024);
    const installName = `${SKILL_PREFIX}programme-${programme}`;
    out.push({
      name: `programme-${programme}`, installName, description, path, source: 'programme', programme,
      files: { [SKILL_FILE]: renderSkill({ name: installName, description, rest: parsed ? otherKeys(parsed.frontmatter) : [], note: `~/mc/programs/${programme}/${SKILL_FILE}`, body }) },
    });
  }
  return out;
}

export function wantedSkills(env = process.env, { canonDir } = {}) {
  return [...canonSkills({ dir: canonDir }).filter((s) => !s.invalid), ...programmeSkills(env)];
}

function installedFiles(dir) {
  try { return lstatSync(dir).isDirectory() ? filesUnder(dir) : null; } catch { return null; }
}

function sameFiles(a, b) {
  if (!a) return false;
  const keys = Object.keys(b);
  return Object.keys(a).length === keys.length && keys.every((key) => a[key] === b[key]);
}

/**
 * What each target holds against what is wanted, entry by entry:
 * `ok`, `missing`, `drift` (installed, but not what the source renders) and
 * `stale` (an `mc-*` entry no source ships). Read only.
 */
export function skillStatus(env = process.env, { canonDir } = {}) {
  const wanted = wantedSkills(env, { canonDir });
  const rows = [];
  for (const target of skillTargets(env)) {
    for (const skill of wanted) {
      const have = installedFiles(join(target.dir, skill.installName));
      const state = have === null ? 'missing' : sameFiles(have, skill.files) ? 'ok' : 'drift';
      rows.push({ tool: target.tool, dir: target.dir, name: skill.installName, source: skill.source, state });
    }
    let present = [];
    try { present = readdirSync(target.dir); } catch { present = []; }
    for (const entry of present.sort()) {
      if (!entry.startsWith(SKILL_PREFIX) || wanted.some((s) => s.installName === entry)) continue;
      rows.push({ tool: target.tool, dir: target.dir, name: entry, source: null, state: 'stale' });
    }
  }
  const invalid = canonSkills({ dir: canonDir }).filter((s) => s.invalid).map((s) => s.invalid);
  return { rows, invalid };
}

/**
 * Make every target's `mc-*` entries what the sources hold. Returns the rows
 * that were not `ok` before, each with what was done to it. A target directory
 * that does not exist is created — the tool reads it once it is there.
 */
export function syncSkills(env = process.env, { canonDir } = {}) {
  const wanted = new Map(wantedSkills(env, { canonDir }).map((s) => [s.installName, s]));
  const { rows } = skillStatus(env, { canonDir });
  const changed = [];
  for (const row of rows) {
    if (row.state === 'ok') continue;
    const at = join(row.dir, row.name);
    if (!row.name.startsWith(SKILL_PREFIX)) continue; // never, but the line is the guarantee
    if (row.state === 'stale') {
      rmSync(at, { recursive: true, force: true });
      changed.push({ ...row, did: 'removed' });
      continue;
    }
    if (existsSync(at) || isLink(at)) rmSync(at, { recursive: true, force: true });
    for (const [file, content] of Object.entries(wanted.get(row.name).files)) {
      const path = join(at, ...file.split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content, 'utf8');
    }
    changed.push({ ...row, did: row.state === 'missing' ? 'installed' : 'rewritten' });
  }
  return changed;
}

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** `~/…` for a path in the home, so a pointer reads the same on every machine. */
function tilde(path, env) {
  const home = homeOf(env);
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * A role line `@skill <name>`, resolved: a pointer to the installed skill,
 * not its text. The role names the skill so it is not repeated; the session is
 * told it exists, what it covers and where it is, and the tool loads it as it
 * loads any skill. A name canon does not ship is left standing, as `@include`
 * leaves an unknown file: a broken pointer somebody can see.
 */
const ROLE_SKILL = /^@skill[ \t]+([a-z0-9][a-z0-9-]*)[ \t]*$/gmu;

export function expandRoleSkills(text, { tool = 'claude', env = process.env, canonDir } = {}) {
  if (typeof text !== 'string' || !text.includes('@skill')) return text;
  const known = new Map(canonSkills({ dir: canonDir }).filter((s) => !s.invalid).map((s) => [s.name, s]));
  const target = skillTargets(env).find((t) => t.tool === tool) || skillTargets(env)[0];
  return text.replace(ROLE_SKILL, (line, name) => {
    const skill = known.get(name);
    if (!skill) return line;
    return `Skill \`${skill.installName}\` (${tilde(join(target.dir, skill.installName, SKILL_FILE), env)}): ${skill.description} Read it when it applies; it is not repeated here.`;
  });
}
