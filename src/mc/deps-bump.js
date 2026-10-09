/**
 * `mc deps bump <repo> security|minor|<package>[@<version>]` — one group of
 * the reading (`deps.js`) turned into a pull request through the gate
 * (ruling 29).
 *
 * The order is the whole design: a fresh reading of `origin/main`, the
 * changes it names, a fresh workarea on `origin/main`, npm in that checkout
 * with `--package-lock-only` on every call, one commit of the two files, then
 * `mc publish` and `mc merge <repo> <pr>`. Nothing installs a `node_modules`
 * — memoro's workareas hold `package-links` attachments into an immutable
 * shared cache, and an install there would write through them — and nothing
 * lands but through the gate.
 *
 * A group never crosses a major; only a named `<package>@<version>` may, and
 * the gate decides whether it lands. Every outside call is injectable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compareVersions, defaultGit, defaultNpm, directDependencies, majorLine, readDeps } from './deps.js';
import { workAreaPath } from './paths.js';
import { addWorktree as defaultAddWorktree } from './work-area.js';

const SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const LOCK_ONLY = ['--package-lock-only', '--ignore-scripts'];
const WRITTEN = ['package.json', 'package-lock.json'];
/** Names the commit subject spells out before `and <n> more`. */
const SUBJECT_NAMES = 5;

/**
 * `security`, `minor`, `major`, or a package with an optional version, split
 * on the last `@` that is not the first character (`@capacitor/ios@8.5.3`).
 */
export function parseWhat(what) {
  const text = String(what || '').trim();
  if (text === 'security' || text === 'minor' || text === 'major') return { group: text };
  const at = text.lastIndexOf('@');
  if (at > 0) return { name: text.slice(0, at), version: text.slice(at + 1) || null };
  return { name: text, version: null };
}

/** `deps-<repo>-<what>-<yyyymmdd>`, `/` and `@` in `<what>` turned into `-`. */
export function workareaName(repo, what, date) {
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `deps-${repo}-${String(what).replace(/[/@]/gu, '-')}-${day}`;
}

/** The operator a spec carries: `''` for an exact pin, `^` or `~`, else null. */
export function specOperator(spec) {
  const text = String(spec || '').trim();
  if (/^\d/u.test(text)) return '';
  if (/^[\^~]\d/u.test(text)) return text[0];
  return null;
}

/** Every section of the manifest the name stands in. */
export function sectionsOf(manifest, name) {
  return SECTIONS.filter((section) => manifest?.[section]?.[name] != null);
}

function change(manifest, name, from, to, kind) {
  const spec = String(directDependencies(manifest).get(name)?.spec ?? '');
  return { name, from, to, kind, op: specOperator(spec), spec, sections: sectionsOf(manifest, name) };
}

function newer(a, b) {
  return a != null && b != null && compareVersions(a, b) > 0;
}

/**
 * What a bump would write, from the reading and `origin/main`'s manifest and
 * lockfile. Returns `{ changes, transitive }` or `{ refusal }`; empty
 * changes with no transitive work is "nothing to change".
 */
export function planChanges({ what, reading, manifest, lock }) {
  const parsed = parseWhat(what);
  const groups = reading?.groups || {};
  let changes = [];
  let transitive = 0;
  if (parsed.group === 'major') {
    return { refusal: `a major goes one package at a time — mc deps bump ${reading?.repo || '<repo>'} <package>@<version>` };
  }
  if (parsed.group) {
    for (const row of groups[parsed.group] || []) {
      // A group never crosses a major, whatever a row says.
      if (!newer(row.target, row.installed) || majorLine(row.target) !== majorLine(row.installed)) continue;
      changes.push(change(manifest, row.name, row.installed, row.target, row.kind));
    }
    if (parsed.group === 'security') {
      transitive = reading?.audit?.transitive_fixable || 0;
      // A security row with no direct change of its own is fixed by the
      // transitive pass, so the pass still runs.
      if (!changes.length && !transitive && !(groups.security || []).length) return { changes, transitive: null };
      return { changes, transitive };
    }
    return { changes, transitive: null };
  }

  const { name, version } = parsed;
  const direct = directDependencies(manifest).get(name);
  if (!name || !direct) return { refusal: `${name || '(nothing)'} is not a direct dependency of ${reading?.repo || 'this repository'}'s origin/main package.json` };
  const installed = lock?.packages?.[`node_modules/${name}`]?.version ?? null;
  if (!installed) return { refusal: `${name} is not in origin/main's package-lock.json` };
  let to = version;
  if (!to) {
    const rows = [...(groups.security || []), ...(groups.minor || []), ...(groups.major || [])];
    const unread = (reading?.unread || []).find((row) => row.name === name);
    if (unread) return { refusal: `${name} was not read (${unread.error}) — name the version` };
    const row = rows.find((candidate) => candidate.name === name);
    if (!row || !newer(row.in_major, installed)) {
      return { refusal: `${name} ${installed} is the newest ${majorLine(installed)}.x — name the version to cross the major` };
    }
    to = row.in_major;
  }
  if (to === installed) return { changes: [], transitive: null };
  changes = [change(manifest, name, installed, to, direct.kind)];
  return { changes, transitive: null };
}

function changeText(item) {
  return `${item.name} ${item.from} → ${item.to}`;
}

function countsText(counts = {}) {
  return ['critical', 'high', 'moderate', 'low'].map((severity) => `${counts[severity] || 0} ${severity}`).join(', ');
}

/** `deps(<repo>): <what> — <name> <from> → <to>, …` and a body with every change. */
export function commitMessage({ repo, what, changes, transitive, reading }) {
  const shown = changes.slice(0, SUBJECT_NAMES).map(changeText).join(', ');
  const more = changes.length > SUBJECT_NAMES ? ` and ${changes.length - SUBJECT_NAMES} more` : '';
  const title = `deps(${repo}): ${what} — ${changes.length ? `${shown}${more}` : 'npm audit fix'}`;
  const body = [
    `mc deps bump ${repo} ${what}, on origin/main ${String(reading?.sha || '').slice(0, 7)}.`,
    '',
    ...changes.map((item) => `- ${changeText(item)} (${item.kind})`),
    ...(transitive != null ? [`- npm audit fix --package-lock-only for the transitive rest (${transitive} fixable within ranges)`] : []),
    '',
    `Audit before: ${countsText(reading?.audit?.counts)}.`,
    '',
    'Written by npm with --package-lock-only --ignore-scripts; only package.json and package-lock.json changed.',
  ];
  return { title, body: body.join('\n') };
}

function tilde(path) {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || null;
}

function collector() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

/**
 * The bump, end to end. Returns the exit code: a refusal is 1, nothing to
 * change is 0, otherwise `mc merge`'s own.
 */
export async function bump({
  repo, repoPath, what, dryRun = false, json = false,
  env = process.env, now = () => new Date(), stdout = process.stdout, stderr = process.stderr,
  git = defaultGit, npm = defaultNpm,
  reading: readFresh = null,
  addWorktree = defaultAddWorktree,
  publish = null, merge = null,
} = {}) {
  const say = (line) => stderr.write(`mc: ${line}\n`);
  const parsed = parseWhat(what);
  if (parsed.group === 'major') {
    say(`a major goes one package at a time — mc deps bump ${repo} <package>@<version>`);
    return 1;
  }

  await git(['fetch', 'origin', 'main', '--quiet'], { cwd: repoPath });
  const manifestText = await git(['show', 'origin/main:package.json'], { cwd: repoPath });
  const lockText = await git(['show', 'origin/main:package-lock.json'], { cwd: repoPath });
  if (manifestText.status !== 0 || lockText.status !== 0) { say(`${repo} has no package.json and package-lock.json on origin/main`); return 1; }
  const manifest = JSON.parse(manifestText.stdout);
  const lock = JSON.parse(lockText.stdout);
  if (parsed.name && !directDependencies(manifest).has(parsed.name)) {
    say(`${parsed.name} is not a direct dependency of ${repo}'s origin/main package.json`);
    return 1;
  }

  // A bump is built on the lockfile it changes, so the reading is always new.
  let reading;
  try {
    reading = readFresh
      ? await readFresh({ repoPath, repo, env })
      : (await readDeps({ repoPath, repo, refresh: true, env, git, npm, now })).reading;
  } catch (error) { say(error.message); return 1; }

  const planned = planChanges({ what, reading, manifest, lock });
  if (planned.refusal) { say(planned.refusal); return 1; }
  const { changes, transitive } = planned;
  const unwritable = changes.filter((item) => item.op == null);
  if (unwritable.length) {
    say(`mc keeps the operator a spec has, and these are neither a pin nor ^/~: ${unwritable.map((item) => `${item.name} "${item.spec}"`).join(', ')}`);
    return 1;
  }

  const name = workareaName(repo, what, now());
  const area = workAreaPath(name, env);
  const checkout = join(area, repo);
  const result = { repo, what, changes, workarea: area, branch: name, pr: null, merged: null };
  const done = (code) => { if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`); return code; };

  if (!changes.length && transitive == null) {
    if (!json) stdout.write(`mc deps bump ${repo} ${what} — nothing to change on origin/main ${String(reading.sha).slice(0, 7)}\n`);
    return done(0);
  }

  const out = json ? stderr : stdout;
  out.write(`mc deps bump ${repo} ${what} — origin/main ${String(reading.sha).slice(0, 7)}, `
    + `${changes.length} change${changes.length === 1 ? '' : 's'}; audit before: ${countsText(reading.audit?.counts)}\n`);
  for (const item of changes) out.write(`  ${changeText(item)} (${item.kind})\n`);
  if (transitive != null) out.write(`  transitive: ${transitive} by npm audit fix\n`);

  if (existsSync(area)) { say(`${tilde(area)} already exists — ${area}`); return 1; }
  if (dryRun) {
    out.write(`would make ${tilde(area)} on origin/main and open a pull request\n`);
    return done(0);
  }

  const made = addWorktree({ name, repo: repoPath, branch: name, from: 'origin/main', env });
  if (!made?.ok) { say(`could not make ${tilde(area)} (${made?.reason || 'git worktree add failed'}) — ${made?.path || checkout}`); return 1; }
  const cwd = made.path || checkout;

  const exact = changes.filter((item) => item.op === '');
  const ranged = changes.filter((item) => item.op !== '');
  const calls = [];
  if (exact.length) calls.push(['install', ...LOCK_ONLY, '--save-exact', ...exact.map((item) => `${item.name}@${item.to}`)]);
  if (ranged.length) calls.push(['install', ...LOCK_ONLY, ...ranged.map((item) => `${item.name}@${item.op}${item.to}`)]);
  for (const args of calls) {
    const ran = await npm(args, { cwd });
    if (ran.status !== 0) {
      say(`npm ${args.join(' ')} failed: ${firstLine(ran.stderr) || firstLine(ran.stdout) || `exit ${ran.status}`} — nothing committed; ${tilde(area)} stays`);
      return 1;
    }
  }
  if (transitive != null) {
    // npm audit fix exits non-zero while anything is left that it cannot fix
    // within ranges; what it changed is read off git below either way.
    const fixed = await npm(['audit', 'fix', ...LOCK_ONLY], { cwd });
    if (fixed.status !== 0) say(`npm audit fix exited ${fixed.status} — ${firstLine(fixed.stderr) || 'some advisories have no fix within ranges'}`);
  }

  let after = null;
  try { after = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')); } catch (error) {
    say(`package.json in ${tilde(cwd)} is not readable after npm (${error.message}) — nothing committed`);
    return 1;
  }
  const moved = changes.filter((item) => sectionsOf(after, item.name).join() !== item.sections.join());
  const status = await git(['status', '--porcelain'], { cwd });
  const dirty = String(status.stdout || '').split('\n').filter(Boolean).map((line) => line.slice(3));
  const stray = dirty.filter((path) => !WRITTEN.includes(path));
  if (moved.length || stray.length) {
    say(`npm changed more than ${WRITTEN.join(' and ')} — stopped before the commit; ${tilde(area)} stays:`);
    for (const item of moved) stderr.write(`  ${item.name}: ${item.sections.join(', ')} → ${sectionsOf(after, item.name).join(', ') || 'gone'}\n`);
    for (const path of stray) stderr.write(`  ${path}\n`);
    return 1;
  }
  if (!dirty.length) {
    out.write(`npm changed nothing — nothing to commit; mc work discard ${name} --apply removes ${tilde(area)}\n`);
    return done(0);
  }

  const message = commitMessage({ repo, what, changes, transitive, reading });
  const added = await git(['add', '--', ...WRITTEN], { cwd });
  const committed = added.status === 0
    ? await git(['commit', '-m', message.title, '-m', message.body, '--', ...WRITTEN], { cwd })
    : added;
  if (committed.status !== 0) { say(`git commit failed: ${firstLine(committed.stderr) || `exit ${committed.status}`} — ${tilde(area)} stays`); return 1; }

  const published = collector();
  const publishRun = publish || (await import('./commands/publish.js')).run;
  const publishCode = await publishRun(['--json'], { cwd, stdout: published, stderr });
  let number = null;
  try { number = JSON.parse(published.text).number ?? null; } catch { number = null; }
  if (publishCode !== 0 || number == null) {
    say(`mc publish did not open the pull request — the commit is on ${name} in ${tilde(cwd)}`);
    return publishCode || 1;
  }
  result.pr = number;
  out.write(`opened #${number} from ${name}; mc merge ${repo} ${number}\n`);

  const mergeRun = merge || (await import('./commands/merge.js')).run;
  const code = await mergeRun([repo, String(number)], { stdout: out, stderr });
  result.merged = code === 0;
  if (code !== 0) {
    say(`#${number} did not land — the pull request stays open and ${tilde(area)} stays; `
      + `mc merge ${repo} ${number} again after a fix, and mc work tidy removes the area once it has landed or closed`);
  }
  return done(code);
}
