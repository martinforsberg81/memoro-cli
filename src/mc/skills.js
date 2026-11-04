/**
 * One discoverable mc skill; roles, verbs, tasks and programmes are references.
 * Only SKILL.md at the bundle root is a skill entrypoint. Sync stages a complete
 * replacement before removing marked legacy mc-* installs, so a bad source or
 * failed write cannot retire the working guidance first.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { canonRoot } from './canon.js';
import { programsHome } from './paths.js';

export const SKILL_PREFIX = 'mc-'; // Legacy installs, recognised by their source marker too.
export const SKILL_FILE = 'SKILL.md';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const MARKER = '<!-- Installed by mc from ';

export function canonSkillsDir() {
  return join(canonRoot(), 'tasks');
}

function homeOf(env) {
  return env.HOME || homedir();
}

export function skillTargets(env = process.env) {
  const home = homeOf(env);
  return [
    { tool: 'claude', dir: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills') },
    { tool: 'codex', dir: join(home, '.agents', 'skills') },
  ];
}

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

function marked(text, source) {
  return `${MARKER}${source}. mc rewrites this file; change the source. -->\n${text}`;
}

function filesUnder(dir) {
  const out = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(dir, path).split(sep).join('/')] = readFileSync(path, 'utf8');
      else throw new Error(`mc skill resource must be a regular file or directory: ${path}`);
    }
  };
  walk(dir);
  return out;
}

/** Task metadata stays internal; these files are never separate skill installs. */
export function canonSkills({ dir = canonSkillsDir() } = {}) {
  return readdirSync(dir).filter((name) => name.endsWith('.md')).sort().map((file) => {
    const name = file.slice(0, -3);
    const path = join(dir, file);
    const parsed = parseSkill(readFileSync(path, 'utf8'));
    if (!parsed || parsed.name !== name || !SKILL_NAME.test(name)) {
      return { name, path, invalid: `tasks/${file} has no matching name or description` };
    }
    return { name, path, description: parsed.description, source: 'canon' };
  });
}

/** A programme is a reference, never another globally advertised skill. */
export function programmeSkills(env = process.env) {
  const home = programsHome(env);
  if (!existsSync(home)) return [];
  return readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory() && SKILL_NAME.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name)).flatMap(({ name }) => {
      const path = join(home, name, SKILL_FILE);
      if (!existsSync(path)) return [];
      const text = readFileSync(path, 'utf8');
      if (!text.trim()) return [];
      return [{ name, path, text: parseSkill(text)?.body || text, source: 'programme' }];
    });
}

/** Build and validate everything before inspecting or mutating any install. */
export function wantedSkills(env = process.env, { root = canonRoot() } = {}) {
  const files = filesUnder(root);
  const entry = parseSkill(files[SKILL_FILE]);
  if (entry?.name !== 'mc') throw new Error('canon/SKILL.md must name mc and have a description');
  for (const path of Object.keys(files)) {
    if (path !== SKILL_FILE && path.split('/').at(-1) === SKILL_FILE) {
      throw new Error(`nested skill entrypoint would add global context: ${path}`);
    }
  }
  const invalid = canonSkills({ dir: join(root, 'tasks') }).filter((s) => s.invalid);
  if (invalid.length) throw new Error(invalid.map((s) => s.invalid).join('; '));
  // Retain valid frontmatter at the root, and mark mc's ownership after it.
  files[SKILL_FILE] = `---\n${entry.frontmatter}\n---\n${marked(entry.body, 'canon/SKILL.md')}`;
  for (const programme of programmeSkills(env)) {
    files[`programmes/${programme.name}.md`] = marked(programme.text, `~/mc/programs/${programme.name}/SKILL.md`);
  }
  return [{ name: 'mc', installName: 'mc', source: 'canon', files }];
}

function installedFiles(dir) {
  try { return lstatSync(dir).isDirectory() ? filesUnder(dir) : null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameFiles(a, b) {
  return a && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((key) => a[key] === b[key]);
}

function owned(dir) {
  // Never follow a symlink to decide to remove somebody else's directory.
  if (!lstatSync(dir).isDirectory()) return false;
  try { return readFileSync(join(dir, SKILL_FILE), 'utf8').includes(MARKER); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function statusFor(env, wanted) {
  const rows = [];
  for (const target of skillTargets(env)) {
    const at = join(target.dir, 'mc');
    const have = installedFiles(at);
    rows.push({ tool: target.tool, dir: target.dir, name: 'mc', source: 'canon',
      state: have === null ? 'missing' : sameFiles(have, wanted.files) ? 'ok' : 'drift' });
    if (!existsSync(target.dir)) continue;
    for (const entry of readdirSync(target.dir).sort()) {
      if (entry.startsWith(SKILL_PREFIX) && owned(join(target.dir, entry))) {
        rows.push({ tool: target.tool, dir: target.dir, name: entry, source: null, state: 'stale' });
      }
    }
  }
  return { rows, invalid: [] };
}

export function skillStatus(env = process.env, options = {}) {
  try { return statusFor(env, wantedSkills(env, options)[0]); }
  catch (error) { return { rows: [], invalid: [error.message] }; }
}

function replaceBundle(at, files) {
  if (lstatSync(at, { throwIfNoEntry: false }) && !owned(at)) throw new Error(`refusing to replace an unowned mc skill: ${at}`);
  mkdirSync(join(at, '..'), { recursive: true });
  // Staging is outside skills/, so even recursive skill discovery sees no
  // temporary entrypoint or backup. Rename only after all writes succeeded.
  const staging = mkdtempSync(join(at, '..', '..', '.mc-skills-'));
  const next = join(staging, 'next');
  const previous = join(staging, 'previous');
  try {
    for (const [file, text] of Object.entries(files)) {
      const path = join(next, ...file.split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text, 'utf8');
    }
    if (existsSync(at)) renameSync(at, previous);
    try { renameSync(next, at); }
    catch (error) {
      if (existsSync(previous)) renameSync(previous, at);
      throw error;
    }
  } finally {
    // If restoring the previous bundle itself failed, retain the backup.
    if (!existsSync(previous) || existsSync(at)) rmSync(staging, { recursive: true, force: true });
  }
}

export function syncSkills(env = process.env, options = {}) {
  const wanted = wantedSkills(env, options)[0]; // Invalid source leaves all installs intact.
  const { rows } = statusFor(env, wanted);
  const changed = [];
  for (const target of skillTargets(env)) {
    const mine = rows.filter((row) => row.tool === target.tool);
    const bundle = mine.find((row) => row.name === 'mc');
    if (bundle.state !== 'ok') {
      replaceBundle(join(target.dir, 'mc'), wanted.files);
      changed.push({ ...bundle, did: bundle.state === 'missing' ? 'installed' : 'rewritten' });
    }
    // Replacement is complete before any legacy guidance is removed.
    for (const row of mine.filter((row) => row.state === 'stale')) {
      const at = join(row.dir, row.name);
      if (!owned(at)) continue;
      rmSync(at, { recursive: true, force: true });
      changed.push({ ...row, did: 'removed' });
    }
  }
  return changed;
}

/** A pointer to a reference under the one mc entrypoint, for the tool's home. */
export function mcSkillPath(tool = 'claude', resource = SKILL_FILE, env = process.env) {
  const target = skillTargets(env).find((t) => t.tool === tool) || skillTargets(env)[0];
  const path = join(target.dir, 'mc', resource);
  const home = homeOf(env);
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
